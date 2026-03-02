-- ====================================================================
-- OPENCLAW: USER DELETION CASCADING LOGIC
-- Purpose: Ensures that deleting a user from public.users completely
-- wipes all their data from the application database.
-- ====================================================================
-- 
-- CHAIN: public.users (DELETE)
--   ├── CASCADE → user_souls (client_id → users.id)
--   │     ├── CASCADE → user_memories
--   │     ├── CASCADE → raw_messages
--   │     ├── CASCADE → inbox_summaries
--   │     ├── CASCADE → contact_personas (FIXED: was pointing to auth.users)
--   │     ├── CASCADE → knowledge_nodes
--   │     ├── CASCADE → knowledge_edges
--   │     └── CASCADE → system_logs
--   ├── CASCADE → clients (user_id → users.id)
--   └── CASCADE → whatsapp_sessions (client_id → users.id)
--
-- No trigger needed! Proper FK CASCADE handles everything.
-- ====================================================================

-- ═══════════════════════════════════════════════════════════════
-- LEVEL 1: Tables that reference public.users(id) directly
-- ═══════════════════════════════════════════════════════════════

-- A) user_souls.client_id → public.users(id)
ALTER TABLE public.user_souls 
  DROP CONSTRAINT IF EXISTS user_souls_client_id_fkey;
ALTER TABLE public.user_souls 
  ADD CONSTRAINT user_souls_client_id_fkey 
  FOREIGN KEY (client_id) 
  REFERENCES public.users(id) 
  ON DELETE CASCADE;

-- B) clients.user_id → public.users(id)
ALTER TABLE public.clients 
  DROP CONSTRAINT IF EXISTS clients_user_id_fkey;
ALTER TABLE public.clients 
  ADD CONSTRAINT clients_user_id_fkey 
  FOREIGN KEY (user_id) 
  REFERENCES public.users(id) 
  ON DELETE CASCADE;

-- C) whatsapp_sessions.client_id → public.users(id)
ALTER TABLE public.whatsapp_sessions 
  DROP CONSTRAINT IF EXISTS whatsapp_sessions_client_id_fkey;
ALTER TABLE public.whatsapp_sessions 
  ADD CONSTRAINT whatsapp_sessions_client_id_fkey 
  FOREIGN KEY (client_id) 
  REFERENCES public.users(id) 
  ON DELETE CASCADE;

-- ═══════════════════════════════════════════════════════════════
-- LEVEL 2: Tables that reference public.user_souls(client_id)
-- ═══════════════════════════════════════════════════════════════

-- D) user_memories
ALTER TABLE public.user_memories 
  DROP CONSTRAINT IF EXISTS fk_user_memories_soul;
ALTER TABLE public.user_memories 
  ADD CONSTRAINT fk_user_memories_soul 
  FOREIGN KEY (client_id) 
  REFERENCES public.user_souls(client_id) 
  ON DELETE CASCADE;

-- E) raw_messages
ALTER TABLE public.raw_messages 
  DROP CONSTRAINT IF EXISTS fk_raw_messages_soul;
ALTER TABLE public.raw_messages 
  ADD CONSTRAINT fk_raw_messages_soul 
  FOREIGN KEY (client_id) 
  REFERENCES public.user_souls(client_id) 
  ON DELETE CASCADE;

-- F) inbox_summaries
ALTER TABLE public.inbox_summaries 
  DROP CONSTRAINT IF EXISTS inbox_summaries_client_id_fkey;
ALTER TABLE public.inbox_summaries 
  ADD CONSTRAINT inbox_summaries_client_id_fkey 
  FOREIGN KEY (client_id) 
  REFERENCES public.user_souls(client_id) 
  ON DELETE CASCADE;

-- G) contact_personas (FIX: was pointing to auth.users, now points to user_souls)
ALTER TABLE public.contact_personas 
  DROP CONSTRAINT IF EXISTS contact_personas_client_id_fkey;
ALTER TABLE public.contact_personas 
  ADD CONSTRAINT contact_personas_client_id_fkey 
  FOREIGN KEY (client_id) 
  REFERENCES public.user_souls(client_id) 
  ON DELETE CASCADE;

-- H) knowledge_nodes
ALTER TABLE public.knowledge_nodes 
  DROP CONSTRAINT IF EXISTS fk_nodes_client;
ALTER TABLE public.knowledge_nodes 
  ADD CONSTRAINT fk_nodes_client 
  FOREIGN KEY (client_id) 
  REFERENCES public.user_souls(client_id) 
  ON DELETE CASCADE;

-- I) knowledge_edges
ALTER TABLE public.knowledge_edges 
  DROP CONSTRAINT IF EXISTS fk_edges_client;
ALTER TABLE public.knowledge_edges 
  ADD CONSTRAINT fk_edges_client 
  FOREIGN KEY (client_id) 
  REFERENCES public.user_souls(client_id) 
  ON DELETE CASCADE;

-- J) system_logs (optional: logs tied to the client)
ALTER TABLE public.system_logs 
  DROP CONSTRAINT IF EXISTS system_logs_client_id_fkey;
ALTER TABLE public.system_logs 
  ADD CONSTRAINT system_logs_client_id_fkey 
  FOREIGN KEY (client_id) 
  REFERENCES public.user_souls(client_id) 
  ON DELETE CASCADE;

-- ═══════════════════════════════════════════════════════════════
-- DONE. Now deleting a row from public.users will cascade-delete
-- ALL related data across the entire application.
-- The existing webhook on user_souls DELETE will handle the
-- physical file cleanup on the server (clients/ folder).
-- ═══════════════════════════════════════════════════════════════
