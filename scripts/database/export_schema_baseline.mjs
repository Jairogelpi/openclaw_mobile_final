import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import postgres from 'postgres';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..', '..');
const outputPath = path.join(projectRoot, 'migrations', 'prod_schema_baseline.md');
const connectionString = process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.SUPABASE_DB_URL;

if (!connectionString) {
    console.error('Falta DATABASE_URL/POSTGRES_URL/SUPABASE_DB_URL en el entorno.');
    process.exit(1);
}

const sql = postgres(connectionString, {
    ssl: 'require',
    max: 1,
    idle_timeout: 5,
    connect_timeout: 10
});

function escapeMd(value) {
    return String(value ?? '')
        .replace(/\|/g, '\\|')
        .replace(/\n/g, ' ')
        .trim();
}

async function loadTables() {
    return sql`
        select
            c.relname as table_name,
            coalesce(s.n_live_tup::bigint, 0) as row_estimate
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        left join pg_stat_user_tables s on s.relid = c.oid
        where n.nspname = 'public'
          and c.relkind = 'r'
        order by c.relname
    `;
}

async function loadColumns(tableName) {
    return sql`
        select
            ordinal_position,
            column_name,
            data_type,
            udt_name,
            is_nullable,
            column_default
        from information_schema.columns
        where table_schema = 'public'
          and table_name = ${tableName}
        order by ordinal_position
    `;
}

async function loadConstraints(tableName) {
    return sql`
        select
            con.conname as constraint_name,
            pg_get_constraintdef(con.oid) as definition
        from pg_constraint con
        join pg_class rel on rel.oid = con.conrelid
        join pg_namespace nsp on nsp.oid = rel.relnamespace
        where nsp.nspname = 'public'
          and rel.relname = ${tableName}
        order by con.conname
    `;
}

async function loadIndexes(tableName) {
    return sql`
        select indexname, indexdef
        from pg_indexes
        where schemaname = 'public'
          and tablename = ${tableName}
        order by indexname
    `;
}

async function main() {
    const url = new URL(connectionString);
    const tables = await loadTables();
    const lines = [
        '# Production Schema Baseline',
        '',
        `Generated at: ${new Date().toISOString()}`,
        `Database host: ${url.hostname}`,
        `Database name: ${url.pathname.replace(/^\//, '') || 'postgres'}`,
        `Schema: public`,
        '',
        '## Tables',
        ''
    ];

    for (const table of tables) {
        lines.push(`- ${table.table_name} (row_estimate=${table.row_estimate})`);
    }

    for (const table of tables) {
        const [columns, constraints, indexes] = await Promise.all([
            loadColumns(table.table_name),
            loadConstraints(table.table_name),
            loadIndexes(table.table_name)
        ]);

        lines.push('');
        lines.push(`## ${table.table_name}`);
        lines.push('');
        lines.push(`Estimated rows: ${table.row_estimate}`);
        lines.push('');
        lines.push('| # | Column | Type | Nullable | Default |');
        lines.push('| --- | --- | --- | --- | --- |');

        for (const column of columns) {
            const typeLabel = column.data_type === 'USER-DEFINED'
                ? column.udt_name
                : column.data_type;
            lines.push(
                `| ${column.ordinal_position} | ${escapeMd(column.column_name)} | ${escapeMd(typeLabel)} | ${escapeMd(column.is_nullable)} | ${escapeMd(column.column_default || '')} |`
            );
        }

        lines.push('');
        lines.push('Constraints:');
        if (constraints.length === 0) {
            lines.push('- none');
        } else {
            for (const constraint of constraints) {
                lines.push(`- ${escapeMd(constraint.constraint_name)}: ${escapeMd(constraint.definition)}`);
            }
        }

        lines.push('');
        lines.push('Indexes:');
        if (indexes.length === 0) {
            lines.push('- none');
        } else {
            for (const index of indexes) {
                lines.push(`- ${escapeMd(index.indexname)}: ${escapeMd(index.indexdef)}`);
            }
        }
    }

    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, `${lines.join('\n')}\n`, 'utf8');
    console.log(`Schema baseline exportado a ${outputPath}`);
}

main()
    .catch(error => {
        console.error(`FAIL schema baseline: ${error.message}`);
        process.exitCode = 1;
    })
    .finally(async () => {
        await sql.end({ timeout: 5 });
    });
