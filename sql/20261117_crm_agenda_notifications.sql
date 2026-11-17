BEGIN;
CREATE TABLE IF NOT EXISTS public.crm_agenda_notifications (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 user_id uuid NOT NULL,
 reminder_id uuid NOT NULL REFERENCES public.crm_agenda_reminders(id) ON DELETE CASCADE,
 case_type text NOT NULL CHECK (case_type IN ('form','whatsapp')),
 case_id uuid NOT NULL,
 conversation_id uuid NOT NULL,
 title text NOT NULL,
 body text NOT NULL,
 link text NOT NULL,
 read_at timestamptz,
 active boolean NOT NULL DEFAULT true,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(reminder_id,user_id)
);
CREATE INDEX IF NOT EXISTS crm_agenda_notifications_user_idx ON public.crm_agenda_notifications(user_id,active,created_at DESC);
ALTER TABLE public.crm_agenda_notifications ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.crm_agenda_notifications FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE ON public.crm_agenda_notifications TO service_role;
COMMIT;
