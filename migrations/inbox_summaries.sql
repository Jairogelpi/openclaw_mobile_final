-- ====================================================================
-- OPENCLAW INBOX SUMMARIES SCHEMA
-- Persistent summaries for the card-based Inbox UI
-- ====================================================================

-- Update raw_messages to support conversation grouping
ALTER TABLE public.raw_messages ADD COLUMN IF NOT EXISTS remote_id text;
CREATE INDEX IF NOT EXISTS idx_raw_messages_remote_id ON public.raw_messages(remote_id);

CREATE TABLE IF NOT EXISTS public.inbox_summaries (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    client_id text NOT NULL,
    conversation_id text NOT NULL, -- WhatsApp JID (e.g. 123456789@s.whatsapp.net or group-id@g.us)
    summary text, -- AI generated summary
    last_message_text text,
    contact_name text,
    group_name text,
    sentiment text DEFAULT 'Neutral',
    is_unread boolean DEFAULT true,
    last_updated timestamp with time zone DEFAULT now(),
    
    -- Constraint to ensure one summary per conversation per client
    UNIQUE(client_id, conversation_id)
);

-- Index for fast list retrieval by client
CREATE INDEX IF NOT EXISTS idx_inbox_summaries_client_id ON public.inbox_summaries(client_id);

-- Enable RLS
ALTER TABLE public.inbox_summaries ENABLE ROW LEVEL SECURITY;

-- Allow service role to do everything
CREATE POLICY "Service role full access" ON public.inbox_summaries
    USING (true)
    WITH CHECK (true);
