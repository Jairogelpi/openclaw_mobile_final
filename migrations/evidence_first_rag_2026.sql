CREATE TABLE IF NOT EXISTS public.contact_identities (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id UUID NOT NULL REFERENCES public.user_souls(client_id) ON DELETE CASCADE,
    remote_id TEXT NOT NULL,
    canonical_name TEXT NOT NULL,
    normalized_name TEXT NOT NULL,
    aliases JSONB NOT NULL DEFAULT '[]'::jsonb,
    confidence DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    source_details JSONB NOT NULL DEFAULT '{}'::jsonb,
    last_verified_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    UNIQUE (client_id, remote_id)
);

CREATE INDEX IF NOT EXISTS idx_contact_identities_client_id
    ON public.contact_identities(client_id);

CREATE INDEX IF NOT EXISTS idx_contact_identities_normalized_name
    ON public.contact_identities(client_id, normalized_name);

CREATE TABLE IF NOT EXISTS public.rag_eval_cases (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id UUID NOT NULL REFERENCES public.user_souls(client_id) ON DELETE CASCADE,
    category TEXT NOT NULL,
    query TEXT NOT NULL,
    expected_mode TEXT NOT NULL DEFAULT 'answer',
    expected_entities JSONB NOT NULL DEFAULT '[]'::jsonb,
    expected_remote_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
    expected_substrings JSONB NOT NULL DEFAULT '[]'::jsonb,
    expected_time_start TIMESTAMP WITH TIME ZONE NULL,
    expected_time_end TIMESTAMP WITH TIME ZONE NULL,
    notes JSONB NOT NULL DEFAULT '{}'::jsonb,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_rag_eval_cases_client_id
    ON public.rag_eval_cases(client_id, active);

CREATE TABLE IF NOT EXISTS public.rag_eval_runs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id UUID NOT NULL REFERENCES public.user_souls(client_id) ON DELETE CASCADE,
    run_name TEXT NOT NULL,
    total_cases INTEGER NOT NULL DEFAULT 0,
    passed_cases INTEGER NOT NULL DEFAULT 0,
    precision_at_k DOUBLE PRECISION NOT NULL DEFAULT 0,
    citation_coverage DOUBLE PRECISION NOT NULL DEFAULT 0,
    abstention_precision DOUBLE PRECISION NOT NULL DEFAULT 0,
    entity_resolution_accuracy DOUBLE PRECISION NOT NULL DEFAULT 0,
    temporal_accuracy DOUBLE PRECISION NOT NULL DEFAULT 0,
    hallucination_rate DOUBLE PRECISION NOT NULL DEFAULT 0,
    p50_latency_ms INTEGER NOT NULL DEFAULT 0,
    p95_latency_ms INTEGER NOT NULL DEFAULT 0,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_rag_eval_runs_client_id
    ON public.rag_eval_runs(client_id, created_at DESC);

ALTER TABLE public.rag_metrics
    ADD COLUMN IF NOT EXISTS mode TEXT DEFAULT 'legacy';

DROP FUNCTION IF EXISTS public.hybrid_search_memories_v2(text, vector, integer, uuid);
CREATE OR REPLACE FUNCTION public.hybrid_search_memories_v2(
    query_text text,
    query_embedding vector(768),
    match_count integer,
    p_client_id uuid
)
RETURNS TABLE(
    id uuid,
    content text,
    sender text,
    remote_id text,
    event_timestamp timestamptz,
    metadata jsonb,
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
  WITH vector_search AS (
    SELECT
      m.id,
      m.content,
      m.sender,
      NULLIF(COALESCE(m.metadata->>'remoteId', m.metadata->>'remote_id'), '') AS remote_id,
      COALESCE(
        CASE WHEN m.metadata->>'date' IS NOT NULL THEN (m.metadata->>'date')::timestamptz ELSE NULL END,
        CASE WHEN m.metadata->>'dateStart' IS NOT NULL THEN (m.metadata->>'dateStart')::timestamptz ELSE NULL END,
        m.created_at
      ) AS event_timestamp,
      COALESCE(m.metadata, '{}'::jsonb) AS metadata,
      m.embedding <=> query_embedding AS vector_distance,
      RANK() OVER (ORDER BY m.embedding <=> query_embedding) AS vector_rank
    FROM public.user_memories m
    WHERE m.client_id = p_client_id
      AND m.embedding IS NOT NULL
    LIMIT 120
  ),
  keyword_search AS (
    SELECT
      m.id,
      m.content,
      m.sender,
      NULLIF(COALESCE(m.metadata->>'remoteId', m.metadata->>'remote_id'), '') AS remote_id,
      COALESCE(
        CASE WHEN m.metadata->>'date' IS NOT NULL THEN (m.metadata->>'date')::timestamptz ELSE NULL END,
        CASE WHEN m.metadata->>'dateStart' IS NOT NULL THEN (m.metadata->>'dateStart')::timestamptz ELSE NULL END,
        m.created_at
      ) AS event_timestamp,
      COALESCE(m.metadata, '{}'::jsonb) AS metadata,
      ts_rank(m.fts, fts_query) AS keyword_score,
      RANK() OVER (ORDER BY ts_rank(m.fts, fts_query) DESC) AS keyword_rank
    FROM public.user_memories m
    WHERE m.client_id = p_client_id
      AND length(query_text) > 2
      AND m.fts @@ fts_query
    LIMIT 120
  ),
  combined AS (
    SELECT
      COALESCE(v.id, k.id) AS id,
      COALESCE(v.content, k.content) AS content,
      COALESCE(v.sender, k.sender) AS sender,
      COALESCE(v.remote_id, k.remote_id) AS remote_id,
      COALESCE(v.event_timestamp, k.event_timestamp) AS event_timestamp,
      COALESCE(v.metadata, k.metadata, '{}'::jsonb) AS metadata,
      v.vector_distance,
      k.keyword_score,
      v.vector_rank,
      k.keyword_rank
    FROM vector_search v
    FULL OUTER JOIN keyword_search k ON v.id = k.id
  )
  SELECT
    c.id,
    c.content,
    c.sender,
    c.remote_id,
    c.event_timestamp,
    c.metadata,
    COALESCE(1.0 - c.vector_distance, 0.0)::float AS score_vector,
    COALESCE(c.keyword_score, 0.0)::float AS score_fts,
    (
      COALESCE(1.0 / (rrf_k + c.vector_rank), 0.0) +
      COALESCE(1.0 / (rrf_k + c.keyword_rank), 0.0)
    )::float AS recall_score
  FROM combined c
  ORDER BY recall_score DESC, event_timestamp DESC NULLS LAST
  LIMIT match_count;
END;
$function$;

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
        ORDER BY recall_score DESC
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
            s.recall_score * 0.9 AS recall_score
        FROM public.knowledge_edges e
        INNER JOIN seed_nodes s
            ON e.source_node = s.entity_name OR e.target_node = s.entity_name
        WHERE e.client_id = p_client_id
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
            h1.recall_score * 0.7 AS recall_score
        FROM public.knowledge_edges e
        INNER JOIN hop1_edges h1
            ON e.source_node = h1.target_node OR e.target_node = h1.target_node
        WHERE e.client_id = p_client_id
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
            h2.recall_score * 0.5 AS recall_score
        FROM public.knowledge_edges e
        INNER JOIN hop2_edges h2
            ON e.source_node = h2.target_node OR e.target_node = h2.target_node
        WHERE e.client_id = p_client_id
        ORDER BY e.source_node, e.relation_type, e.target_node, e.last_seen DESC NULLS LAST
        LIMIT 20
    )
    SELECT
        s.entity_name AS source_node,
        NULL::text AS target_node,
        NULL::text AS relation_type,
        0 AS hop,
        ('NODO [' || s.entity_type || ']: ' || s.entity_name || COALESCE(' - ' || s.description, ''))::text AS knowledge,
        s.entity_name,
        s.entity_type,
        s.description AS context,
        NULL::timestamptz AS last_seen,
        COALESCE(1.0 - s.vector_distance, 0.0)::float AS score_vector,
        COALESCE(s.keyword_score, 0.0)::float AS score_fts,
        s.recall_score::float AS recall_score
    FROM seed_nodes s

    UNION ALL

    SELECT
        h1.source_node,
        h1.target_node,
        h1.relation_type,
        1 AS hop,
        (h1.source_node || ' -[' || h1.relation_type || ']-> ' || h1.target_node || COALESCE(' (' || h1.context || ')', ''))::text AS knowledge,
        h1.entity_name,
        h1.entity_type,
        h1.context,
        h1.last_seen,
        h1.recall_score::float AS score_vector,
        0.0::float AS score_fts,
        h1.recall_score::float AS recall_score
    FROM hop1_edges h1

    UNION ALL

    SELECT
        h2.source_node,
        h2.target_node,
        h2.relation_type,
        2 AS hop,
        (h2.source_node || ' -[' || h2.relation_type || ']-> ' || h2.target_node || COALESCE(' (' || h2.context || ')', ''))::text AS knowledge,
        h2.entity_name,
        h2.entity_type,
        h2.context,
        h2.last_seen,
        h2.recall_score::float AS score_vector,
        0.0::float AS score_fts,
        h2.recall_score::float AS recall_score
    FROM hop2_edges h2

    UNION ALL

    SELECT
        h3.source_node,
        h3.target_node,
        h3.relation_type,
        3 AS hop,
        (h3.source_node || ' -[' || h3.relation_type || ']-> ' || h3.target_node || COALESCE(' (' || h3.context || ')', ''))::text AS knowledge,
        h3.entity_name,
        h3.entity_type,
        h3.context,
        h3.last_seen,
        h3.recall_score::float AS score_vector,
        0.0::float AS score_fts,
        h3.recall_score::float AS recall_score
    FROM hop3_edges h3
    ORDER BY recall_score DESC, hop ASC
    LIMIT (match_count * 4);
END;
$function$;
