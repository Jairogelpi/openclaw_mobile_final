CREATE TABLE IF NOT EXISTS public.entity_mentions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id UUID NOT NULL REFERENCES public.user_souls(client_id) ON DELETE CASCADE,
    entity_name TEXT NOT NULL,
    entity_type TEXT NOT NULL DEFAULT 'ENTITY',
    description TEXT NULL,
    remote_id TEXT NULL,
    support_count INTEGER NOT NULL DEFAULT 0,
    stable_score DOUBLE PRECISION NOT NULL DEFAULT 0,
    stability_tier TEXT NOT NULL DEFAULT 'candidate',
    source_tags JSONB NOT NULL DEFAULT '[]'::jsonb,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    promoted_to_graph BOOLEAN NOT NULL DEFAULT FALSE,
    promoted_node_id UUID NULL REFERENCES public.knowledge_nodes(id) ON DELETE SET NULL,
    first_seen TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (client_id, entity_name)
);

CREATE INDEX IF NOT EXISTS idx_entity_mentions_client_id
    ON public.entity_mentions(client_id);

CREATE INDEX IF NOT EXISTS idx_entity_mentions_tier
    ON public.entity_mentions(client_id, stability_tier, support_count DESC);

CREATE TABLE IF NOT EXISTS public.relation_mentions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id UUID NOT NULL REFERENCES public.user_souls(client_id) ON DELETE CASCADE,
    source_node TEXT NOT NULL,
    relation_type TEXT NOT NULL,
    target_node TEXT NOT NULL,
    context TEXT NULL,
    support_count INTEGER NOT NULL DEFAULT 0,
    stable_score DOUBLE PRECISION NOT NULL DEFAULT 0,
    stability_tier TEXT NOT NULL DEFAULT 'candidate',
    cognitive_flags JSONB NOT NULL DEFAULT '[]'::jsonb,
    source_tags JSONB NOT NULL DEFAULT '[]'::jsonb,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    promoted_to_graph BOOLEAN NOT NULL DEFAULT FALSE,
    first_seen TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (client_id, source_node, relation_type, target_node)
);

CREATE INDEX IF NOT EXISTS idx_relation_mentions_client_id
    ON public.relation_mentions(client_id);

CREATE INDEX IF NOT EXISTS idx_relation_mentions_tier
    ON public.relation_mentions(client_id, stability_tier, support_count DESC);

ALTER TABLE public.rag_eval_cases
    ADD COLUMN IF NOT EXISTS style_tag TEXT DEFAULT 'general',
    ADD COLUMN IF NOT EXISTS expected_citation_min INTEGER DEFAULT 1,
    ADD COLUMN IF NOT EXISTS expected_evidence_kinds JSONB NOT NULL DEFAULT '[]'::jsonb,
    ADD COLUMN IF NOT EXISTS expected_verdict_detail TEXT NULL,
    ADD COLUMN IF NOT EXISTS expected_memory_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
    ADD COLUMN IF NOT EXISTS expected_edge_keys JSONB NOT NULL DEFAULT '[]'::jsonb,
    ADD COLUMN IF NOT EXISTS expected_media_kind TEXT NULL,
    ADD COLUMN IF NOT EXISTS expected_speaker TEXT NULL;

ALTER TABLE public.rag_metrics
    ADD COLUMN IF NOT EXISTS query_style TEXT NULL,
    ADD COLUMN IF NOT EXISTS retrieval_profile JSONB NOT NULL DEFAULT '{}'::jsonb;
