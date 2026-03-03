-- ====================================================================
-- OPENCLAW GRAPHRAG V4: COGNITIVE DEPTH & RELATIONAL WEIGHT
-- ====================================================================

-- 1. Añadir peso y recencia a las relaciones
ALTER TABLE public.knowledge_edges 
ADD COLUMN IF NOT EXISTS weight integer DEFAULT 1,
ADD COLUMN IF NOT EXISTS last_seen timestamp with time zone DEFAULT now(),
ADD COLUMN IF NOT EXISTS cognitive_flags text[] DEFAULT '{}';

-- 2. Índice para optimizar búsquedas por peso (relevancia)
CREATE INDEX IF NOT EXISTS idx_knowledge_edges_weight ON public.knowledge_edges(weight DESC);

-- 3. Función atómica para el Upsert de Relaciones con Incremento de Peso
-- Esto permite que si una relación se detecta varias veces, su "importancia" suba.
CREATE OR REPLACE FUNCTION upsert_knowledge_edge_v4(
    p_client_id text,
    p_source_node text,
    p_target_node text,
    p_relation_type text,
    p_context text DEFAULT NULL,
    p_flags text[] DEFAULT '{}'
) RETURNS void AS $$
BEGIN
    INSERT INTO public.knowledge_edges (client_id, source_node, target_node, relation_type, context, cognitive_flags, weight, last_seen)
    VALUES (p_client_id, p_source_node, p_target_node, p_relation_type, p_context, p_flags, 1, now())
    ON CONFLICT (client_id, source_node, relation_type, target_node) 
    DO UPDATE SET 
        weight = knowledge_edges.weight + 1,
        last_seen = now(),
        context = COALESCE(p_context, knowledge_edges.context),
        cognitive_flags = array_cat(knowledge_edges.cognitive_flags, p_flags);
END;
$$ LANGUAGE plpgsql;
