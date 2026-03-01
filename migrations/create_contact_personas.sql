-- Migration: Create contact_personas table

CREATE TABLE IF NOT EXISTS contact_personas (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    remote_id TEXT NOT NULL,
    persona_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(client_id, remote_id)
);

-- Enable RLS
ALTER TABLE contact_personas ENABLE ROW LEVEL SECURITY;

-- Allow users to manage only their own contact personas
DROP POLICY IF EXISTS "Users can manage their own contact personas" ON contact_personas;

CREATE POLICY "Users can manage their own contact personas"
    ON contact_personas
    FOR ALL
    USING (auth.uid() = client_id);
