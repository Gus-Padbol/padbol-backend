-- Additive production compatibility for the secure admin notification panel.
BEGIN;
ALTER TABLE public.notificaciones_admin_log
  ADD COLUMN IF NOT EXISTS estado text NOT NULL DEFAULT 'sent',
  ADD COLUMN IF NOT EXISTS idempotency_key text,
  ADD COLUMN IF NOT EXISTS push_job_id uuid;
CREATE INDEX IF NOT EXISTS notificaciones_admin_log_push_job_idx
  ON public.notificaciones_admin_log (push_job_id);
CREATE INDEX IF NOT EXISTS notificaciones_admin_log_admin_created_idx
  ON public.notificaciones_admin_log (admin_user_id, created_at DESC);
NOTIFY pgrst, 'reload schema';
COMMIT;
