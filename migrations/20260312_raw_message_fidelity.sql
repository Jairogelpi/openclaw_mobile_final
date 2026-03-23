alter table public.raw_messages
    add column if not exists semantic_text text,
    add column if not exists channel text,
    add column if not exists source_message_id text,
    add column if not exists event_timestamp timestamptz,
    add column if not exists participant_jid text,
    add column if not exists canonical_sender_name text,
    add column if not exists conversation_name text,
    add column if not exists is_group boolean default false,
    add column if not exists is_history boolean default false,
    add column if not exists message_type text,
    add column if not exists quoted_message_id text,
    add column if not exists has_media boolean default false,
    add column if not exists media_type text,
    add column if not exists media_mime_type text,
    add column if not exists media_caption text,
    add column if not exists media_status text default 'none',
    add column if not exists enrichment_status text default 'ready',
    add column if not exists content_ready boolean default true,
    add column if not exists delivery_status text;

update public.raw_messages
set
    channel = coalesce(channel, nullif(metadata->>'channel', ''), case
        when remote_id ~ '(@s\.whatsapp\.net|@g\.us|@lid)$' or coalesce(metadata->>'participantJid', '') ~ '(@s\.whatsapp\.net|@g\.us|@lid)$'
            then 'whatsapp'
        else null
    end),
    source_message_id = coalesce(source_message_id, nullif(metadata->>'msgId', '')),
    event_timestamp = coalesce(event_timestamp, nullif(metadata->>'timestamp', '')::timestamptz, created_at),
    participant_jid = coalesce(participant_jid, nullif(metadata->>'participantJid', '')),
    canonical_sender_name = coalesce(canonical_sender_name, nullif(metadata->>'canonicalSenderName', '')),
    conversation_name = coalesce(conversation_name, nullif(metadata->>'conversationName', '')),
    is_group = case
        when is_group = true then true
        else coalesce((metadata->>'isGroup')::boolean, remote_id like '%@g.us', false)
    end,
    is_history = case
        when is_history = true then true
        else coalesce((metadata->>'isHistory')::boolean, (metadata->>'historical')::boolean, false)
    end,
    quoted_message_id = coalesce(quoted_message_id, nullif(metadata->>'quotedMessageId', '')),
    delivery_status = coalesce(delivery_status, nullif(metadata->>'status', '')),
    media_type = coalesce(media_type, case
        when metadata ? 'mediaPayload' and metadata#>'{mediaPayload,imageMessage}' is not null then 'image'
        when metadata ? 'mediaPayload' and metadata#>'{mediaPayload,audioMessage}' is not null then 'audio'
        when metadata ? 'mediaPayload' and metadata#>'{mediaPayload,videoMessage}' is not null then 'video'
        when metadata ? 'mediaPayload' and metadata#>'{mediaPayload,documentMessage}' is not null then 'document'
        when metadata ? 'mediaPayload' and metadata#>'{mediaPayload,stickerMessage}' is not null then 'sticker'
        when content ~* '^\[(imagen|foto)' then 'image'
        when content ~* '^\[(audio|nota de voz)' then 'audio'
        when content ~* '^\[(video)' then 'video'
        when content ~* '^\[(documento|archivo|pdf)' then 'document'
        when content ~* '^\[(sticker)' then 'sticker'
        else null
    end),
    media_mime_type = coalesce(
        media_mime_type,
        nullif(metadata#>>'{mediaPayload,imageMessage,mimetype}', ''),
        nullif(metadata#>>'{mediaPayload,audioMessage,mimetype}', ''),
        nullif(metadata#>>'{mediaPayload,videoMessage,mimetype}', ''),
        nullif(metadata#>>'{mediaPayload,documentMessage,mimetype}', ''),
        nullif(metadata#>>'{mediaPayload,stickerMessage,mimetype}', '')
    ),
    media_caption = coalesce(
        media_caption,
        nullif(metadata#>>'{mediaPayload,imageMessage,caption}', ''),
        nullif(metadata#>>'{mediaPayload,videoMessage,caption}', ''),
        nullif(metadata#>>'{mediaPayload,documentMessage,caption}', '')
    ),
    has_media = case
        when has_media = true then true
        else ((metadata ? 'mediaPayload') or content ~* '^\[(imagen|foto|audio|video|documento|archivo|pdf|sticker)')
    end,
    message_type = coalesce(message_type, case
        when metadata ? 'generated_by' then 'assistant_text'
        when metadata ? 'mediaPayload' and metadata#>'{mediaPayload,imageMessage}' is not null then 'image'
        when metadata ? 'mediaPayload' and metadata#>'{mediaPayload,audioMessage}' is not null then 'audio'
        when metadata ? 'mediaPayload' and metadata#>'{mediaPayload,videoMessage}' is not null then 'video'
        when metadata ? 'mediaPayload' and metadata#>'{mediaPayload,documentMessage}' is not null then 'document'
        when metadata ? 'mediaPayload' and metadata#>'{mediaPayload,stickerMessage}' is not null then 'sticker'
        else 'text'
    end);

update public.raw_messages
set semantic_text = case
    when semantic_text is not null and btrim(semantic_text) <> '' then semantic_text
    when content ~* '^\[(imagen|foto|audio|video|documento|archivo|pdf|sticker)(:[^\]]+)?\]$' then null
    when btrim(content) <> '' then btrim(content)
    when media_caption is not null and btrim(media_caption) <> '' then btrim(media_caption)
    else null
end
where semantic_text is null;

update public.raw_messages
set
    content_ready = case
        when semantic_text is not null and btrim(semantic_text) <> '' then true
        when has_media then false
        else true
    end,
    media_status = case
        when has_media and semantic_text is not null and btrim(semantic_text) <> '' then 'captured'
        when has_media then 'pending'
        else 'none'
    end,
    enrichment_status = case
        when has_media and semantic_text is not null and btrim(semantic_text) <> '' then 'pending'
        when has_media then 'pending'
        else 'ready'
    end
where true;

update public.raw_messages
set processed = false
where has_media = true
  and metadata ? 'mediaPayload'
  and (semantic_text is null or btrim(semantic_text) = '')
  and processed = true;

update public.raw_messages
set
    processed = true,
    media_status = 'placeholder_only',
    enrichment_status = 'unrecoverable'
where has_media = true
  and not (metadata ? 'mediaPayload')
  and (semantic_text is null or btrim(semantic_text) = '');

create index if not exists idx_raw_messages_client_event_timestamp
    on public.raw_messages (client_id, coalesce(event_timestamp, created_at) desc);

create index if not exists idx_raw_messages_client_remote_event_timestamp
    on public.raw_messages (client_id, remote_id, coalesce(event_timestamp, created_at) desc);

create index if not exists idx_raw_messages_source_message_id
    on public.raw_messages (client_id, source_message_id);

create index if not exists idx_raw_messages_ready_for_processing
    on public.raw_messages (client_id, coalesce(event_timestamp, created_at) desc)
    where processed = false and coalesce(content_ready, true) = true;

create index if not exists idx_raw_messages_pending_media_enrichment
    on public.raw_messages (client_id, coalesce(event_timestamp, created_at) desc)
    where has_media = true
      and (
          coalesce(content_ready, false) = false
          or coalesce(enrichment_status, 'pending') in ('pending', 'failed')
      );

create or replace function public.update_raw_message_status(
    p_client_id text,
    p_msg_id text,
    p_status text
)
returns void
language plpgsql
as $$
begin
    update public.raw_messages
    set
        delivery_status = p_status,
        metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object('status', p_status)
    where client_id = p_client_id
      and (
          source_message_id = p_msg_id
          or metadata->>'msgId' = p_msg_id
      );
end;
$$;
