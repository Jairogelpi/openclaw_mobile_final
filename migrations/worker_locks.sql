-- Migration: Locking Mechanisms for Multi-Worker Idempotency
-- Provides atomic locking for client processing

CREATE TABLE IF NOT EXISTS public.worker_locks (
    client_id text PRIMARY KEY,
    locked_at timestamp with time zone DEFAULT now()
);

CREATE OR REPLACE FUNCTION public.acquire_worker_lock(p_client_id text, p_expiry_minutes int DEFAULT 30)
RETURNS boolean AS $$
BEGIN
    -- Limpiar bloqueos expirados
    DELETE FROM public.worker_locks WHERE locked_at < now() - (p_expiry_minutes || ' minutes')::interval;

    -- Intentar insertar nuevo bloqueo
    INSERT INTO public.worker_locks (client_id, locked_at)
    VALUES (p_client_id, now())
    ON CONFLICT (client_id) DO NOTHING;

    RETURN FOUND;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION public.release_worker_lock(p_client_id text)
RETURNS void AS $$
BEGIN
    DELETE FROM public.worker_locks WHERE client_id = p_client_id;
END;
$$ LANGUAGE plpgsql;
