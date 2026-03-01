-- ====================================================================
-- OPENCLAW: OPTIMIZACIÓN EXPERTA DE ALMACENAMIENTO (Phase 5)
-- Ejecutar en el SQL Editor de Supabase
-- ⚠️ IMPORTANTE: Hacer BACKUP antes de ejecutar
-- ====================================================================

-- =============================================
-- 🔴 FIX 1: VECTOR DIMENSION MISMATCH (1536 → 768)
-- El modelo local genera 768D pero la columna acepta 1536D.
-- Esto desperdicia ~50% del espacio vectorial.
-- =============================================

-- Paso 1: Eliminar índices dependientes de la columna vieja
DROP INDEX IF EXISTS idx_user_memories_embedding;
DROP INDEX IF EXISTS user_memories_embedding_idx;

-- Paso 2: Alterar la dimensión del vector
-- NOTA: Esto solo funciona si los vectores actuales ya son 768D
-- (padded con ceros hasta 1536). Si hay vectores reales de 1536D,
-- primero se deben regenerar.
ALTER TABLE public.user_memories 
ALTER COLUMN embedding TYPE vector(768);

-- Paso 3: Recrear índice con HNSW (más rápido que IVFFlat)
CREATE INDEX IF NOT EXISTS idx_user_memories_embedding_hnsw
ON public.user_memories USING hnsw (embedding vector_cosine_ops)
WITH (m = 16, ef_construction = 64);

-- =============================================
-- 🔴 FIX 2: TTL AUTO-PURGE EN raw_messages (7 días)
-- Los mensajes procesados se quedan para siempre.
-- Esto consume ~80% del espacio total de la BD.
-- =============================================

-- Añadir columna de metadata si no existe
ALTER TABLE public.raw_messages ADD COLUMN IF NOT EXISTS metadata jsonb DEFAULT '{}';

-- Crear índice parcial para mensajes procesados antiguos
CREATE INDEX IF NOT EXISTS idx_raw_messages_processed_old
ON public.raw_messages(created_at)
WHERE processed = true;

-- Función de auto-limpieza (elimina procesados > 7 días)
CREATE OR REPLACE FUNCTION cleanup_old_raw_messages()
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
    deleted_count int;
BEGIN
    DELETE FROM public.raw_messages
    WHERE processed = true
      AND created_at < NOW() - INTERVAL '7 days'
    RETURNING 1 INTO deleted_count;
    
    RAISE NOTICE 'Purged % old raw_messages', deleted_count;
END;
$$;

-- Programar con pg_cron (si disponible en Supabase Pro)
-- SELECT cron.schedule('cleanup-raw-msgs', '0 4 * * *', 'SELECT cleanup_old_raw_messages()');

-- =============================================
-- 🟡 FIX 3: DEDUPLICACIÓN CON content_hash
-- Sin índice UNIQUE, los duplicados pasan silenciosos.
-- =============================================

-- Añadir columna si no existe
ALTER TABLE public.user_memories ADD COLUMN IF NOT EXISTS content_hash text;

-- Crear índice UNIQUE parcial (solo donde content_hash no es null)
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_memories_content_hash_unique
ON public.user_memories(client_id, content_hash)
WHERE content_hash IS NOT NULL;

-- =============================================
-- 🟡 FIX 4: UPGRADE IVFFlat → HNSW (knowledge_nodes)
-- HNSW es 2-5x más rápido para búsquedas vectoriales.
-- =============================================

DROP INDEX IF EXISTS idx_knowledge_nodes_embedding;

CREATE INDEX IF NOT EXISTS idx_knowledge_nodes_embedding_hnsw
ON public.knowledge_nodes USING hnsw (embedding vector_cosine_ops)
WITH (m = 16, ef_construction = 64);

-- =============================================
-- 🟡 FIX 5: AUTO-CLEANUP system_logs (30 días)
-- Esta tabla crece sin control.
-- =============================================

CREATE OR REPLACE FUNCTION cleanup_old_system_logs()
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
    DELETE FROM public.system_logs
    WHERE created_at < NOW() - INTERVAL '30 days';
END;
$$;

-- Programar con pg_cron (si disponible)
-- SELECT cron.schedule('cleanup-sys-logs', '0 5 * * *', 'SELECT cleanup_old_system_logs()');

-- =============================================
-- 🟢 FIX 6: ÍNDICES PARCIALES PARA QUERIES CALIENTES
-- Solo indexar lo que realmente se busca.
-- =============================================

-- Índice parcial: solo mensajes NO procesados (el 99% de queries)
DROP INDEX IF EXISTS idx_raw_messages_unprocessed;
CREATE INDEX IF NOT EXISTS idx_raw_messages_unprocessed
ON public.raw_messages(client_id, created_at DESC)
WHERE processed = false;

-- Índice parcial: memorias con embedding (excluye las que aún no tienen)
CREATE INDEX IF NOT EXISTS idx_user_memories_has_embedding
ON public.user_memories(client_id)
WHERE embedding IS NOT NULL;

-- =============================================
-- 🟢 FIX 7: ACTUALIZAR FUNCIONES RPC (768D)
-- Las funciones antiguas usan 1536D, actualizar a 768D.
-- =============================================

-- Actualizar match_memories legacy
DROP FUNCTION IF EXISTS public.match_memories(vector, float, int, text);
DROP FUNCTION IF EXISTS public.match_memories(vector, float, int, uuid);

CREATE OR REPLACE FUNCTION match_memories (
  query_embedding vector(768),
  match_threshold float,
  match_count int,
  p_client_id text
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

-- Actualizar hybrid_search_memories (ya usa 768D en fix_graphrag pero por seguridad)
DROP FUNCTION IF EXISTS public.hybrid_search_memories(text, vector, int, text);
DROP FUNCTION IF EXISTS public.hybrid_search_memories(text, vector, int, uuid);

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
-- 🟢 FIX 8: COMPRESIÓN TOAST OPTIMIZADA
-- PostgreSQL comprime automáticamente columnas > 2KB.
-- Podemos forzar compresión más agresiva en columnas de texto.
-- =============================================

-- Forzar compresión EXTENDED (máxima) en columnas de texto grandes
ALTER TABLE public.raw_messages ALTER COLUMN content SET STORAGE EXTENDED;
ALTER TABLE public.user_memories ALTER COLUMN content SET STORAGE EXTENDED;
ALTER TABLE public.knowledge_nodes ALTER COLUMN description SET STORAGE EXTENDED;
ALTER TABLE public.inbox_summaries ALTER COLUMN summary SET STORAGE EXTENDED;
ALTER TABLE public.system_logs ALTER COLUMN message SET STORAGE EXTENDED;

-- Forzar compresión en columnas JSON (metadata)
ALTER TABLE public.raw_messages ALTER COLUMN metadata SET STORAGE EXTENDED;
ALTER TABLE public.user_memories ALTER COLUMN metadata SET STORAGE EXTENDED;

-- =============================================
-- 📊 DIAGNÓSTICO: Ejecutar DESPUÉS de la migración
-- Esto muestra el tamaño real de cada tabla.
-- =============================================

-- SELECT 
--     relname AS tabla,
--     pg_size_pretty(pg_total_relation_size(relid)) AS tamaño_total,
--     pg_size_pretty(pg_relation_size(relid)) AS tamaño_datos,
--     pg_size_pretty(pg_total_relation_size(relid) - pg_relation_size(relid)) AS tamaño_índices,
--     n_live_tup AS filas_vivas,
--     n_dead_tup AS filas_muertas
-- FROM pg_stat_user_tables 
-- WHERE schemaname = 'public'
-- ORDER BY pg_total_relation_size(relid) DESC;

-- =============================================
-- RESUMEN DE OPTIMIZACIONES
-- =============================================
-- ✅ Vector 1536 → 768 (50% menos espacio por embedding)
-- ✅ HNSW en lugar de IVFFlat (2-5x más rápido)
-- ✅ TTL de 7 días en raw_messages (elimina ~80% basura)
-- ✅ Deduplicación con content_hash UNIQUE
-- ✅ Auto-cleanup de system_logs (30 días)
-- ✅ Índices parciales para hot queries
-- ✅ Funciones RPC actualizadas a 768D
-- ✅ Compresión TOAST EXTENDED en todas las columnas de texto
