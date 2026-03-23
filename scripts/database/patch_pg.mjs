import postgres from 'postgres';
import dotenv from 'dotenv';
dotenv.config();

// Extraemos la URL de la BD directamente:
const dbUrl = process.env.SUPABASE_URL.replace('https://', 'postgres://postgres:').replace('.supabase.co', ':6543/postgres') + '?password=' + process.env.DB_PASSWORD;
// o si hay una DATABASE_URL directa en el .env:
const connectionString = process.env.DATABASE_URL || process.env.SUPABASE_DB_URL;

if (!connectionString) {
    console.error("No DATABASE_URL found.");
    process.exit(1);
}

const sql = postgres(connectionString);

async function patch() {
    try {
        await sql`
CREATE OR REPLACE FUNCTION public.hybrid_search_memories(
    query_text text,
    query_embedding vector(768),
    match_count integer,
    p_client_id uuid
)
RETURNS TABLE(id uuid, content text, sender text, date text, similarity double precision)
LANGUAGE plpgsql
AS $function$
DECLARE
  rrf_k CONSTANT int := 60;
  fts_query tsquery := plainto_tsquery('spanish', query_text);
BEGIN
  RETURN QUERY
  WITH 
  vector_search AS (
    SELECT 
      m.id,
      m.content,
      m.sender,
      (m.metadata->>'date')::text as date,
      RANK() OVER (ORDER BY m.embedding <=> query_embedding) as vector_rank
    FROM user_memories m
    WHERE m.client_id = p_client_id
      AND m.embedding IS NOT NULL
    LIMIT 50
  ),
  keyword_search AS (
    SELECT 
      m.id,
      m.content,
      m.sender,
      (m.metadata->>'date')::text as date,
      RANK() OVER (ORDER BY ts_rank(m.fts, fts_query) DESC) as keyword_rank
    FROM user_memories m
    WHERE m.client_id = p_client_id 
      AND m.fts @@ fts_query
      AND length(query_text) > 2
    LIMIT 50
  ),
  combined_results AS (
    SELECT
      COALESCE(v.id, k.id) as shared_id,
      COALESCE(v.content, k.content) as shared_content,
      COALESCE(v.sender, k.sender) as shared_sender,
      COALESCE(v.date, k.date) as shared_date,
      v.vector_rank,
      k.keyword_rank
    FROM vector_search v
    FULL OUTER JOIN keyword_search k ON v.id = k.id
  )
  SELECT
    c.shared_id as id,
    c.shared_content as content,
    c.shared_sender as sender,
    c.shared_date as date,
    (
      COALESCE(1.0 / (rrf_k + c.vector_rank), 0.0) +
      COALESCE(1.0 / (rrf_k + c.keyword_rank), 0.0)
    )::float as similarity
  FROM combined_results c
  ORDER BY similarity DESC
  LIMIT match_count;
END;
$function$;
        `;
        console.log("✅ Función parcheada con éxito (p_client_id cambiado a uuid).");
    } catch (e) {
        console.error("❌ Error aplicando parche:", e);
    } finally {
        await sql.end();
    }
}
patch();
