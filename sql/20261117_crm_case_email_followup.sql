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
  started_at timestamptz NOT NULL,
  consent_evidence text NOT NULL,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS crm_case_email_followup_one_open
  ON public.crm_case_email_followup_plans(case_type,case_id)
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
COMMIT;
