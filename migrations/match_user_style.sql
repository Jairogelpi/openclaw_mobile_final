-- ====================================================================
-- match_user_style: Búsqueda dinámica de estilo lingüístico
-- Filtra específicamente memorias donde el usuario fue el emisor.
-- ====================================================================

CREATE OR REPLACE FUNCTION public.match_user_style (
  query_text text,
  query_embedding vector(768),
  match_count int,
  p_client_id text
)
RETURNS TABLE (
  content text,
  similarity float
)
LANGUAGE plpgsql
AS $$
DECLARE
  rrf_k CONSTANT int := 60;
  fts_query tsquery := plainto_tsquery('spanish', query_text);
BEGIN
  RETURN QUERY
  WITH 
  -- A. Búsqueda Vectorial (Dense) filtrada por USER_SENT
  vector_search AS (
    SELECT 
      m.id,
      m.content,
      RANK() OVER (ORDER BY m.embedding <=> query_embedding) as vector_rank
    FROM user_memories m
    WHERE m.client_id = p_client_id
      AND m.sender ILIKE '%user_sent%' -- Filtro crítico para ESTILO del dueño
    LIMIT 20
  ),
  
  -- B. Búsqueda de Texto (Sparse) filtrada por USER_SENT
  keyword_search AS (
    SELECT 
      m.id,
      m.content,
      RANK() OVER (ORDER BY ts_rank(m.fts, fts_query) DESC) as keyword_rank
    FROM user_memories m
    WHERE m.client_id = p_client_id 
      AND m.sender ILIKE '%user_sent%'
      AND m.fts @@ fts_query
      AND length(query_text) > 2
    LIMIT 20
  ),
  
  -- C. Combinación RRF
  combined_results AS (
    SELECT
      COALESCE(v.id, k.id) as shared_id,
      COALESCE(v.content, k.content) as shared_content,
      v.vector_rank,
      k.keyword_rank
    FROM vector_search v
    FULL OUTER JOIN keyword_search k ON v.id = k.id
  )
  
  SELECT
    c.shared_content as content,
    (
      COALESCE(1.0 / (rrf_k + c.vector_rank), 0.0) +
      COALESCE(1.0 / (rrf_k + c.keyword_rank), 0.0)
    )::float as similarity
  FROM combined_results c
  ORDER BY similarity DESC
  LIMIT match_count;
END;
$$;
