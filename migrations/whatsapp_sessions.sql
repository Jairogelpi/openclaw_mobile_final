-- Migration: Create whatsapp_sessions table for Baileys persistence
-- This allows moving away from local file-based auth (clients_sessions/) to DB-backed auth.

CREATE TABLE IF NOT EXISTS public.whatsapp_sessions (
    client_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    data_type TEXT NOT NULL, -- 'creds', 'app-state-sync-key', 'session', etc.
    data_id TEXT NOT NULL,   -- The filename or identifier within Baileys
    data_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    PRIMARY KEY (client_id, data_type, data_id)
);

-- Index for faster lookups
CREATE INDEX IF NOT EXISTS idx_whatsapp_sessions_client ON public.whatsapp_sessions(client_id);

-- Enable RLS (Security)
ALTER TABLE public.whatsapp_sessions ENABLE ROW LEVEL SECURITY;

-- Simple policy: only service role or internal backend can touch this for now
-- (Assuming the backend uses the service_role key or bypassing RLS)
