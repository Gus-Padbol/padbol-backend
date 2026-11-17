-- Candidate: durable per-case email follow-up plans and outbox. Do not apply without ROOT review.
BEGIN;
CREATE TABLE IF NOT EXISTS public.crm_case_email_followup_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_type text NOT NULL CHECK (case_type IN ('form','whatsapp')),
  case_id uuid NOT NULL,
  conversation_id uuid NOT NULL REFERENCES public.crm_conversations(id) ON DELETE CASCADE,
  recipient_email text NOT NULL,
  language text NOT NULL DEFAULT 'es' CHECK (language IN ('es','en')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','stopped','completed','human_review')),
  status_reason text,
  started_at timestamptz NOT NULL,
  consent_evidence text NOT NULL,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS crm_case_email_followup_one_open
  ON public.crm_case_email_followup_plans(case_type,case_id)
  WHERE status IN ('active','paused','human_review');
CREATE UNIQUE INDEX IF NOT EXISTS crm_case_email_followup_one_open_email
  ON public.crm_case_email_followup_plans(lower(btrim(recipient_email)))
  WHERE status IN ('active','paused','human_review');
CREATE TABLE IF NOT EXISTS public.crm_case_email_followup_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id uuid NOT NULL REFERENCES public.crm_case_email_followup_plans(id) ON DELETE CASCADE,
  step integer NOT NULL CHECK (step BETWEEN 0 AND 2),
  due_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','claimed','accepted','failed','cancelled')),
  claim_token uuid,
  claimed_at timestamptz,
  sent_at timestamptz,
  provider_message_id text,
  error_code text,
  attempts integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(plan_id,step)
);
CREATE INDEX IF NOT EXISTS crm_case_email_followup_due_idx
  ON public.crm_case_email_followup_outbox(status,due_at);
ALTER TABLE public.crm_case_email_followup_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.crm_case_email_followup_outbox ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.crm_case_email_followup_plans,public.crm_case_email_followup_outbox FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE ON public.crm_case_email_followup_plans,public.crm_case_email_followup_outbox TO service_role;

-- Stop immediately in the same transaction as a customer reply, delivery failure,
-- or case closure. Keep conversation -> plan -> outbox lock order.
CREATE OR REPLACE FUNCTION public.crm_case_email_followup_stop_event()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE cv uuid; event_at timestamptz; reason text; plan_row record;
BEGIN
 IF TG_TABLE_NAME='crm_inbound_events' THEN
  cv:=NEW.conversation_id; event_at:=NEW.received_at; reason:='reply_received';
 ELSIF TG_TABLE_NAME='crm_email_provider_receipts' THEN
  IF NEW.bounced_at IS NULL AND NEW.failed_at IS NULL AND NEW.complained_at IS NULL THEN RETURN NEW; END IF;
  SELECT conversation_id INTO cv FROM public.crm_replies WHERE id=NEW.reply_id;
  event_at:=greatest(NEW.bounced_at,NEW.failed_at,NEW.complained_at); reason:='delivery_problem';
 ELSIF TG_TABLE_NAME='crm_conversations' THEN
  IF NEW.estado IS DISTINCT FROM 'cerrado' THEN RETURN NEW; END IF;
  cv:=NEW.id; reason:='case_closed';
 ELSE
  IF NEW.progress_state='en_espera' THEN RETURN NEW; END IF;
  cv:=NEW.conversation_id; reason:='case_no_longer_waiting';
 END IF;
 IF cv IS NULL THEN RETURN NEW; END IF;
 PERFORM 1 FROM public.crm_conversations WHERE id=cv FOR UPDATE;
 FOR plan_row IN SELECT id FROM public.crm_case_email_followup_plans
  WHERE conversation_id=cv AND status IN ('active','paused','human_review')
    AND (event_at IS NULL OR event_at>started_at) ORDER BY id FOR UPDATE
 LOOP
  UPDATE public.crm_case_email_followup_plans SET status='stopped',status_reason=reason,updated_at=now() WHERE id=plan_row.id;
  UPDATE public.crm_case_email_followup_outbox SET status='cancelled',updated_at=now()
   WHERE plan_id=plan_row.id AND status IN ('queued','claimed');
 END LOOP;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.crm_case_email_followup_stop_event() FROM PUBLIC,anon,authenticated;
DO $$ BEGIN
 IF to_regclass('public.crm_inbound_events') IS NOT NULL THEN
  CREATE TRIGGER crm_case_email_stop_inbound AFTER INSERT ON public.crm_inbound_events FOR EACH ROW EXECUTE FUNCTION public.crm_case_email_followup_stop_event();
 END IF;
 IF to_regclass('public.crm_email_provider_receipts') IS NOT NULL THEN
  CREATE TRIGGER crm_case_email_stop_delivery AFTER INSERT OR UPDATE OF bounced_at,failed_at,complained_at ON public.crm_email_provider_receipts FOR EACH ROW EXECUTE FUNCTION public.crm_case_email_followup_stop_event();
 END IF;
 CREATE TRIGGER crm_case_email_stop_conversation AFTER UPDATE OF estado ON public.crm_conversations FOR EACH ROW EXECUTE FUNCTION public.crm_case_email_followup_stop_event();
 CREATE TRIGGER crm_case_email_stop_form AFTER UPDATE OF progress_state ON public.crm_commercial_form_cases FOR EACH ROW EXECUTE FUNCTION public.crm_case_email_followup_stop_event();
 CREATE TRIGGER crm_case_email_stop_whatsapp AFTER UPDATE OF progress_state ON public.crm_commercial_cases FOR EACH ROW EXECUTE FUNCTION public.crm_case_email_followup_stop_event();
END $$;

COMMIT;
