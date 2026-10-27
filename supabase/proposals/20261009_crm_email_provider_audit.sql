-- REVIEW ONLY: additive schema proposal; not executed by the author.
-- Preserve every reply, status and historical delivery record.
BEGIN;
ALTER TABLE public.crm_replies
  ADD COLUMN IF NOT EXISTS provider_message_id text;
COMMIT;
