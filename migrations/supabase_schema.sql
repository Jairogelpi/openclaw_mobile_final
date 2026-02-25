-- Schema for OpenClaw Memory Engine (Supabase / PostgreSQL)

-- 1. Table for Raw Messages ("Cubo de Basura")
CREATE TABLE IF NOT EXISTS public.raw_messages (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    client_id text NOT NULL,
    sender_role text NOT NULL, -- e.g., 'user', 'contact', '[Grupo: Familia] Mamá'
    content text NOT NULL,
    sentiment text, -- e.g., 'Positive', 'Neutral', 'Aggressive', 'Professional'
    processed boolean DEFAULT false,
    created_at timestamp with time zone DEFAULT now()
);

-- Index for fast querying of unprocessed messages per client
CREATE INDEX IF NOT EXISTS idx_raw_messages_unprocessed 
ON public.raw_messages(client_id) 
WHERE processed = false;

-- 2. Table for Business Clients ("Mundo de Negocio")
CREATE TABLE IF NOT EXISTS public.clients (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id uuid NOT NULL UNIQUE, -- UUID de Supabase Auth
    name text NOT NULL,
    whatsapp_number text,
    created_at timestamp with time zone DEFAULT now()
);

-- Index to find clients owned by a user
CREATE INDEX IF NOT EXISTS idx_clients_user_id ON public.clients(user_id);

-- 3. Table for Agent SOUL ("Cerebro Estructurado")
CREATE TABLE IF NOT EXISTS public.user_souls (
    client_id text PRIMARY KEY,
    owner_id uuid, -- Relación con public.clients.id
    soul_json jsonb NOT NULL DEFAULT '{}'::jsonb,
    last_updated timestamp with time zone DEFAULT now()
);

-- Note: Ensure Row Level Security (RLS) is configured appropriately in the Supabase Dashboard 
-- if clients will access this directly, or use the SERVICE_ROLE_KEY for server-side operations.

-- 3. Migration: Add port and slug columns for Multi-Tenant SaaS
-- Run this once in your Supabase SQL Editor:
ALTER TABLE public.user_souls ADD COLUMN IF NOT EXISTS port integer UNIQUE;
ALTER TABLE public.user_souls ADD COLUMN IF NOT EXISTS slug text UNIQUE;
ALTER TABLE public.user_souls ADD COLUMN IF NOT EXISTS last_active timestamp with time zone DEFAULT now();

-- 4. Vector Memory (RAG) Infrastructure
-- Habilitar la extensión de vectores
CREATE EXTENSION IF NOT EXISTS vector;

-- Tabla para fragmentos de memoria eterna con embeddings
CREATE TABLE IF NOT EXISTS public.user_memories (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    client_id text NOT NULL,
    content text NOT NULL,
    sender text,
    metadata jsonb DEFAULT '{}',
    embedding vector(1536), -- Dimensiones para OpenAI text-embedding-3-small
    created_at timestamp with time zone DEFAULT now()
);

-- Índice para búsqueda ultra rápida (IVFFlat)
CREATE INDEX ON public.user_memories USING ivfflat (embedding vector_cosine_ops)
WITH (lists = 100);

-- Función de búsqueda por relevancia semántica (RAG)
DROP FUNCTION IF EXISTS public.match_memories(vector, float, int, text);
CREATE OR REPLACE FUNCTION match_memories (
  query_embedding vector(1536),
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

-- 5. Tabla de logs del sistema (Watchdog / Self-Healing)
CREATE TABLE IF NOT EXISTS public.system_logs (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    level text NOT NULL DEFAULT 'INFO',    -- INFO, WARN, ERROR
    message text NOT NULL,
    client_id text,
    created_at timestamp with time zone DEFAULT now()
);

-- 6. Migration: Add restart_count for Watchdog dashboard
ALTER TABLE public.user_souls 
ADD COLUMN IF NOT EXISTS restart_count integer DEFAULT 0;
