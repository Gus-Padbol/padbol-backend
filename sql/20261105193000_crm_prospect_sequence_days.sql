-- Extend the existing PADBOL PROSPECT cadence to the approved guidance stages.
-- This migration prepares five stages only; it does not enable sending.
begin;
alter table public.crm_prospect_campaign_steps
  drop constraint if exists crm_prospect_campaign_steps_day_check;
alter table public.crm_prospect_campaign_steps
  add constraint crm_prospect_campaign_steps_day_check check (day in (0,1,3,7,14));
alter table public.crm_prospect_messages
  drop constraint if exists crm_prospect_messages_step_day_check;
alter table public.crm_prospect_messages
  add constraint crm_prospect_messages_step_day_check check (step_day in (0,1,3,7,14));
commit;
