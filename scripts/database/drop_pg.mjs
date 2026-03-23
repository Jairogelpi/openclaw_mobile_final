import postgres from 'postgres';
import dotenv from 'dotenv';
dotenv.config();

const dbUrl = process.env.SUPABASE_URL.replace('https://', 'postgres://postgres:').replace('.supabase.co', ':6543/postgres') + '?password=' + process.env.DB_PASSWORD;
const connectionString = process.env.DATABASE_URL || process.env.SUPABASE_DB_URL;
const sql = postgres(connectionString);

async function patch() {
    try {
        await sql`DROP FUNCTION IF EXISTS public.hybrid_search_memories(text, vector, int, text);`;
        console.log("✅ Función antigua (text) eliminada con éxito.");
    } catch (e) {
        console.error("❌ Error aplicando parche:", e);
    } finally {
        await sql.end();
    }
}
patch();
