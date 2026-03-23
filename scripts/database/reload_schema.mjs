import postgres from 'postgres';
import dotenv from 'dotenv';
dotenv.config();

const connectionString = process.env.DATABASE_URL || process.env.SUPABASE_DB_URL;
const sql = postgres(connectionString);

async function patch() {
    try {
        await sql`NOTIFY pgrst, 'reload schema'`;
        console.log("✅ PostgREST schema cache reloaded.");
    } catch (e) {
        console.error("❌ Error applying constraint:", e);
    } finally {
        await sql.end();
    }
}
patch();
