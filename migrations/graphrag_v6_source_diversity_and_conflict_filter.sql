-- ====================================================================
-- OPENCLAW GRAPHRAG V6: SOURCE DIVERSITY & CONFLICT FILTER
-- ====================================================================

ALTER TABLE public.knowledge_nodes
ADD COLUMN IF NOT EXISTS source_tags text[] NOT NULL DEFAULT '{}';

ALTER TABLE public.knowledge_edges
ADD COLUMN IF NOT EXISTS source_tags text[] NOT NULL DEFAULT '{}';

UPDATE public.knowledge_nodes
SET source_tags = COALESCE(source_tags, '{}');

UPDATE public.knowledge_edges
SET source_tags = COALESCE(source_tags, '{}');

CREATE INDEX IF NOT EXISTS idx_knowledge_nodes_source_tags
    ON public.knowledge_nodes USING GIN (source_tags);

CREATE INDEX IF NOT EXISTS idx_knowledge_edges_source_tags
    ON public.knowledge_edges USING GIN (source_tags);

DROP FUNCTION IF EXISTS public.graphrag_traverse_v2(text, vector, integer, uuid);
CREATE OR REPLACE FUNCTION public.graphrag_traverse_v2(
    query_text text,
    query_embedding vector(768),
    match_count integer,
    p_client_id uuid
)
RETURNS TABLE(
    source_node text,
    target_node text,
    relation_type text,
    hop integer,
    knowledge text,
    entity_name text,
    entity_type text,
    context text,
    last_seen timestamptz,
    score_vector double precision,
    score_fts double precision,
    recall_score double precision
)
LANGUAGE plpgsql
AS $function$
DECLARE
    rrf_k CONSTANT int := 60;
    fts_query tsquery := cast(replace(plainto_tsquery('spanish', query_text)::text, '&', '|') as tsquery);
BEGIN
    RETURN QUERY
    WITH seed_nodes AS (
        SELECT
            n.entity_name,
            n.entity_type,
            n.description,
            n.stable_score,
            n.embedding <=> query_embedding AS vector_distance,
            CASE WHEN n.fts @@ fts_query THEN ts_rank(n.fts, fts_query) ELSE 0 END AS keyword_score,
            (
                COALESCE(1.0 / (rrf_k + RANK() OVER (ORDER BY n.embedding <=> query_embedding)), 0.0) +
                CASE
                    WHEN n.fts @@ fts_query THEN COALESCE(1.0 / (rrf_k + RANK() OVER (ORDER BY ts_rank(n.fts, fts_query) DESC)), 0.0)
                    ELSE 0.0
                END
            ) AS recall_score
        FROM public.knowledge_nodes n
        WHERE n.client_id = p_client_id
          AND COALESCE(n.stability_tier, 'candidate') IN ('provisional', 'stable')
        ORDER BY recall_score DESC, n.stable_score DESC
        LIMIT match_count
    ),
    hop1_edges AS (
        SELECT DISTINCT ON (e.source_node, e.relation_type, e.target_node)
            e.source_node,
            e.target_node,
            e.relation_type,
            e.context,
            e.last_seen,
            s.entity_name AS entity_name,
            s.entity_type AS entity_type,
            (s.recall_score * 0.9) + LEAST(COALESCE(e.stable_score, 0), 12) * 0.01 AS recall_score
        FROM public.knowledge_edges e
        INNER JOIN seed_nodes s
            ON e.source_node = s.entity_name OR e.target_node = s.entity_name
        WHERE e.client_id = p_client_id
          AND COALESCE(e.stability_tier, 'candidate') IN ('provisional', 'stable')
          AND NOT ('conflicted' = ANY(COALESCE(e.cognitive_flags, '{}')))
        ORDER BY e.source_node, e.relation_type, e.target_node, e.last_seen DESC NULLS LAST
    ),
    hop2_edges AS (
        SELECT DISTINCT ON (e.source_node, e.relation_type, e.target_node)
            e.source_node,
            e.target_node,
            e.relation_type,
            e.context,
            e.last_seen,
            h1.entity_name,
            h1.entity_type,
            (h1.recall_score * 0.7) + LEAST(COALESCE(e.stable_score, 0), 12) * 0.01 AS recall_score
        FROM public.knowledge_edges e
        INNER JOIN hop1_edges h1
            ON e.source_node = h1.target_node OR e.target_node = h1.target_node
        WHERE e.client_id = p_client_id
          AND COALESCE(e.stability_tier, 'candidate') IN ('provisional', 'stable')
          AND NOT ('conflicted' = ANY(COALESCE(e.cognitive_flags, '{}')))
        ORDER BY e.source_node, e.relation_type, e.target_node, e.last_seen DESC NULLS LAST
        LIMIT 40
    ),
    hop3_edges AS (
        SELECT DISTINCT ON (e.source_node, e.relation_type, e.target_node)
            e.source_node,
            e.target_node,
            e.relation_type,
            e.context,
            e.last_seen,
            h2.entity_name,
            h2.entity_type,
            (h2.recall_score * 0.5) + LEAST(COALESCE(e.stable_score, 0), 12) * 0.01 AS recall_score
        FROM public.knowledge_edges e
        INNER JOIN hop2_edges h2
            ON e.source_node = h2.target_node OR e.target_node = h2.target_node
        WHERE e.client_id = p_client_id
          AND COALESCE(e.stability_tier, 'candidate') IN ('provisional', 'stable')
          AND NOT ('conflicted' = ANY(COALESCE(e.cognitive_flags, '{}')))
        ORDER BY e.source_node, e.relation_type, e.target_node, e.last_seen DESC NULLS LAST
        LIMIT 20
    )
    SELECT
        h.source_node,
        h.target_node,
        h.relation_type,
        h.hop,
        h.knowledge,
        h.entity_name,
        h.entity_type,
        h.context,
        h.last_seen,
        h.score_vector,
        h.score_fts,
        h.recall_score
    FROM (
        SELECT
            NULL::text AS source_node,
            NULL::text AS target_node,
            NULL::text AS relation_type,
            0 AS hop,
            ('ENTIDAD [' || s.entity_type || ']: ' || s.entity_name || ' — ' || COALESCE(s.description, 'sin descripción'))::text AS knowledge,
            s.entity_name::text AS entity_name,
            s.entity_type::text AS entity_type,
            NULL::text AS context,
            NULL::timestamptz AS last_seen,
            COALESCE(1.0 - s.vector_distance, 0.0)::float AS score_vector,
            COALESCE(s.keyword_score, 0.0)::float AS score_fts,
            s.recall_score::float AS recall_score
        FROM seed_nodes s

        UNION ALL

        SELECT
            h1.source_node::text,
            h1.target_node::text,
            h1.relation_type::text,
            1,
            (h1.source_node || ' —[' || h1.relation_type || ']→ ' || h1.target_node || COALESCE(' (' || h1.context || ')', ''))::text,
            h1.entity_name::text,
            h1.entity_type::text,
            h1.context::text,
            h1.last_seen,
            0.0::float,
            0.0::float,
            h1.recall_score::float
        FROM hop1_edges h1

        UNION ALL

        SELECT
            h2.source_node::text,
            h2.target_node::text,
            h2.relation_type::text,
            2,
            (h2.source_node || ' —[' || h2.relation_type || ']→ ' || h2.target_node || COALESCE(' (' || h2.context || ')', ''))::text,
            h2.entity_name::text,
            h2.entity_type::text,
            h2.context::text,
            h2.last_seen,
            0.0::float,
            0.0::float,
            h2.recall_score::float
        FROM hop2_edges h2

        UNION ALL

        SELECT
            h3.source_node::text,
            h3.target_node::text,
            h3.relation_type::text,
            3,
            (h3.source_node || ' —[' || h3.relation_type || ']→ ' || h3.target_node || COALESCE(' (' || h3.context || ')', ''))::text,
            h3.entity_name::text,
            h3.entity_type::text,
            h3.context::text,
            h3.last_seen,
            0.0::float,
            0.0::float,
            h3.recall_score::float
        FROM hop3_edges h3
    ) h
    ORDER BY h.hop ASC, h.recall_score DESC;
END;
$function$;
