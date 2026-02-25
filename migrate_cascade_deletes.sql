-- Migration: Implement Cascading Deletes (Final Standardized + HYPER Type Safety)
-- This script converts the database to use UUID-based foreign keys.
-- We use ::text::uuid casting to handle any starting state (text or uuid).

BEGIN;

-- 1. DATA MIGRATION: Replace slugs with client_id in child tables.
-- We use s.client_id::text::uuid to be valid whether the target is text or uuid.
-- We use ::text on the WHERE clause to handle comparisons regardless of column type.

UPDATE public.raw_messages r
SET client_id = s.client_id::text::uuid
FROM public.user_souls s
WHERE r.client_id::text = s.slug::text;

UPDATE public.user_memories m
SET client_id = s.client_id::text::uuid
FROM public.user_souls s
WHERE m.client_id::text = s.slug::text;

UPDATE public.system_logs l
SET client_id = s.client_id::text::uuid
FROM public.user_souls s
WHERE l.client_id::text = s.slug::text;

-- 2. CLEANUP: Remove logs that don't match a valid client.
-- Casting EVERYTHING to text in the subquery and filter for ultimate safety.
DELETE FROM public.system_logs 
WHERE client_id::text NOT IN (SELECT client_id::text FROM public.user_souls);

-- 3. SCHEMA: Link public.clients to public.users and fixed ON CONFLICT
ALTER TABLE public.clients
DROP CONSTRAINT IF EXISTS clients_user_id_fkey,
DROP CONSTRAINT IF EXISTS clients_user_id_key;

DELETE FROM public.clients a USING public.clients b 
WHERE a.id < b.id AND a.user_id = b.user_id;

ALTER TABLE public.clients
ADD CONSTRAINT clients_user_id_key UNIQUE (user_id);

ALTER TABLE public.clients
ADD CONSTRAINT clients_user_id_fkey 
FOREIGN KEY (user_id) 
REFERENCES public.users(id) 
ON DELETE CASCADE;

-- 4. SCHEMA: Standardize user_souls.client_id to UUID
-- Using cast explicitly in the ALTER command
ALTER TABLE public.user_souls 
ALTER COLUMN client_id TYPE uuid USING client_id::text::uuid;

ALTER TABLE public.user_souls
DROP CONSTRAINT IF EXISTS user_souls_client_id_fkey,
ADD CONSTRAINT user_souls_client_id_fkey 
FOREIGN KEY (client_id) 
REFERENCES public.users(id) 
ON DELETE CASCADE;

-- 5. SCHEMA: Standardize child tables to UUID and add Cascade
ALTER TABLE public.raw_messages
DROP CONSTRAINT IF EXISTS fk_raw_messages_soul,
ALTER COLUMN client_id TYPE uuid USING client_id::text::uuid;

ALTER TABLE public.raw_messages
ADD CONSTRAINT fk_raw_messages_soul 
FOREIGN KEY (client_id) 
REFERENCES public.user_souls(client_id) 
ON DELETE CASCADE;

ALTER TABLE public.user_memories
DROP CONSTRAINT IF EXISTS fk_user_memories_soul,
ALTER COLUMN client_id TYPE uuid USING client_id::text::uuid;

ALTER TABLE public.user_memories
ADD CONSTRAINT fk_user_memories_soul 
FOREIGN KEY (client_id) 
REFERENCES public.user_souls(client_id) 
ON DELETE CASCADE;

ALTER TABLE public.system_logs
DROP CONSTRAINT IF EXISTS system_logs_client_id_fkey,
ALTER COLUMN client_id TYPE uuid USING client_id::text::uuid;

ALTER TABLE public.system_logs
ADD CONSTRAINT system_logs_client_id_fkey 
FOREIGN KEY (client_id) 
REFERENCES public.user_souls(client_id) 
ON DELETE CASCADE;

COMMIT;
