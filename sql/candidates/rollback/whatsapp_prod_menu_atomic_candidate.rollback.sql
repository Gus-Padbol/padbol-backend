-- QA candidate rollback only. Stop all menu workers before executing.
-- Preserve the event ledger once it contains any processed message.
begin;
drop trigger if exists crm_guard_whatsapp_open_insert on public.crm_conversations;
drop function if exists public.crm_guard_whatsapp_open_insert();
lock table public.crm_whatsapp_menu_events in access exclusive mode;
do $$ begin
  if exists (select 1 from public.crm_whatsapp_menu_events) then
    raise exception 'menu event ledger is not empty; preserve it and reconcile before rollback';
  end if;
end $$;
do $$ begin if exists(select 1 from public.crm_whatsapp_menu_reconciliation) then raise exception 'menu review ledger is not empty'; end if; end $$;
do $$ begin if exists(select 1 from public.crm_whatsapp_processing_decisions) then raise exception 'processing decision ledger is not empty'; end if; end $$;
drop trigger crm_track_whatsapp_processing on public.whatsapp_inbound_messages;
drop index public.crm_whatsapp_recovery_scan_idx;
drop function public.crm_track_whatsapp_processing();
drop table public.crm_whatsapp_processing_decisions;
drop function public.crm_reconcile_whatsapp_menu(uuid,uuid,text,text,text);
drop table public.crm_whatsapp_menu_reconciliation;
drop function public.crm_whatsapp_menu_review_batch(uuid[]);
drop function public.crm_whatsapp_menu_needs_review(uuid);
drop trigger crm_manual_whatsapp_uncertainty_guard on public.crm_whatsapp_manual_attempts;
drop function public.crm_guard_manual_whatsapp_uncertainty();
drop function public.crm_confirm_whatsapp_menu_sent(uuid, uuid, text, timestamptz);
drop function public.crm_commit_whatsapp_menu_transition(uuid, uuid, bigint, jsonb, text, text);
drop function public.crm_get_or_create_whatsapp_conversation(jsonb);
drop table public.crm_whatsapp_menu_events;
commit;
