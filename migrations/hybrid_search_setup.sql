-- ====================================================================
-- OPENCLAW RAG HÍBRIDO (BM25 + pgvector con RRF)
-- Ejecutar en el SQL Editor de Supabase
-- ====================================================================

-- 1. Añadir columna generada para Búsqueda de Texto Completo (BM25)
ALTER TABLE public.user_memories 
ADD COLUMN IF NOT EXISTS fts tsvector 
GENERATED ALWAYS AS (to_tsvector('spanish', content || ' ' || COALESCE(sender, ''))) STORED;

-- 2. Crear Índice GIN para búsquedas de texto instantáneas
CREATE INDEX IF NOT EXISTS idx_user_memories_fts 
ON public.user_memories USING GIN (fts);

-- 3. Crear la Función Híbrida con Reciprocal Rank Fusion (RRF)
DROP FUNCTION IF EXISTS public.hybrid_search_memories;

/**
 * hybrid_search_memories
 * Combina pgvector (semántica) + BM25 (léxica exacta) mediante RRF
 * @param query_text El texto crudo escrito por el usuario
 * @param query_embedding El vector (768D) generado para la query
 * @param match_count Cuántos resultados combinados devolver en total
 * @param p_client_id El cliente al que le pertenece la memoria
 */
CREATE OR REPLACE FUNCTION hybrid_search_memories (
  query_text text,
  query_embedding vector(768),
  match_count int,
  p_client_id text
)
RETURNS TABLE (
  id uuid,
  content text,
  sender text,
  date text,
  similarity float -- Score combinado RRF
)
LANGUAGE plpgsql
AS $$
DECLARE
  -- RRF Constants (k=60 es el estándar en bases de datos analíticas)
  rrf_k CONSTANT int := 60;
  
  -- Generamos la query de texto para TS_VECTOR (ej: "envío" & "retrasado")
  -- Usamos plainto_tsquery para no obligar al usuario a usar sintaxis booleana
  fts_query tsquery := plainto_tsquery('spanish', query_text);
BEGIN
  RETURN QUERY
  WITH 
  -- A. Búsqueda Vectorial Pura (Dense)
  vector_search AS (
    SELECT 
      m.id,
      m.content,
      m.sender,
      (m.metadata->>'date')::text as date,
      (1 - (m.embedding <=> query_embedding)) as vector_score,
      RANK() OVER (ORDER BY m.embedding <=> query_embedding) as vector_rank
    FROM user_memories m
    WHERE m.client_id = p_client_id
    -- Solo procesamos los top 50 vectores para mantener la latencia ultrabaja
    LIMIT 50
  ),
  
  -- B. Búsqueda de Texto Pura (Sparse / BM25)
  keyword_search AS (
    SELECT 
      m.id,
      m.content,
      m.sender,
      (m.metadata->>'date')::text as date,
      ts_rank(m.fts, fts_query) as keyword_score,
      RANK() OVER (ORDER BY ts_rank(m.fts, fts_query) DESC) as keyword_rank
    FROM user_memories m
    WHERE m.client_id = p_client_id 
      AND m.fts @@ fts_query
      AND length(query_text) > 2 -- Evitar búsquedas de keywords vacías
    LIMIT 50
  ),
  
  -- C. Combinación de ambos mundos vía Outer Join
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
  
  -- D. Aplicación Matemática Final (Reciprocal Rank Fusion)
  SELECT
    c.shared_id as id,
    c.shared_content as content,
    c.shared_sender as sender,
    c.shared_date as date,
    -- RRF Formula: COALESCE evita división por cero si falta un ranking
    (
      COALESCE(1.0 / (rrf_k + c.vector_rank), 0.0) +
      COALESCE(1.0 / (rrf_k + c.keyword_rank), 0.0)
    )::float as similarity
  FROM combined_results c
  ORDER BY similarity DESC
  LIMIT match_count;
END;
$$;
