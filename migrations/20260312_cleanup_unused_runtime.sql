-- Remove runtime artifacts that are no longer used by the current server.

ALTER TABLE IF EXISTS public.raw_messages
    DROP COLUMN IF EXISTS sentiment;

DROP FUNCTION IF EXISTS public.acquire_worker_lock(text, int);
DROP FUNCTION IF EXISTS public.release_worker_lock(text);
DROP TABLE IF EXISTS public.worker_locks;
