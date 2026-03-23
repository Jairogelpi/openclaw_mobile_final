-- FIXING FIELD NAMES FOR RPC
-- Target: knowledge_nodes
-- Reason: fix undefined description in unified_prompt

CREATE OR REPLACE FUNCTION public.search_knowledge_nodes_v2(
    cid uuid,
    query text,
    lim int
)
RETURNS TABLE (
    id uuid,
    entity_name text,
    entity_type text,
    description text, -- Changed from entity_description to match graph.service.mjs
    similarity float
)
LANGUAGE plpgsql
AS $$
DECLARE
  fts_query tsquery := plainto_tsquery('spanish', query);
BEGIN
    RETURN QUERY
    SELECT 
        n.id,
        n.entity_name,
        n.entity_type,
        n.description, -- Straight map
        ts_rank(n.fts, fts_query)::float as similarity
    FROM public.knowledge_nodes n
    WHERE n.client_id = cid
      AND (
          n.fts @@ fts_query
          OR n.entity_name ILIKE '%' || query || '%'
      )
    ORDER BY similarity DESC, n.entity_name ASC
    LIMIT lim;
END;
$$;
