-- Additive candidate. Backfill and lock duration require rehearsal before production.
BEGIN;
ALTER TABLE public.crm_conversations ADD COLUMN ticket_number bigint GENERATED ALWAYS AS IDENTITY (START WITH 100000 MAXVALUE 999999999999 NO CYCLE);
ALTER TABLE public.crm_conversations ADD CONSTRAINT crm_conversations_ticket_number_unique UNIQUE (ticket_number);
COMMIT;
