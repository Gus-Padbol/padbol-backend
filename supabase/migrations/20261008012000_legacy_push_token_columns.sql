-- Preserve every existing registration and every consent preference.
BEGIN;
ALTER TABLE public.push_tokens
 ADD COLUMN IF NOT EXISTS expo_push_token text,
 ADD COLUMN IF NOT EXISTS device_id text,
 ADD COLUMN IF NOT EXISTS language text,
 ADD COLUMN IF NOT EXISTS enabled boolean NOT NULL DEFAULT true,
 ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now(),
 ADD COLUMN IF NOT EXISTS last_seen_at timestamptz NOT NULL DEFAULT now(),
 ADD COLUMN IF NOT EXISTS revoked_at timestamptz,
 ADD COLUMN IF NOT EXISTS invalidated_at timestamptz,
 ADD COLUMN IF NOT EXISTS invalidation_reason text;
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='push_tokens' AND column_name='token') THEN
  EXECUTE 'UPDATE public.push_tokens SET expo_push_token = token WHERE expo_push_token IS NULL';
 END IF;
END $$;
UPDATE public.push_tokens SET device_id = 'legacy-' || id::text WHERE device_id IS NULL;
CREATE INDEX IF NOT EXISTS push_tokens_active_user_idx
 ON public.push_tokens (user_id) WHERE enabled = true AND revoked_at IS NULL AND invalidated_at IS NULL;
NOTIFY pgrst, 'reload schema';
COMMIT;
