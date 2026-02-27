-- ====================================================================
-- OPENCLAW GRAPHRAG: Esquema de Grafo de Conocimiento + Búsqueda 2-Hop
-- Ejecutar en el SQL Editor de Supabase DESPUÉS de hybrid_search_setup.sql
-- ====================================================================

-- 1. Tabla de Nodos (Entidades): Personas, Lugares, Objetos, Datos
CREATE TABLE IF NOT EXISTS public.knowledge_nodes (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    client_id text NOT NULL,
    entity_name text NOT NULL,
    entity_type text NOT NULL DEFAULT 'DATO', -- PERSONA|LUGAR|OBJETO|DATO
    description text,
    embedding vector(768), -- Vector semántico del nodo para búsqueda por similitud
    created_at timestamp with time zone DEFAULT now(),
    -- Evitar nodos duplicados por cliente
    UNIQUE(client_id, entity_name)
);

-- Índices para búsqueda rápida
CREATE INDEX IF NOT EXISTS idx_knowledge_nodes_client ON public.knowledge_nodes(client_id);
CREATE INDEX IF NOT EXISTS idx_knowledge_nodes_embedding ON public.knowledge_nodes USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

-- Columna FTS generada para búsqueda léxica de nodos
ALTER TABLE public.knowledge_nodes 
ADD COLUMN IF NOT EXISTS fts tsvector 
GENERATED ALWAYS AS (to_tsvector('spanish', entity_name || ' ' || COALESCE(description, ''))) STORED;

CREATE INDEX IF NOT EXISTS idx_knowledge_nodes_fts ON public.knowledge_nodes USING GIN (fts);

-- 2. Tabla de Aristas (Relaciones): Sujeto -> Verbo -> Objeto
CREATE TABLE IF NOT EXISTS public.knowledge_edges (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    client_id text NOT NULL,
    source_node text NOT NULL,  -- entity_name del nodo origen
    relation_type text NOT NULL, -- TIENE_WIFI, ES_MASCOTA_DE, VIVE_EN, etc.
    target_node text NOT NULL,   -- entity_name del nodo destino
    context text,                -- Contexto adicional de la relación
    created_at timestamp with time zone DEFAULT now(),
    -- Evitar relaciones duplicadas
    UNIQUE(client_id, source_node, relation_type, target_node)
);

CREATE INDEX IF NOT EXISTS idx_knowledge_edges_client ON public.knowledge_edges(client_id);
CREATE INDEX IF NOT EXISTS idx_knowledge_edges_source ON public.knowledge_edges(source_node);
CREATE INDEX IF NOT EXISTS idx_knowledge_edges_target ON public.knowledge_edges(target_node);

-- 3. Función GraphRAG: Búsqueda de 2 Saltos (Seed → Hop1 → Hop2)
-- Encuentra los nodos más relevantes semánticamente Y por texto,
-- luego recorre sus aristas para traer todo el contexto relacional.
DROP FUNCTION IF EXISTS public.graphrag_traverse;

CREATE OR REPLACE FUNCTION graphrag_traverse(
    query_text text,
    query_embedding vector(768),
    match_count int,
    p_client_id text
)
RETURNS TABLE (
    knowledge text,
    entity_name text,
    entity_type text,
    relation text,
    hop int
)
LANGUAGE plpgsql
AS $$
DECLARE
    fts_query tsquery := plainto_tsquery('spanish', query_text);
BEGIN
    RETURN QUERY
    WITH
    -- A. SEED: Encontrar los nodos semilla combinando similitud vectorial + texto
    seed_nodes AS (
        SELECT 
            n.entity_name,
            n.entity_type,
            n.description,
            -- RRF combinando vector rank + keyword rank
            (
                COALESCE(1.0 / (60 + RANK() OVER (ORDER BY n.embedding <=> query_embedding)), 0.0) +
                CASE WHEN n.fts @@ fts_query 
                     THEN COALESCE(1.0 / (60 + RANK() OVER (ORDER BY ts_rank(n.fts, fts_query) DESC)), 0.0)
                     ELSE 0.0 END
            ) as rrf_score
        FROM knowledge_nodes n
        WHERE n.client_id = p_client_id
        ORDER BY rrf_score DESC
        LIMIT match_count
    ),

    -- B. HOP 1: Todas las aristas conectadas a los nodos semilla (como source O target)
    hop1_edges AS (
        SELECT DISTINCT
            e.source_node,
            e.relation_type,
            e.target_node,
            e.context
        FROM knowledge_edges e
        INNER JOIN seed_nodes s ON (e.source_node = s.entity_name OR e.target_node = s.entity_name)
        WHERE e.client_id = p_client_id
    ),

    -- C. HOP 2: Aristas conectadas a los nodos descubiertos en Hop 1
    hop1_discovered_nodes AS (
        SELECT DISTINCT unnest(ARRAY[source_node, target_node]) as node_name
        FROM hop1_edges
    ),
    hop2_edges AS (
        SELECT DISTINCT
            e.source_node,
            e.relation_type,
            e.target_node,
            e.context
        FROM knowledge_edges e
        INNER JOIN hop1_discovered_nodes h ON (e.source_node = h.node_name OR e.target_node = h.node_name)
        WHERE e.client_id = p_client_id
          AND NOT EXISTS (
              SELECT 1 FROM hop1_edges h1 
              WHERE h1.source_node = e.source_node 
                AND h1.relation_type = e.relation_type 
                AND h1.target_node = e.target_node
          )
        LIMIT 20  -- Limitar Hop 2 para no explotar la respuesta
    )

    -- D. SALIDA: Nodos semilla (Hop 0) + Relaciones directas (Hop 1) + Relaciones expandidas (Hop 2)
    
    -- Hop 0: Los nodos semilla con su descripción
    SELECT 
        ('ENTIDAD [' || s.entity_type || ']: ' || s.entity_name || ' — ' || COALESCE(s.description, 'sin descripción'))::text as knowledge,
        s.entity_name::text,
        s.entity_type::text,
        NULL::text as relation,
        0 as hop
    FROM seed_nodes s

    UNION ALL

    -- Hop 1: Relaciones directas
    SELECT
        (h1.source_node || ' —[' || h1.relation_type || ']→ ' || h1.target_node || COALESCE(' (' || h1.context || ')', ''))::text as knowledge,
        h1.source_node::text as entity_name,
        'RELACIÓN'::text as entity_type,
        h1.relation_type::text as relation,
        1 as hop
    FROM hop1_edges h1

    UNION ALL

    -- Hop 2: Relaciones expandidas (contexto indirecto)
    SELECT
        (h2.source_node || ' —[' || h2.relation_type || ']→ ' || h2.target_node || COALESCE(' (' || h2.context || ')', ''))::text as knowledge,
        h2.source_node::text as entity_name,
        'RELACIÓN_EXPANDIDA'::text as entity_type,
        h2.relation_type::text as relation,
        2 as hop
    FROM hop2_edges h2

    ORDER BY hop ASC;
END;
$$;
