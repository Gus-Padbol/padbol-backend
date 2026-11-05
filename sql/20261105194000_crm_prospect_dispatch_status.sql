-- States used by the unscheduled, guarded PROSPECT dispatcher. Sending is still
-- disabled by crm_prospect_settings.send_enabled (default false).
begin;
alter table public.crm_prospect_messages drop constraint if exists crm_prospect_messages_status_check;
alter table public.crm_prospect_messages
  add constraint crm_prospect_messages_status_check check (status in ('simulated','queued','sending','sent','delivered','bounced','responded','suppressed','failed','uncertain','cancelled'));
commit;
