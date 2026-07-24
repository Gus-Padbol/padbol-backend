-- Solicitudes iniciadas por el titular desde Padbol Match.
-- Ejecutar una sola vez en Supabase antes de habilitar el botón en producción.

CREATE TABLE IF NOT EXISTS public.account_deletion_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL UNIQUE,
  email TEXT,
  source TEXT NOT NULL DEFAULT 'native'
    CHECK (source IN ('native', 'web')),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'completed', 'rejected')),
  requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  internal_note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_account_deletion_requests_status_requested
  ON public.account_deletion_requests (status, requested_at);

ALTER TABLE public.account_deletion_requests ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.account_deletion_requests FROM anon, authenticated;

COMMENT ON TABLE public.account_deletion_requests IS
  'Cola privada de solicitudes de eliminación de cuentas iniciadas por el titular.';
