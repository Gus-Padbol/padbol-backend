-- Additive candidate. Backfill and lock duration require rehearsal before production.
BEGIN;
SET LOCAL lock_timeout = '3s';
ALTER TABLE public.crm_conversations ADD COLUMN ticket_number bigint GENERATED ALWAYS AS IDENTITY (START WITH 100000 MAXVALUE 999999999999 NO CYCLE);
ALTER TABLE public.crm_conversations ADD CONSTRAINT crm_conversations_ticket_number_unique UNIQUE (ticket_number);
CREATE FUNCTION public.crm_reject_ticket_number_change() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  RAISE EXCEPTION 'CRM ticket number is immutable' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER crm_conversations_ticket_number_immutable
AFTER UPDATE ON public.crm_conversations
FOR EACH ROW WHEN (OLD.ticket_number IS DISTINCT FROM NEW.ticket_number)
EXECUTE FUNCTION public.crm_reject_ticket_number_change();
COMMIT;
