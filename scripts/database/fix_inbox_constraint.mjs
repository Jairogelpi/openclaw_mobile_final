import postgres from 'postgres';
import dotenv from 'dotenv';
dotenv.config();

const connectionString = process.env.DATABASE_URL || process.env.SUPABASE_DB_URL;
const sql = postgres(connectionString);

async function patch() {
    try {
        await sql`
            ALTER TABLE public.inbox_summaries ADD CONSTRAINT inbox_summaries_client_conversation_key UNIQUE (client_id, conversation_id);
        `;
        console.log("✅ Unique constraint added to inbox_summaries.");
    } catch (e) {
        console.error("❌ Error applying constraint:", e);
    } finally {
        await sql.end();
    }
}
patch();
