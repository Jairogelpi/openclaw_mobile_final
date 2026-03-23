import postgres from 'postgres';
import dotenv from 'dotenv';
dotenv.config();

const dbUrl = process.env.SUPABASE_URL.replace('https://', 'postgres://postgres:').replace('.supabase.co', ':6543/postgres') + '?password=' + process.env.DB_PASSWORD;
const connectionString = process.env.DATABASE_URL || process.env.SUPABASE_DB_URL || dbUrl;
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
  fts_query tsquery := cast(replace(plainto_tsquery('spanish', query_text)::text, '&', '|') as tsquery);
BEGIN
  RETURN QUERY
  WITH 
  vector_search AS (
    SELECT 
      m.id, m.content, m.sender, (m.metadata->>'date')::text as date,
      RANK() OVER (ORDER BY m.embedding <=> query_embedding) as vector_rank
    FROM user_memories m
    WHERE m.client_id = p_client_id AND m.embedding IS NOT NULL LIMIT 80
  ),
  keyword_search AS (
    SELECT 
      m.id, m.content, m.sender, (m.metadata->>'date')::text as date,
      RANK() OVER (ORDER BY ts_rank(m.fts, fts_query) DESC) as keyword_rank
    FROM user_memories m
    WHERE m.client_id = p_client_id AND m.fts @@ fts_query AND length(query_text) > 2 LIMIT 80
  ),
  combined_results AS (
    SELECT COALESCE(v.id, k.id) as shared_id, COALESCE(v.content, k.content) as shared_content, COALESCE(v.sender, k.sender) as shared_sender, COALESCE(v.date, k.date) as shared_date, v.vector_rank, k.keyword_rank
    FROM vector_search v FULL OUTER JOIN keyword_search k ON v.id = k.id
  )
  SELECT c.shared_id as id, c.shared_content as content, c.shared_sender as sender, c.shared_date as date,
    (COALESCE(1.0 / (rrf_k + c.vector_rank), 0.0) + COALESCE(1.0 / (rrf_k + c.keyword_rank), 0.0))::float as similarity
  FROM combined_results c ORDER BY similarity DESC LIMIT match_count;
END;
$function$;
        `;

        await sql`
CREATE OR REPLACE FUNCTION public.graphrag_traverse(query_text text, query_embedding vector, match_count integer, p_client_id uuid)
 RETURNS TABLE(knowledge text, entity_name text, entity_type text, relation text, hop integer, cognitive_resonance double precision, reasoning_path text)
 LANGUAGE plpgsql
AS $function$
DECLARE
    fts_query tsquery := cast(replace(plainto_tsquery('spanish', query_text)::text, '&', '|') as tsquery);
BEGIN
    RETURN QUERY
    WITH
    seed_nodes AS (
        SELECT 
            n.entity_name, n.entity_type, n.description,
            (COALESCE(1.0 / (60 + RANK() OVER (ORDER BY n.embedding <=> query_embedding)), 0.0) +
             CASE WHEN n.fts @@ fts_query THEN COALESCE(1.0 / (60 + RANK() OVER (ORDER BY ts_rank(n.fts, fts_query) DESC)), 0.0) ELSE 0.0 END) as rrf_score
        FROM knowledge_nodes n WHERE n.client_id = p_client_id ORDER BY rrf_score DESC LIMIT match_count
    ),
    hop1_edges AS (
        SELECT DISTINCT ON (e.source_node, e.relation_type, e.target_node)
            e.source_node, e.relation_type, e.target_node, e.context, s.rrf_score * 0.9 as resonance, s.entity_name as seed_origin
        FROM knowledge_edges e INNER JOIN seed_nodes s ON (e.source_node = s.entity_name OR e.target_node = s.entity_name) WHERE e.client_id = p_client_id
    ),
    hop1_discovered_nodes AS (SELECT DISTINCT unnest(ARRAY[source_node, target_node]) as node_name, resonance, seed_origin FROM hop1_edges),
    hop2_edges AS (
        SELECT DISTINCT ON (e.source_node, e.relation_type, e.target_node)
            e.source_node, e.relation_type, e.target_node, e.context, h.resonance * 0.75 as resonance, h.seed_origin
        FROM knowledge_edges e INNER JOIN hop1_discovered_nodes h ON (e.source_node = h.node_name OR e.target_node = h.node_name)
        WHERE e.client_id = p_client_id AND NOT EXISTS (SELECT 1 FROM hop1_edges h1 WHERE h1.source_node = e.source_node AND h1.relation_type = e.relation_type AND h1.target_node = e.target_node) LIMIT 40
    ),
    hop2_discovered_nodes AS (SELECT DISTINCT unnest(ARRAY[source_node, target_node]) as node_name, resonance, seed_origin FROM hop2_edges),
    hop3_edges AS (
        SELECT DISTINCT ON (e.source_node, e.relation_type, e.target_node)
            e.source_node, e.relation_type, e.target_node, e.context, h2.resonance * 0.5 as resonance, h2.seed_origin
        FROM knowledge_edges e INNER JOIN hop2_discovered_nodes h2 ON (e.source_node = h2.node_name OR e.target_node = h2.node_name)
        WHERE e.client_id = p_client_id AND NOT EXISTS (SELECT 1 FROM hop1_edges h1 WHERE h1.source_node = e.source_node AND h1.target_node = e.target_node)
        AND NOT EXISTS (SELECT 1 FROM hop2_edges hn2 WHERE hn2.source_node = e.source_node AND hn2.target_node = e.target_node) LIMIT 15 
    )
    SELECT ('NODO ESTÍMULO [' || s.entity_type || ']: ' || s.entity_name || ' — ' || COALESCE(s.description, ''))::text as knowledge, s.entity_name::text, s.entity_type::text, NULL::text as relation, 0 as hop, s.rrf_score::float as cognitive_resonance, ('🎯 MATCH DIRECTO: ' || s.entity_name)::text as reasoning_path FROM seed_nodes s
    UNION ALL
    SELECT (h1.source_node || ' —[' || h1.relation_type || ']→ ' || h1.target_node || COALESCE(' (' || h1.context || ')', ''))::text as knowledge, h1.source_node::text as entity_name, 'CONEXIÓN_DIRECTA'::text as entity_type, h1.relation_type::text as relation, 1 as hop, h1.resonance::float as cognitive_resonance, ('🔗 [' || h1.seed_origin || '] ➔ conectó con ➔ [' || (CASE WHEN h1.source_node = h1.seed_origin THEN h1.target_node ELSE h1.source_node END) || ']')::text as reasoning_path FROM hop1_edges h1
    UNION ALL
    SELECT (h2.source_node || ' —[' || h2.relation_type || ']→ ' || h2.target_node || COALESCE(' (' || h2.context || ')', ''))::text as knowledge, h2.source_node::text as entity_name, 'INFERENCIA_SEGUNDARIA'::text as entity_type, h2.relation_type::text as relation, 2 as hop, h2.resonance::float as cognitive_resonance, ('🧠 [' || h2.seed_origin || '] ➔ inferencia a paso 2 ➔ [' || (CASE WHEN h2.source_node = h2.seed_origin THEN h2.target_node ELSE h2.source_node END) || ']')::text as reasoning_path FROM hop2_edges h2
    UNION ALL
    SELECT (h3.source_node || ' —[' || h3.relation_type || ']→ ' || h3.target_node || COALESCE(' (' || h3.context || ')', ''))::text as knowledge, h3.source_node::text as entity_name, 'INTUICIÓN_PROFUNDA'::text as entity_type, h3.relation_type::text as relation, 3 as hop, h3.resonance::float as cognitive_resonance, ('🌌 [' || h3.seed_origin || '] ➔ red semántica profunda ➔ [' || (CASE WHEN h3.source_node = h3.seed_origin THEN h3.target_node ELSE h3.source_node END) || ']')::text as reasoning_path FROM hop3_edges h3
    ORDER BY cognitive_resonance DESC, hop ASC;
END;
$function$;
        `;

        console.log('✅ Ambas funciones de RAG han sido parcheadas con OR logic (tsquery).');
    } catch (e) {
        console.error('❌ Error applying patch', e);
    } finally {
        await sql.end();
    }
}
patch();
