import postgres from 'postgres';
import dotenv from 'dotenv';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const migrationPath = path.join(__dirname, '..', 'migrations', 'graphrag_v7_mentions_eval_and_multimodal.sql');

const dbUrl = process.env.SUPABASE_URL
    ? process.env.SUPABASE_URL.replace('https://', 'postgres://postgres:').replace('.supabase.co', ':6543/postgres') + '?password=' + process.env.DB_PASSWORD
    : null;

const connectionString = process.env.DATABASE_URL || process.env.SUPABASE_DB_URL || dbUrl;

if (!connectionString) {
    throw new Error('DATABASE_URL/SUPABASE_DB_URL no configurado.');
}

const sql = postgres(connectionString, { max: 1 });

async function main() {
    const migrationSql = await fs.readFile(migrationPath, 'utf8');
    try {
        await sql.unsafe(migrationSql);
        await sql`NOTIFY pgrst, 'reload schema'`;
        console.log('GraphRAG v7 migration applied successfully.');
    } finally {
        await sql.end();
    }
}

main().catch(error => {
    console.error('Failed to apply GraphRAG v7 migration:', error);
    process.exit(1);
});
