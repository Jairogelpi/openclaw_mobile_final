import postgres from 'postgres';
import dotenv from 'dotenv';
dotenv.config();

const dbUrl = process.env.SUPABASE_URL.replace('https://', 'postgres://postgres:').replace('.supabase.co', ':6543/postgres') + '?password=' + process.env.DB_PASSWORD;
const connectionString = process.env.DATABASE_URL || process.env.SUPABASE_DB_URL;
const sql = postgres(connectionString);

async function rebuild() {
    try {
        console.log("🧹 Borrando memorias anteriores (vectoriales y grafo)...");
        await sql`TRUNCATE TABLE user_memories CASCADE`;
        await sql`TRUNCATE TABLE knowledge_nodes CASCADE`;
        await sql`TRUNCATE TABLE knowledge_edges CASCADE`;
        await sql`TRUNCATE TABLE user_souls CASCADE`;

        console.log("🔄 Marcando todos los raw_messages como no procesados...");
        const result = await sql`UPDATE raw_messages SET processed = false`;
        console.log(`✅ ${result.count} mensajes reseteados para re-procesamiento.`);

    } catch(e) {
        console.error(e);
    } finally {
        await sql.end();
    }
}
rebuild();
