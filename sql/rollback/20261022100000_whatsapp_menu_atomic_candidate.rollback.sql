-- QA candidate rollback only. Stop all menu workers before executing.
-- Preserve the event ledger once it contains any processed message.
begin;
lock table public.crm_whatsapp_menu_events in access exclusive mode;
do $$ begin
  if exists (select 1 from public.crm_whatsapp_menu_events) then
    raise exception 'menu event ledger is not empty; preserve it and reconcile before rollback';
  end if;
end $$;
drop function public.crm_confirm_whatsapp_menu_sent(uuid, uuid, text, timestamptz);
drop function public.crm_commit_whatsapp_menu_transition(uuid, uuid, timestamptz, jsonb, text, text);
drop table public.crm_whatsapp_menu_events;
commit;
