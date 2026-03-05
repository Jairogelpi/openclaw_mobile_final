import postgres from 'postgres';
import dotenv from 'dotenv';
dotenv.config();

const connectionString = process.env.DATABASE_URL || process.env.SUPABASE_DB_URL;
const sql = postgres(connectionString);

async function patch() {
    try {
        await sql`
            ALTER TABLE public.contact_personas ADD COLUMN IF NOT EXISTS display_name TEXT;
        `;
        await sql`NOTIFY pgrst, 'reload schema'`;
        console.log("✅ display_name column added to contact_personas.");
    } catch (e) {
        console.error("❌ Error applying patch:", e);
    } finally {
        await sql.end();
    }
}
patch();
