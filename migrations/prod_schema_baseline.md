# Production Schema Baseline

Generated at: 2026-03-12T17:35:03.254Z
Database host: db.hffipuknqnxuhbgzvsxx.supabase.co
Database name: postgres
Schema: public

## Tables

- atomic_events (row_estimate=3806)
- clients (row_estimate=1)
- contact_identities (row_estimate=70)
- contact_personas (row_estimate=0)
- entity_mentions (row_estimate=278)
- inbox_summaries (row_estimate=0)
- knowledge_communities (row_estimate=4)
- knowledge_edges (row_estimate=2)
- knowledge_nodes (row_estimate=261)
- node_communities (row_estimate=39)
- rag_eval_cases (row_estimate=68)
- rag_eval_runs (row_estimate=8)
- rag_metrics (row_estimate=355)
- raw_messages (row_estimate=4185)
- relation_mentions (row_estimate=6)
- system_config (row_estimate=19)
- system_logs (row_estimate=7)
- user_memories (row_estimate=775)
- user_souls (row_estimate=1)
- users (row_estimate=1)
- whatsapp_sessions (row_estimate=1697)

## atomic_events

Estimated rows: 3806

| # | Column | Type | Nullable | Default |
| --- | --- | --- | --- | --- |
| 1 | id | bigint | NO | nextval('atomic_events_id_seq'::regclass) |
| 2 | client_id | text | NO |  |
| 3 | raw_message_id | text | NO |  |
| 4 | message_id | text | YES |  |
| 5 | remote_id | text | YES |  |
| 6 | speaker | text | YES |  |
| 7 | speaker_role | text | YES |  |
| 8 | event_timestamp | timestamp with time zone | YES |  |
| 9 | reply_to | text | YES |  |
| 10 | quoted_span | text | YES |  |
| 11 | media_type | text | YES |  |
| 12 | direct_text | text | NO |  |
| 13 | normalized_text | text | NO |  |
| 14 | entities | jsonb | NO | '[]'::jsonb |
| 15 | topics | jsonb | NO | '[]'::jsonb |
| 16 | claims | jsonb | NO | '[]'::jsonb |
| 17 | source_metadata | jsonb | NO | '{}'::jsonb |
| 18 | created_at | timestamp with time zone | NO | now() |
| 19 | updated_at | timestamp with time zone | NO | now() |

Constraints:
- atomic_events_pkey: PRIMARY KEY (id)

Indexes:
- atomic_events_claims_gin_idx: CREATE INDEX atomic_events_claims_gin_idx ON public.atomic_events USING gin (claims jsonb_path_ops)
- atomic_events_client_raw_message_uidx: CREATE UNIQUE INDEX atomic_events_client_raw_message_uidx ON public.atomic_events USING btree (client_id, raw_message_id)
- atomic_events_client_remote_time_idx: CREATE INDEX atomic_events_client_remote_time_idx ON public.atomic_events USING btree (client_id, remote_id, event_timestamp DESC)
- atomic_events_client_role_time_idx: CREATE INDEX atomic_events_client_role_time_idx ON public.atomic_events USING btree (client_id, remote_id, speaker_role, event_timestamp DESC)
- atomic_events_client_time_idx: CREATE INDEX atomic_events_client_time_idx ON public.atomic_events USING btree (client_id, event_timestamp DESC)
- atomic_events_entities_gin_idx: CREATE INDEX atomic_events_entities_gin_idx ON public.atomic_events USING gin (entities jsonb_path_ops)
- atomic_events_lexical_gin_idx: CREATE INDEX atomic_events_lexical_gin_idx ON public.atomic_events USING gin (to_tsvector('simple'::regconfig, ((COALESCE(direct_text, ''::text) \|\| ' '::text) \|\| COALESCE(normalized_text, ''::text))))
- atomic_events_pkey: CREATE UNIQUE INDEX atomic_events_pkey ON public.atomic_events USING btree (id)
- atomic_events_reply_to_idx: CREATE INDEX atomic_events_reply_to_idx ON public.atomic_events USING btree (client_id, reply_to)
- atomic_events_topics_gin_idx: CREATE INDEX atomic_events_topics_gin_idx ON public.atomic_events USING gin (topics jsonb_path_ops)

## clients

Estimated rows: 1

| # | Column | Type | Nullable | Default |
| --- | --- | --- | --- | --- |
| 1 | id | uuid | NO | gen_random_uuid() |
| 2 | user_id | uuid | YES |  |
| 3 | name | text | NO |  |
| 4 | whatsapp_number | text | YES |  |
| 5 | created_at | timestamp with time zone | YES | CURRENT_TIMESTAMP |

Constraints:
- clients_pkey: PRIMARY KEY (id)
- clients_user_id_fkey: FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
- clients_user_id_key: UNIQUE (user_id)
- clients_user_id_unique: UNIQUE (user_id)

Indexes:
- clients_pkey: CREATE UNIQUE INDEX clients_pkey ON public.clients USING btree (id)
- clients_user_id_key: CREATE UNIQUE INDEX clients_user_id_key ON public.clients USING btree (user_id)
- clients_user_id_unique: CREATE UNIQUE INDEX clients_user_id_unique ON public.clients USING btree (user_id)
- idx_clients_user_id: CREATE INDEX idx_clients_user_id ON public.clients USING btree (user_id)

## contact_identities

Estimated rows: 70

| # | Column | Type | Nullable | Default |
| --- | --- | --- | --- | --- |
| 1 | id | uuid | NO | gen_random_uuid() |
| 2 | client_id | uuid | NO |  |
| 3 | remote_id | text | NO |  |
| 4 | canonical_name | text | NO |  |
| 5 | normalized_name | text | NO |  |
| 6 | aliases | jsonb | NO | '[]'::jsonb |
| 7 | confidence | double precision | NO | 0.5 |
| 8 | source_details | jsonb | NO | '{}'::jsonb |
| 9 | last_verified_at | timestamp with time zone | NO | now() |
| 10 | created_at | timestamp with time zone | NO | now() |
| 11 | updated_at | timestamp with time zone | NO | now() |

Constraints:
- contact_identities_client_id_fkey: FOREIGN KEY (client_id) REFERENCES user_souls(client_id) ON DELETE CASCADE
- contact_identities_client_id_remote_id_key: UNIQUE (client_id, remote_id)
- contact_identities_pkey: PRIMARY KEY (id)

Indexes:
- contact_identities_client_id_remote_id_key: CREATE UNIQUE INDEX contact_identities_client_id_remote_id_key ON public.contact_identities USING btree (client_id, remote_id)
- contact_identities_pkey: CREATE UNIQUE INDEX contact_identities_pkey ON public.contact_identities USING btree (id)
- idx_contact_identities_client_id: CREATE INDEX idx_contact_identities_client_id ON public.contact_identities USING btree (client_id)
- idx_contact_identities_normalized_name: CREATE INDEX idx_contact_identities_normalized_name ON public.contact_identities USING btree (client_id, normalized_name)

## contact_personas

Estimated rows: 0

| # | Column | Type | Nullable | Default |
| --- | --- | --- | --- | --- |
| 1 | id | uuid | NO | gen_random_uuid() |
| 2 | client_id | uuid | NO |  |
| 3 | remote_id | text | NO |  |
| 4 | persona_json | jsonb | NO | '{}'::jsonb |
| 5 | created_at | timestamp with time zone | YES | now() |
| 6 | updated_at | timestamp with time zone | YES | now() |
| 7 | display_name | text | YES |  |

Constraints:
- contact_personas_client_id_fkey: FOREIGN KEY (client_id) REFERENCES user_souls(client_id) ON DELETE CASCADE
- contact_personas_client_id_remote_id_key: UNIQUE (client_id, remote_id)
- contact_personas_pkey: PRIMARY KEY (id)

Indexes:
- contact_personas_client_id_remote_id_key: CREATE UNIQUE INDEX contact_personas_client_id_remote_id_key ON public.contact_personas USING btree (client_id, remote_id)
- contact_personas_pkey: CREATE UNIQUE INDEX contact_personas_pkey ON public.contact_personas USING btree (id)

## entity_mentions

Estimated rows: 278

| # | Column | Type | Nullable | Default |
| --- | --- | --- | --- | --- |
| 1 | id | uuid | NO | gen_random_uuid() |
| 2 | client_id | uuid | NO |  |
| 3 | entity_name | text | NO |  |
| 4 | entity_type | text | NO | 'ENTITY'::text |
| 5 | description | text | YES |  |
| 6 | remote_id | text | YES |  |
| 7 | support_count | integer | NO | 0 |
| 8 | stable_score | double precision | NO | 0 |
| 9 | stability_tier | text | NO | 'candidate'::text |
| 10 | source_tags | jsonb | NO | '[]'::jsonb |
| 11 | metadata | jsonb | NO | '{}'::jsonb |
| 12 | promoted_to_graph | boolean | NO | false |
| 13 | promoted_node_id | uuid | YES |  |
| 14 | first_seen | timestamp with time zone | NO | now() |
| 15 | last_seen | timestamp with time zone | NO | now() |
| 16 | created_at | timestamp with time zone | NO | now() |
| 17 | updated_at | timestamp with time zone | NO | now() |

Constraints:
- entity_mentions_client_id_entity_name_key: UNIQUE (client_id, entity_name)
- entity_mentions_client_id_fkey: FOREIGN KEY (client_id) REFERENCES user_souls(client_id) ON DELETE CASCADE
- entity_mentions_pkey: PRIMARY KEY (id)
- entity_mentions_promoted_node_id_fkey: FOREIGN KEY (promoted_node_id) REFERENCES knowledge_nodes(id) ON DELETE SET NULL

Indexes:
- entity_mentions_client_id_entity_name_key: CREATE UNIQUE INDEX entity_mentions_client_id_entity_name_key ON public.entity_mentions USING btree (client_id, entity_name)
- entity_mentions_pkey: CREATE UNIQUE INDEX entity_mentions_pkey ON public.entity_mentions USING btree (id)
- idx_entity_mentions_client_id: CREATE INDEX idx_entity_mentions_client_id ON public.entity_mentions USING btree (client_id)
- idx_entity_mentions_tier: CREATE INDEX idx_entity_mentions_tier ON public.entity_mentions USING btree (client_id, stability_tier, support_count DESC)

## inbox_summaries

Estimated rows: 0

| # | Column | Type | Nullable | Default |
| --- | --- | --- | --- | --- |
| 1 | id | uuid | NO | gen_random_uuid() |
| 2 | client_id | uuid | NO |  |
| 3 | conversation_id | text | NO |  |
| 4 | summary | text | YES |  |
| 5 | last_message_text | text | YES |  |
| 6 | contact_name | text | YES |  |
| 7 | group_name | text | YES |  |
| 8 | sentiment | text | YES | 'Neutral'::text |
| 9 | is_unread | boolean | YES | true |
| 10 | last_updated | timestamp with time zone | YES | now() |
| 11 | avatar_url | text | YES |  |
| 12 | first_message_time | timestamp with time zone | YES |  |
| 13 | last_message_time | timestamp with time zone | YES |  |
| 14 | topic_label | text | YES | 'General'::text |

Constraints:
- inbox_summaries_client_conversation_key: UNIQUE (client_id, conversation_id)
- inbox_summaries_client_id_fkey: FOREIGN KEY (client_id) REFERENCES user_souls(client_id) ON DELETE CASCADE
- inbox_summaries_pkey: PRIMARY KEY (id)
- unique_inbox_topic: UNIQUE (client_id, conversation_id, topic_label)

Indexes:
- idx_inbox_summaries_client_id: CREATE INDEX idx_inbox_summaries_client_id ON public.inbox_summaries USING btree (client_id)
- inbox_summaries_client_conversation_key: CREATE UNIQUE INDEX inbox_summaries_client_conversation_key ON public.inbox_summaries USING btree (client_id, conversation_id)
- inbox_summaries_pkey: CREATE UNIQUE INDEX inbox_summaries_pkey ON public.inbox_summaries USING btree (id)
- unique_inbox_topic: CREATE UNIQUE INDEX unique_inbox_topic ON public.inbox_summaries USING btree (client_id, conversation_id, topic_label)

## knowledge_communities

Estimated rows: 4

| # | Column | Type | Nullable | Default |
| --- | --- | --- | --- | --- |
| 1 | id | uuid | NO | gen_random_uuid() |
| 2 | client_id | uuid | YES |  |
| 3 | community_name | text | NO |  |
| 4 | summary | text | YES |  |
| 5 | temporal_horizon | text | YES |  |
| 6 | created_at | timestamp with time zone | NO | timezone('utc'::text, now()) |
| 7 | updated_at | timestamp with time zone | NO | timezone('utc'::text, now()) |

Constraints:
- knowledge_communities_client_id_fkey: FOREIGN KEY (client_id) REFERENCES auth.users(id) ON DELETE CASCADE
- knowledge_communities_pkey: PRIMARY KEY (id)

Indexes:
- knowledge_communities_pkey: CREATE UNIQUE INDEX knowledge_communities_pkey ON public.knowledge_communities USING btree (id)

## knowledge_edges

Estimated rows: 2

| # | Column | Type | Nullable | Default |
| --- | --- | --- | --- | --- |
| 1 | id | uuid | NO | gen_random_uuid() |
| 2 | client_id | uuid | NO |  |
| 3 | source_node | text | NO |  |
| 4 | relation_type | text | NO |  |
| 5 | target_node | text | NO |  |
| 6 | context | text | YES |  |
| 7 | created_at | timestamp with time zone | YES | now() |
| 8 | weight | integer | YES | 1 |
| 9 | last_seen | timestamp with time zone | YES | now() |
| 10 | cognitive_flags | ARRAY | YES | '{}'::text[] |
| 11 | support_count | integer | NO | 1 |
| 12 | stable_score | double precision | NO | 0 |
| 13 | stability_tier | text | NO | 'candidate'::text |
| 14 | source_tags | ARRAY | NO | '{}'::text[] |

Constraints:
- fk_edges_client: FOREIGN KEY (client_id) REFERENCES user_souls(client_id) ON DELETE CASCADE
- knowledge_edges_client_id_source_node_relation_type_target__key: UNIQUE (client_id, source_node, relation_type, target_node)
- knowledge_edges_pkey: PRIMARY KEY (id)
- uq_edges_triplet: UNIQUE (client_id, source_node, relation_type, target_node)

Indexes:
- idx_knowledge_edges_client: CREATE INDEX idx_knowledge_edges_client ON public.knowledge_edges USING btree (client_id)
- idx_knowledge_edges_source: CREATE INDEX idx_knowledge_edges_source ON public.knowledge_edges USING btree (source_node)
- idx_knowledge_edges_source_tags: CREATE INDEX idx_knowledge_edges_source_tags ON public.knowledge_edges USING gin (source_tags)
- idx_knowledge_edges_stability: CREATE INDEX idx_knowledge_edges_stability ON public.knowledge_edges USING btree (client_id, stability_tier, stable_score DESC)
- idx_knowledge_edges_target: CREATE INDEX idx_knowledge_edges_target ON public.knowledge_edges USING btree (target_node)
- idx_knowledge_edges_weight: CREATE INDEX idx_knowledge_edges_weight ON public.knowledge_edges USING btree (weight DESC)
- knowledge_edges_client_id_source_node_relation_type_target__key: CREATE UNIQUE INDEX knowledge_edges_client_id_source_node_relation_type_target__key ON public.knowledge_edges USING btree (client_id, source_node, relation_type, target_node)
- knowledge_edges_pkey: CREATE UNIQUE INDEX knowledge_edges_pkey ON public.knowledge_edges USING btree (id)
- uq_edges_triplet: CREATE UNIQUE INDEX uq_edges_triplet ON public.knowledge_edges USING btree (client_id, source_node, relation_type, target_node)

## knowledge_nodes

Estimated rows: 261

| # | Column | Type | Nullable | Default |
| --- | --- | --- | --- | --- |
| 1 | id | uuid | NO | gen_random_uuid() |
| 2 | client_id | uuid | NO |  |
| 3 | entity_name | text | NO |  |
| 4 | entity_type | text | NO |  |
| 5 | description | text | YES |  |
| 6 | embedding | vector | YES |  |
| 7 | fts | tsvector | YES |  |
| 8 | created_at | timestamp with time zone | YES | now() |
| 9 | support_count | integer | NO | 1 |
| 10 | stable_score | double precision | NO | 0 |
| 11 | stability_tier | text | NO | 'candidate'::text |
| 12 | last_seen | timestamp with time zone | YES | now() |
| 13 | source_tags | ARRAY | NO | '{}'::text[] |

Constraints:
- fk_nodes_client: FOREIGN KEY (client_id) REFERENCES user_souls(client_id) ON DELETE CASCADE
- knowledge_nodes_client_id_entity_name_key: UNIQUE (client_id, entity_name)
- knowledge_nodes_pkey: PRIMARY KEY (id)
- uq_nodes_entity: UNIQUE (client_id, entity_name)

Indexes:
- idx_knowledge_nodes_client: CREATE INDEX idx_knowledge_nodes_client ON public.knowledge_nodes USING btree (client_id)
- idx_knowledge_nodes_embedding_hnsw: CREATE INDEX idx_knowledge_nodes_embedding_hnsw ON public.knowledge_nodes USING hnsw (embedding vector_cosine_ops) WITH (m='16', ef_construction='64')
- idx_knowledge_nodes_fts: CREATE INDEX idx_knowledge_nodes_fts ON public.knowledge_nodes USING gin (fts)
- idx_knowledge_nodes_source_tags: CREATE INDEX idx_knowledge_nodes_source_tags ON public.knowledge_nodes USING gin (source_tags)
- idx_knowledge_nodes_stability: CREATE INDEX idx_knowledge_nodes_stability ON public.knowledge_nodes USING btree (client_id, stability_tier, stable_score DESC)
- knowledge_nodes_client_id_entity_name_key: CREATE UNIQUE INDEX knowledge_nodes_client_id_entity_name_key ON public.knowledge_nodes USING btree (client_id, entity_name)
- knowledge_nodes_pkey: CREATE UNIQUE INDEX knowledge_nodes_pkey ON public.knowledge_nodes USING btree (id)
- nodes_fts_idx: CREATE INDEX nodes_fts_idx ON public.knowledge_nodes USING gin (fts)
- uq_nodes_entity: CREATE UNIQUE INDEX uq_nodes_entity ON public.knowledge_nodes USING btree (client_id, entity_name)

## node_communities

Estimated rows: 39

| # | Column | Type | Nullable | Default |
| --- | --- | --- | --- | --- |
| 1 | node_id | uuid | NO |  |
| 2 | community_id | uuid | NO |  |

Constraints:
- node_communities_community_id_fkey: FOREIGN KEY (community_id) REFERENCES knowledge_communities(id) ON DELETE CASCADE
- node_communities_node_id_fkey: FOREIGN KEY (node_id) REFERENCES knowledge_nodes(id) ON DELETE CASCADE
- node_communities_pkey: PRIMARY KEY (node_id, community_id)

Indexes:
- node_communities_pkey: CREATE UNIQUE INDEX node_communities_pkey ON public.node_communities USING btree (node_id, community_id)

## rag_eval_cases

Estimated rows: 68

| # | Column | Type | Nullable | Default |
| --- | --- | --- | --- | --- |
| 1 | id | uuid | NO | gen_random_uuid() |
| 2 | client_id | uuid | NO |  |
| 3 | category | text | NO |  |
| 4 | query | text | NO |  |
| 5 | expected_mode | text | NO | 'answer'::text |
| 6 | expected_entities | jsonb | NO | '[]'::jsonb |
| 7 | expected_remote_ids | jsonb | NO | '[]'::jsonb |
| 8 | expected_substrings | jsonb | NO | '[]'::jsonb |
| 9 | expected_time_start | timestamp with time zone | YES |  |
| 10 | expected_time_end | timestamp with time zone | YES |  |
| 11 | notes | jsonb | NO | '{}'::jsonb |
| 12 | active | boolean | NO | true |
| 13 | created_at | timestamp with time zone | NO | now() |
| 14 | style_tag | text | YES | 'general'::text |
| 15 | expected_citation_min | integer | YES | 1 |
| 16 | expected_evidence_kinds | jsonb | NO | '[]'::jsonb |
| 17 | expected_verdict_detail | text | YES |  |
| 18 | expected_memory_ids | jsonb | NO | '[]'::jsonb |
| 19 | expected_edge_keys | jsonb | NO | '[]'::jsonb |
| 20 | expected_media_kind | text | YES |  |
| 21 | expected_speaker | text | YES |  |

Constraints:
- rag_eval_cases_client_id_fkey: FOREIGN KEY (client_id) REFERENCES user_souls(client_id) ON DELETE CASCADE
- rag_eval_cases_pkey: PRIMARY KEY (id)

Indexes:
- idx_rag_eval_cases_client_id: CREATE INDEX idx_rag_eval_cases_client_id ON public.rag_eval_cases USING btree (client_id, active)
- rag_eval_cases_pkey: CREATE UNIQUE INDEX rag_eval_cases_pkey ON public.rag_eval_cases USING btree (id)

## rag_eval_runs

Estimated rows: 8

| # | Column | Type | Nullable | Default |
| --- | --- | --- | --- | --- |
| 1 | id | uuid | NO | gen_random_uuid() |
| 2 | client_id | uuid | NO |  |
| 3 | run_name | text | NO |  |
| 4 | total_cases | integer | NO | 0 |
| 5 | passed_cases | integer | NO | 0 |
| 6 | precision_at_k | double precision | NO | 0 |
| 7 | citation_coverage | double precision | NO | 0 |
| 8 | abstention_precision | double precision | NO | 0 |
| 9 | entity_resolution_accuracy | double precision | NO | 0 |
| 10 | temporal_accuracy | double precision | NO | 0 |
| 11 | hallucination_rate | double precision | NO | 0 |
| 12 | p50_latency_ms | integer | NO | 0 |
| 13 | p95_latency_ms | integer | NO | 0 |
| 14 | metadata | jsonb | NO | '{}'::jsonb |
| 15 | created_at | timestamp with time zone | NO | now() |

Constraints:
- rag_eval_runs_client_id_fkey: FOREIGN KEY (client_id) REFERENCES user_souls(client_id) ON DELETE CASCADE
- rag_eval_runs_pkey: PRIMARY KEY (id)

Indexes:
- idx_rag_eval_runs_client_id: CREATE INDEX idx_rag_eval_runs_client_id ON public.rag_eval_runs USING btree (client_id, created_at DESC)
- rag_eval_runs_pkey: CREATE UNIQUE INDEX rag_eval_runs_pkey ON public.rag_eval_runs USING btree (id)

## rag_metrics

Estimated rows: 355

| # | Column | Type | Nullable | Default |
| --- | --- | --- | --- | --- |
| 1 | id | uuid | NO | gen_random_uuid() |
| 2 | client_id | uuid | NO |  |
| 3 | query | text | YES |  |
| 4 | hybrid_count | integer | YES | 0 |
| 5 | graph_count | integer | YES | 0 |
| 6 | unique_candidates | integer | YES | 0 |
| 7 | avg_similarity | double precision | YES | 0 |
| 8 | avg_resonance | double precision | YES | 0 |
| 9 | confidence_level | text | YES | 'NONE'::text |
| 10 | agentic_iterations | integer | YES | 0 |
| 11 | web_search_used | boolean | YES | false |
| 12 | youtube_skill_used | boolean | YES | false |
| 13 | cache_hit | boolean | YES | false |
| 14 | reflection_attempts | integer | YES | 0 |
| 15 | reflection_score | double precision | YES | 0 |
| 16 | conflict_detected | boolean | YES | false |
| 17 | total_latency_ms | integer | YES | 0 |
| 18 | llm_calls_count | integer | YES | 0 |
| 19 | metadata | jsonb | YES | '{}'::jsonb |
| 20 | created_at | timestamp with time zone | YES | now() |
| 21 | mode | text | YES | 'legacy'::text |
| 22 | query_style | text | YES |  |
| 23 | retrieval_profile | jsonb | NO | '{}'::jsonb |

Constraints:
- rag_metrics_client_id_fkey: FOREIGN KEY (client_id) REFERENCES user_souls(client_id) ON DELETE CASCADE
- rag_metrics_pkey: PRIMARY KEY (id)

Indexes:
- idx_rag_metrics_client_id: CREATE INDEX idx_rag_metrics_client_id ON public.rag_metrics USING btree (client_id)
- idx_rag_metrics_created_at: CREATE INDEX idx_rag_metrics_created_at ON public.rag_metrics USING btree (created_at)
- rag_metrics_pkey: CREATE UNIQUE INDEX rag_metrics_pkey ON public.rag_metrics USING btree (id)

## raw_messages

Estimated rows: 4185

| # | Column | Type | Nullable | Default |
| --- | --- | --- | --- | --- |
| 1 | id | uuid | NO | gen_random_uuid() |
| 2 | client_id | uuid | NO |  |
| 3 | sender_role | text | NO |  |
| 4 | content | text | NO |  |
| 6 | processed | boolean | YES | false |
| 7 | created_at | timestamp with time zone | YES | now() |
| 8 | remote_id | text | YES |  |
| 9 | metadata | jsonb | YES | '{}'::jsonb |
| 10 | semantic_text | text | YES |  |
| 11 | channel | text | YES |  |
| 12 | source_message_id | text | YES |  |
| 13 | event_timestamp | timestamp with time zone | YES |  |
| 14 | participant_jid | text | YES |  |
| 15 | canonical_sender_name | text | YES |  |
| 16 | conversation_name | text | YES |  |
| 17 | is_group | boolean | YES | false |
| 18 | is_history | boolean | YES | false |
| 19 | message_type | text | YES |  |
| 20 | quoted_message_id | text | YES |  |
| 21 | has_media | boolean | YES | false |
| 22 | media_type | text | YES |  |
| 23 | media_mime_type | text | YES |  |
| 24 | media_caption | text | YES |  |
| 25 | media_status | text | YES | 'none'::text |
| 26 | enrichment_status | text | YES | 'ready'::text |
| 27 | content_ready | boolean | YES | true |
| 28 | delivery_status | text | YES |  |

Constraints:
- fk_raw_messages_soul: FOREIGN KEY (client_id) REFERENCES user_souls(client_id) ON DELETE CASCADE
- raw_messages_pkey: PRIMARY KEY (id)

Indexes:
- idx_raw_messages_client_event_timestamp: CREATE INDEX idx_raw_messages_client_event_timestamp ON public.raw_messages USING btree (client_id, COALESCE(event_timestamp, created_at) DESC)
- idx_raw_messages_client_remote_event_timestamp: CREATE INDEX idx_raw_messages_client_remote_event_timestamp ON public.raw_messages USING btree (client_id, remote_id, COALESCE(event_timestamp, created_at) DESC)
- idx_raw_messages_pending_media_enrichment: CREATE INDEX idx_raw_messages_pending_media_enrichment ON public.raw_messages USING btree (client_id, COALESCE(event_timestamp, created_at) DESC) WHERE ((has_media = true) AND ((COALESCE(content_ready, false) = false) OR (COALESCE(enrichment_status, 'pending'::text) = ANY (ARRAY['pending'::text, 'failed'::text]))))
- idx_raw_messages_processed_old: CREATE INDEX idx_raw_messages_processed_old ON public.raw_messages USING btree (created_at) WHERE (processed = true)
- idx_raw_messages_ready_for_processing: CREATE INDEX idx_raw_messages_ready_for_processing ON public.raw_messages USING btree (client_id, COALESCE(event_timestamp, created_at) DESC) WHERE ((processed = false) AND (COALESCE(content_ready, true) = true))
- idx_raw_messages_remote_id: CREATE INDEX idx_raw_messages_remote_id ON public.raw_messages USING btree (remote_id)
- idx_raw_messages_source_message_id: CREATE INDEX idx_raw_messages_source_message_id ON public.raw_messages USING btree (client_id, source_message_id)
- idx_raw_messages_unprocessed: CREATE INDEX idx_raw_messages_unprocessed ON public.raw_messages USING btree (client_id, created_at DESC) WHERE (processed = false)
- raw_messages_pkey: CREATE UNIQUE INDEX raw_messages_pkey ON public.raw_messages USING btree (id)

## relation_mentions

Estimated rows: 6

| # | Column | Type | Nullable | Default |
| --- | --- | --- | --- | --- |
| 1 | id | uuid | NO | gen_random_uuid() |
| 2 | client_id | uuid | NO |  |
| 3 | source_node | text | NO |  |
| 4 | relation_type | text | NO |  |
| 5 | target_node | text | NO |  |
| 6 | context | text | YES |  |
| 7 | support_count | integer | NO | 0 |
| 8 | stable_score | double precision | NO | 0 |
| 9 | stability_tier | text | NO | 'candidate'::text |
| 10 | cognitive_flags | jsonb | NO | '[]'::jsonb |
| 11 | source_tags | jsonb | NO | '[]'::jsonb |
| 12 | metadata | jsonb | NO | '{}'::jsonb |
| 13 | promoted_to_graph | boolean | NO | false |
| 14 | first_seen | timestamp with time zone | NO | now() |
| 15 | last_seen | timestamp with time zone | NO | now() |
| 16 | created_at | timestamp with time zone | NO | now() |
| 17 | updated_at | timestamp with time zone | NO | now() |

Constraints:
- relation_mentions_client_id_fkey: FOREIGN KEY (client_id) REFERENCES user_souls(client_id) ON DELETE CASCADE
- relation_mentions_client_id_source_node_relation_type_targe_key: UNIQUE (client_id, source_node, relation_type, target_node)
- relation_mentions_pkey: PRIMARY KEY (id)

Indexes:
- idx_relation_mentions_client_id: CREATE INDEX idx_relation_mentions_client_id ON public.relation_mentions USING btree (client_id)
- idx_relation_mentions_tier: CREATE INDEX idx_relation_mentions_tier ON public.relation_mentions USING btree (client_id, stability_tier, support_count DESC)
- relation_mentions_client_id_source_node_relation_type_targe_key: CREATE UNIQUE INDEX relation_mentions_client_id_source_node_relation_type_targe_key ON public.relation_mentions USING btree (client_id, source_node, relation_type, target_node)
- relation_mentions_pkey: CREATE UNIQUE INDEX relation_mentions_pkey ON public.relation_mentions USING btree (id)

## system_config

Estimated rows: 19

| # | Column | Type | Nullable | Default |
| --- | --- | --- | --- | --- |
| 1 | key | text | NO |  |
| 2 | value | text | NO |  |
| 3 | updated_at | timestamp with time zone | YES | now() |

Constraints:
- system_config_pkey: PRIMARY KEY (key)

Indexes:
- system_config_pkey: CREATE UNIQUE INDEX system_config_pkey ON public.system_config USING btree (key)

## system_logs

Estimated rows: 7

| # | Column | Type | Nullable | Default |
| --- | --- | --- | --- | --- |
| 1 | id | uuid | NO | gen_random_uuid() |
| 2 | level | text | NO | 'INFO'::text |
| 3 | message | text | NO |  |
| 4 | client_id | uuid | YES |  |
| 5 | created_at | timestamp with time zone | YES | now() |

Constraints:
- system_logs_client_id_fkey: FOREIGN KEY (client_id) REFERENCES user_souls(client_id) ON DELETE CASCADE
- system_logs_pkey: PRIMARY KEY (id)

Indexes:
- system_logs_pkey: CREATE UNIQUE INDEX system_logs_pkey ON public.system_logs USING btree (id)

## user_memories

Estimated rows: 775

| # | Column | Type | Nullable | Default |
| --- | --- | --- | --- | --- |
| 1 | id | uuid | NO | gen_random_uuid() |
| 2 | client_id | uuid | NO |  |
| 3 | content | text | NO |  |
| 4 | sender | text | YES |  |
| 5 | metadata | jsonb | YES | '{}'::jsonb |
| 7 | created_at | timestamp with time zone | YES | now() |
| 8 | embedding | vector | YES |  |
| 9 | fts | tsvector | YES |  |
| 10 | content_hash | text | YES |  |
| 11 | memory_type | text | YES | 'semantic'::text |
| 12 | remote_id | text | YES |  |
| 13 | hop | integer | YES | 0 |

Constraints:
- fk_user_memories_soul: FOREIGN KEY (client_id) REFERENCES user_souls(client_id) ON DELETE CASCADE
- user_memories_pkey: PRIMARY KEY (id)

Indexes:
- idx_user_memories_content_hash_unique: CREATE UNIQUE INDEX idx_user_memories_content_hash_unique ON public.user_memories USING btree (client_id, content_hash) WHERE (content_hash IS NOT NULL)
- idx_user_memories_embedding_hnsw: CREATE INDEX idx_user_memories_embedding_hnsw ON public.user_memories USING hnsw (embedding vector_cosine_ops) WITH (m='16', ef_construction='64')
- idx_user_memories_fts: CREATE INDEX idx_user_memories_fts ON public.user_memories USING gin (fts)
- idx_user_memories_has_embedding: CREATE INDEX idx_user_memories_has_embedding ON public.user_memories USING btree (client_id) WHERE (embedding IS NOT NULL)
- user_memories_embedding_idx: CREATE INDEX user_memories_embedding_idx ON public.user_memories USING ivfflat (embedding vector_cosine_ops) WITH (lists='100')
- user_memories_fts_idx: CREATE INDEX user_memories_fts_idx ON public.user_memories USING gin (fts)
- user_memories_pkey: CREATE UNIQUE INDEX user_memories_pkey ON public.user_memories USING btree (id)

## user_souls

Estimated rows: 1

| # | Column | Type | Nullable | Default |
| --- | --- | --- | --- | --- |
| 1 | client_id | uuid | NO |  |
| 2 | soul_json | jsonb | NO | '{}'::jsonb |
| 3 | last_updated | timestamp with time zone | YES | now() |
| 4 | port | integer | YES |  |
| 5 | slug | text | YES |  |
| 6 | last_active | timestamp with time zone | YES | now() |
| 7 | restart_count | integer | YES | 0 |
| 8 | is_processing | boolean | YES | false |
| 9 | lock_expiry | timestamp with time zone | YES |  |
| 10 | gateway_config | jsonb | YES | '{}'::jsonb |
| 11 | worker_status | text | YES | 'Cerebro en reposo'::text |

Constraints:
- unique_slug: UNIQUE (slug)
- user_souls_client_id_fkey: FOREIGN KEY (client_id) REFERENCES users(id) ON DELETE CASCADE
- user_souls_pkey: PRIMARY KEY (client_id)
- user_souls_port_key: UNIQUE (port)
- user_souls_slug_key: UNIQUE (slug)

Indexes:
- unique_slug: CREATE UNIQUE INDEX unique_slug ON public.user_souls USING btree (slug)
- user_souls_pkey: CREATE UNIQUE INDEX user_souls_pkey ON public.user_souls USING btree (client_id)
- user_souls_port_key: CREATE UNIQUE INDEX user_souls_port_key ON public.user_souls USING btree (port)
- user_souls_slug_key: CREATE UNIQUE INDEX user_souls_slug_key ON public.user_souls USING btree (slug)

## users

Estimated rows: 1

| # | Column | Type | Nullable | Default |
| --- | --- | --- | --- | --- |
| 1 | id | uuid | NO | gen_random_uuid() |
| 2 | email | text | NO |  |
| 3 | password_hash | text | NO |  |
| 4 | created_at | timestamp with time zone | YES | CURRENT_TIMESTAMP |

Constraints:
- users_email_key: UNIQUE (email)
- users_pkey: PRIMARY KEY (id)

Indexes:
- users_email_key: CREATE UNIQUE INDEX users_email_key ON public.users USING btree (email)
- users_pkey: CREATE UNIQUE INDEX users_pkey ON public.users USING btree (id)

## whatsapp_sessions

Estimated rows: 1697

| # | Column | Type | Nullable | Default |
| --- | --- | --- | --- | --- |
| 1 | client_id | uuid | NO |  |
| 2 | data_type | text | NO |  |
| 3 | data_id | text | NO |  |
| 4 | data_json | jsonb | NO | '{}'::jsonb |
| 5 | updated_at | timestamp with time zone | YES | now() |

Constraints:
- whatsapp_sessions_client_id_fkey: FOREIGN KEY (client_id) REFERENCES users(id) ON DELETE CASCADE
- whatsapp_sessions_pkey: PRIMARY KEY (client_id, data_type, data_id)

Indexes:
- idx_whatsapp_sessions_client: CREATE INDEX idx_whatsapp_sessions_client ON public.whatsapp_sessions USING btree (client_id)
- whatsapp_sessions_pkey: CREATE UNIQUE INDEX whatsapp_sessions_pkey ON public.whatsapp_sessions USING btree (client_id, data_type, data_id)
