-- 1. Borrar la función vieja
DROP FUNCTION IF EXISTS public.match_memories(vector, float, int, text);

-- 2. Adaptar la tabla a las 768 dimensiones del modelo local Nomic
ALTER TABLE public.user_memories DROP COLUMN IF EXISTS embedding;
ALTER TABLE public.user_memories ADD COLUMN embedding vector(768);

-- 3. Crear el índice optimizado para búsquedas
CREATE INDEX ON public.user_memories USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

-- 4. Recrear la función de búsqueda (ahora recibe un vector 768)
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
    AND 1 - (m.embedding <=> query_embedding) > match_threshold
  ORDER BY m.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;
