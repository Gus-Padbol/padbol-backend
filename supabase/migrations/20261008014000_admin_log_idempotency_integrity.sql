BEGIN;
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM public.notificaciones_admin_log WHERE idempotency_key IS NOT NULL GROUP BY idempotency_key HAVING count(*) > 1) THEN RAISE EXCEPTION 'duplicate_admin_idempotency_keys_require_review'; END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='notificaciones_admin_log_push_job_fkey' AND conrelid='public.notificaciones_admin_log'::regclass) THEN
  ALTER TABLE public.notificaciones_admin_log ADD CONSTRAINT notificaciones_admin_log_push_job_fkey FOREIGN KEY(push_job_id) REFERENCES public.push_delivery_jobs(id) ON DELETE SET NULL NOT VALID;
 END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS notificaciones_admin_log_idempotency_uidx ON public.notificaciones_admin_log(idempotency_key) WHERE idempotency_key IS NOT NULL;
NOTIFY pgrst,'reload schema';
COMMIT;
