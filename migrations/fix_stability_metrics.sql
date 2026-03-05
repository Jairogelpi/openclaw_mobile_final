-- Create RAG Metrics Table for cognitive pipeline observability
CREATE TABLE IF NOT EXISTS public.rag_metrics (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id UUID NOT NULL REFERENCES public.user_souls(client_id) ON DELETE CASCADE,
    query TEXT,
    hybrid_count INTEGER DEFAULT 0,
    graph_count INTEGER DEFAULT 0,
    unique_candidates INTEGER DEFAULT 0,
    avg_similarity DOUBLE PRECISION DEFAULT 0,
    avg_resonance DOUBLE PRECISION DEFAULT 0,
    confidence_level TEXT DEFAULT 'NONE',
    agentic_iterations INTEGER DEFAULT 0,
    web_search_used BOOLEAN DEFAULT FALSE,
    youtube_skill_used BOOLEAN DEFAULT FALSE,
    cache_hit BOOLEAN DEFAULT FALSE,
    reflection_attempts INTEGER DEFAULT 0,
    reflection_score DOUBLE PRECISION DEFAULT 0,
    conflict_detected BOOLEAN DEFAULT FALSE,
    total_latency_ms INTEGER DEFAULT 0,
    llm_calls_count INTEGER DEFAULT 0,
    metadata JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

-- Index for performance
CREATE INDEX IF NOT EXISTS idx_rag_metrics_client_id ON public.rag_metrics(client_id);
CREATE INDEX IF NOT EXISTS idx_rag_metrics_created_at ON public.rag_metrics(created_at);

-- Add worker_status as a fallback or rename column in user_souls if really needed? 
-- The user reported "column user_souls.worker_status does not exist". 
-- In admin.controller.mjs I'll change the code to use is_processing, but let's add the column as a safety ghost.
ALTER TABLE public.user_souls ADD COLUMN IF NOT EXISTS worker_status TEXT DEFAULT 'Cerebro en reposo';
