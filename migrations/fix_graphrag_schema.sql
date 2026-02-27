-- ====================================================================
-- OPENCLAW: CORRECCIÓN DE ESQUEMA GRAPHRAG + HYBRID RAG
-- Ejecutar en el SQL Editor de Supabase
-- Este script REEMPLAZA hybrid_search_setup.sql y graphrag_schema.sql
-- ====================================================================

-- =============================================
-- PARTE 1: ARREGLAR knowledge_edges (FK rotos)
-- =============================================

-- Borrar los foreign keys rotos
ALTER TABLE public.knowledge_edges DROP CONSTRAINT IF EXISTS fk_edges_target;
ALTER TABLE public.knowledge_edges DROP CONSTRAINT IF EXISTS fk_edges_source;
ALTER TABLE public.knowledge_edges DROP CONSTRAINT IF EXISTS fk_edges_client;

-- Recrear FK limpio: solo al cliente
ALTER TABLE public.knowledge_edges 
ADD CONSTRAINT fk_edges_client FOREIGN KEY (client_id) REFERENCES public.clients(id);

-- Añadir UNIQUE para evitar relaciones duplicadas
ALTER TABLE public.knowledge_edges 
DROP CONSTRAINT IF EXISTS uq_edges_triplet;
ALTER TABLE public.knowledge_edges 
ADD CONSTRAINT uq_edges_triplet UNIQUE(client_id, source_node, relation_type, target_node);

-- =============================================
-- PARTE 2: ARREGLAR knowledge_nodes (UNIQUE)
-- =============================================

ALTER TABLE public.knowledge_nodes 
DROP CONSTRAINT IF EXISTS uq_nodes_entity;
ALTER TABLE public.knowledge_nodes 
ADD CONSTRAINT uq_nodes_entity UNIQUE(client_id, entity_name);

-- =============================================
-- PARTE 3: ÍNDICES DE RENDIMIENTO
-- =============================================

-- Índices vectoriales (ivfflat) para búsqueda semántica ultrarrápida
CREATE INDEX IF NOT EXISTS idx_knowledge_nodes_embedding 
ON public.knowledge_nodes USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

CREATE INDEX IF NOT EXISTS idx_user_memories_embedding 
ON public.user_memories USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

-- Índices GIN para búsqueda de texto (BM25)
CREATE INDEX IF NOT EXISTS idx_knowledge_nodes_fts 
ON public.knowledge_nodes USING GIN (fts);

CREATE INDEX IF NOT EXISTS idx_user_memories_fts 
ON public.user_memories USING GIN (fts);

-- Índices de lookup para aristas
CREATE INDEX IF NOT EXISTS idx_knowledge_edges_source ON public.knowledge_edges(source_node);
CREATE INDEX IF NOT EXISTS idx_knowledge_edges_target ON public.knowledge_edges(target_node);
CREATE INDEX IF NOT EXISTS idx_knowledge_edges_client ON public.knowledge_edges(client_id);

-- =============================================
-- PARTE 4: FUNCIÓN HÍBRIDA (BM25 + pgvector + RRF)
-- Nota: client_id es UUID, no TEXT
-- =============================================

DROP FUNCTION IF EXISTS public.hybrid_search_memories;

CREATE OR REPLACE FUNCTION hybrid_search_memories (
  query_text text,
  query_embedding vector(768),
  match_count int,
  p_client_id uuid  -- ← UUID correcto
)
RETURNS TABLE (
  id uuid,
  content text,
  sender text,
  date text,
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
  -- A. Búsqueda Vectorial (Dense)
  vector_search AS (
    SELECT 
      m.id,
      m.content,
      m.sender,
      (m.metadata->>'date')::text as date,
      RANK() OVER (ORDER BY m.embedding <=> query_embedding) as vector_rank
    FROM user_memories m
    WHERE m.client_id = p_client_id
      AND m.embedding IS NOT NULL
    LIMIT 50
  ),
  -- B. Búsqueda de Texto (Sparse / BM25)
  keyword_search AS (
    SELECT 
      m.id,
      m.content,
      m.sender,
      (m.metadata->>'date')::text as date,
      RANK() OVER (ORDER BY ts_rank(m.fts, fts_query) DESC) as keyword_rank
    FROM user_memories m
    WHERE m.client_id = p_client_id 
      AND m.fts @@ fts_query
      AND length(query_text) > 2
    LIMIT 50
  ),
  -- C. Fusión RRF
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
  SELECT
    c.shared_id as id,
    c.shared_content as content,
    c.shared_sender as sender,
    c.shared_date as date,
    (
      COALESCE(1.0 / (rrf_k + c.vector_rank), 0.0) +
      COALESCE(1.0 / (rrf_k + c.keyword_rank), 0.0)
    )::float as similarity
  FROM combined_results c
  ORDER BY similarity DESC
  LIMIT match_count;
END;
$$;

-- =============================================
-- PARTE 5: FUNCIÓN GRAPHRAG (2-Hop Traversal)
-- Nota: client_id es UUID, no TEXT
-- =============================================

DROP FUNCTION IF EXISTS public.graphrag_traverse;

CREATE OR REPLACE FUNCTION graphrag_traverse(
    query_text text,
    query_embedding vector(768),
    match_count int,
    p_client_id uuid  -- ← UUID correcto
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
    -- A. SEED: Nodos semilla (Hybrid RRF sobre knowledge_nodes)
    seed_nodes AS (
        SELECT 
            n.entity_name,
            n.entity_type,
            n.description,
            (
                COALESCE(1.0 / (60 + RANK() OVER (ORDER BY n.embedding <=> query_embedding)), 0.0) +
                CASE WHEN n.fts @@ fts_query 
                     THEN COALESCE(1.0 / (60 + RANK() OVER (ORDER BY ts_rank(n.fts, fts_query) DESC)), 0.0)
                     ELSE 0.0 END
            ) as rrf_score
        FROM knowledge_nodes n
        WHERE n.client_id = p_client_id
          AND n.embedding IS NOT NULL
        ORDER BY rrf_score DESC
        LIMIT match_count
    ),

    -- B. HOP 1: Aristas directas de los nodos semilla
    hop1_edges AS (
        SELECT DISTINCT
            e.source_node, e.relation_type, e.target_node, e.context
        FROM knowledge_edges e
        INNER JOIN seed_nodes s ON (e.source_node = s.entity_name OR e.target_node = s.entity_name)
        WHERE e.client_id = p_client_id
    ),

    -- C. HOP 2: Aristas de los nodos descubiertos en Hop 1
    hop1_nodes AS (
        SELECT DISTINCT unnest(ARRAY[source_node, target_node]) as node_name FROM hop1_edges
    ),
    hop2_edges AS (
        SELECT DISTINCT
            e.source_node, e.relation_type, e.target_node, e.context
        FROM knowledge_edges e
        INNER JOIN hop1_nodes h ON (e.source_node = h.node_name OR e.target_node = h.node_name)
        WHERE e.client_id = p_client_id
          AND NOT EXISTS (
              SELECT 1 FROM hop1_edges h1 
              WHERE h1.source_node = e.source_node 
                AND h1.relation_type = e.relation_type 
                AND h1.target_node = e.target_node
          )
        LIMIT 20
    )

    -- D. SALIDA UNIFICADA
    SELECT ('ENTIDAD [' || s.entity_type || ']: ' || s.entity_name || ' — ' || COALESCE(s.description, ''))::text, 
           s.entity_name::text, s.entity_type::text, NULL::text, 0
    FROM seed_nodes s
    UNION ALL
    SELECT (h1.source_node || ' —[' || h1.relation_type || ']→ ' || h1.target_node || COALESCE(' (' || h1.context || ')', ''))::text,
           h1.source_node::text, 'RELACIÓN'::text, h1.relation_type::text, 1
    FROM hop1_edges h1
    UNION ALL
    SELECT (h2.source_node || ' —[' || h2.relation_type || ']→ ' || h2.target_node || COALESCE(' (' || h2.context || ')', ''))::text,
           h2.source_node::text, 'RELACIÓN_EXPANDIDA'::text, h2.relation_type::text, 2
    FROM hop2_edges h2
    ORDER BY hop ASC;
END;
$$;

-- =============================================
-- PARTE 6: ACTUALIZAR match_memories LEGACY (por retrocompatibilidad)
-- =============================================

DROP FUNCTION IF EXISTS public.match_memories(vector, float, int, text);
DROP FUNCTION IF EXISTS public.match_memories(vector, float, int, uuid);

CREATE OR REPLACE FUNCTION match_memories (
  query_embedding vector(768),
  match_threshold float,
  match_count int,
  p_client_id uuid  -- ← UUID correcto
)
RETURNS TABLE (
  content text,
  sender text,
  date text,
  similarity float
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    m.content,
    m.sender,
    (m.metadata->>'date')::text as date,
    1 - (m.embedding <=> query_embedding) AS similarity
  FROM user_memories m
  WHERE m.client_id = p_client_id
    AND m.embedding IS NOT NULL
    AND 1 - (m.embedding <=> query_embedding) > match_threshold
  ORDER BY m.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;
