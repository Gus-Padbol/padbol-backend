-- QA candidate rollback only. Stop all menu workers before executing.
-- Preserve the event ledger once it contains any processed message.
begin;
lock table public.crm_whatsapp_menu_events in access exclusive mode;
do $$ begin
  if exists (select 1 from public.crm_whatsapp_menu_events) then
    raise exception 'menu event ledger is not empty; preserve it and reconcile before rollback';
  end if;
end $$;
drop trigger crm_manual_whatsapp_uncertainty_guard on public.crm_whatsapp_manual_attempts;
drop function public.crm_guard_manual_whatsapp_uncertainty();
drop function public.crm_confirm_whatsapp_menu_sent(uuid, uuid, text, timestamptz);
drop function public.crm_commit_whatsapp_menu_transition(uuid, uuid, bigint, jsonb, text, text);
drop table public.crm_whatsapp_menu_events;
commit;
