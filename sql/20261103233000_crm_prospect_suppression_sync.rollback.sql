begin;
drop trigger if exists crm_prospect_suppress_email_receipt on public.crm_email_provider_receipts;
drop trigger if exists crm_prospect_suppress_whatsapp_optout on public.crm_commercial_followup_optouts;
drop function if exists public.crm_prospect_suppress_email_receipt();
drop function if exists public.crm_prospect_suppress_whatsapp_optout();
commit;
