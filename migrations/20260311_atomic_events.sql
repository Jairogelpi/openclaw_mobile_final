create table if not exists atomic_events (
    id bigserial primary key,
    client_id text not null,
    raw_message_id text not null,
    message_id text null,
    remote_id text null,
    speaker text null,
    speaker_role text null,
    event_timestamp timestamptz null,
    reply_to text null,
    quoted_span text null,
    media_type text null,
    direct_text text not null,
    normalized_text text not null,
    entities jsonb not null default '[]'::jsonb,
    topics jsonb not null default '[]'::jsonb,
    claims jsonb not null default '[]'::jsonb,
    source_metadata jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create unique index if not exists atomic_events_client_raw_message_uidx
    on atomic_events (client_id, raw_message_id);

create index if not exists atomic_events_client_remote_time_idx
    on atomic_events (client_id, remote_id, event_timestamp desc);

create index if not exists atomic_events_client_time_idx
    on atomic_events (client_id, event_timestamp desc);

create index if not exists atomic_events_client_role_time_idx
    on atomic_events (client_id, remote_id, speaker_role, event_timestamp desc);

create index if not exists atomic_events_reply_to_idx
    on atomic_events (client_id, reply_to);

create index if not exists atomic_events_entities_gin_idx
    on atomic_events using gin (entities jsonb_path_ops);

create index if not exists atomic_events_topics_gin_idx
    on atomic_events using gin (topics jsonb_path_ops);

create index if not exists atomic_events_claims_gin_idx
    on atomic_events using gin (claims jsonb_path_ops);

create index if not exists atomic_events_lexical_gin_idx
    on atomic_events using gin (
        to_tsvector(
            'simple',
            coalesce(direct_text, '') || ' ' || coalesce(normalized_text, '')
        )
    );
