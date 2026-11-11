-- Reuse the existing email receipts / WhatsApp opt-out evidence as the global
-- prospect suppression list. No new message transport.
begin;

create or replace function public.crm_prospect_suppress_email_receipt() returns trigger
language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_email text;
begin
  if new.bounced_at is null and new.complained_at is null then return new; end if;
  select lower(c.email_normalized) into v_email
  from public.crm_replies r join public.crm_conversations c on c.id=r.conversation_id
  where r.id=new.reply_id;
  if v_email is not null and not exists (
    select 1 from public.crm_prospect_suppressions s
    where s.active and lower(s.email)=v_email
  ) then
    insert into public.crm_prospect_suppressions(email,reason,source,created_by)
    values(v_email,case when new.complained_at is not null then 'complaint' else 'bounce' end,'email_receipt','system:email');
  end if;
  return new;
end $$;
drop trigger if exists crm_prospect_suppress_email_receipt on public.crm_email_provider_receipts;
create trigger crm_prospect_suppress_email_receipt after insert or update of bounced_at,complained_at on public.crm_email_provider_receipts
for each row execute function public.crm_prospect_suppress_email_receipt();

create or replace function public.crm_prospect_suppress_whatsapp_optout() returns trigger
language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_phone text;
begin
  v_phone := regexp_replace(coalesce(new.recipient_wa_id,''),'[^0-9]','','g');
  if length(v_phone) between 8 and 15 and not exists (
    select 1 from public.crm_prospect_suppressions s where s.active and s.phone=v_phone
  ) then
    insert into public.crm_prospect_suppressions(phone,reason,source,created_by)
    values(v_phone,'opt_out','whatsapp_optout','system:whatsapp');
  end if;
  return new;
end $$;
drop trigger if exists crm_prospect_suppress_whatsapp_optout on public.crm_commercial_followup_optouts;
create trigger crm_prospect_suppress_whatsapp_optout after insert on public.crm_commercial_followup_optouts
for each row execute function public.crm_prospect_suppress_whatsapp_optout();

revoke all on function public.crm_prospect_suppress_email_receipt() from public,anon,authenticated;
revoke all on function public.crm_prospect_suppress_whatsapp_optout() from public,anon,authenticated;
commit;
