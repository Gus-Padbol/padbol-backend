-- Prepared migration: do not apply before isolated PostgreSQL and integration verification.
begin;
create table if not exists public.crm_whatsapp_context_sync (
  inbound_event_id uuid primary key references public.crm_inbound_events(id) on delete cascade,
  conversation_id uuid not null references public.crm_conversations(id) on delete cascade,
  revision bigint not null check (revision between 1 and 9007199254740991),
  unique (conversation_id, revision),
  content_hash text not null check (content_hash ~ '^[0-9a-f]{64}$'),
  event_received_at timestamptz not null,
  created_at timestamptz not null default now()
);
alter table public.crm_whatsapp_context_sync enable row level security;
revoke all on public.crm_whatsapp_context_sync from public, anon, authenticated;
grant select, insert on public.crm_whatsapp_context_sync to service_role;

create or replace function public.crm_bind_whatsapp_context(
 p_message_id text, p_revision bigint, p_sender text, p_phone_number_id text, p_waba_id text,
 p_context jsonb, p_content_hash text, p_qualification_status text, p_next_step text
) returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare ev public.crm_inbound_events%rowtype; conv public.crm_conversations%rowtype;
 existing public.crm_whatsapp_context_sync%rowtype; previous public.crm_whatsapp_context_sync%rowtype;
 next_context jsonb;
begin
 if p_revision is null or p_revision < 1 or p_revision > 9007199254740991 or p_phone_number_id is distinct from '1376102838911694' or p_waba_id is distinct from '928900479733370'
    or p_sender is null or p_sender !~ '^[0-9]{5,20}$' or p_message_id is null or length(p_message_id) not between 1 and 512
    or (p_qualification_status is not null and p_qualification_status not in ('pending','needs_review'))
    or (p_next_step is not null and p_next_step not in ('whatsapp_menu_topic','confirm_topic','subtopic','details','advisor_handoff'))
    or p_content_hash is null or p_content_hash !~ '^[0-9a-f]{64}$' or p_context is null or jsonb_typeof(p_context) <> 'object' then
   raise exception 'invalid context' using errcode = '22023';
 end if;
 select * into ev from public.crm_inbound_events where source_channel='whatsapp'
   and origin='whatsapp:' || p_phone_number_id and source_ref=p_message_id;
 if not found then raise exception 'event unavailable' using errcode='P0002'; end if;
 select * into conv from public.crm_conversations where id=ev.conversation_id for update;
 if not found or conv.source_channel <> 'whatsapp' or conv.origin <> 'whatsapp:' || p_phone_number_id
    or regexp_replace(coalesce(conv.identity_used,''), '[^0-9]', '', 'g') <> p_sender then
   raise exception 'event unavailable' using errcode='P0002';
 end if;
 select * into existing from public.crm_whatsapp_context_sync where inbound_event_id=ev.id;
 if found then
   if existing.content_hash <> p_content_hash or existing.revision <> p_revision then raise exception 'conflicting replay' using errcode='23505'; end if;
   return jsonb_build_object('conversationId',conv.id,'replay',true);
 end if;
 select * into previous from public.crm_whatsapp_context_sync where conversation_id=conv.id
   order by revision desc limit 1;
 insert into public.crm_whatsapp_context_sync(inbound_event_id,conversation_id,revision,content_hash,event_received_at)
   values(ev.id,conv.id,p_revision,p_content_hash,ev.received_at);
 -- Old arrivals are acknowledged but cannot overwrite a later transition.
 if previous.inbound_event_id is null or p_revision > previous.revision then
   next_context := p_context;
   if conv.qualification_data #>> '{whatsapp_menu,initialMessage}' is not null then
     next_context := jsonb_set(next_context,'{initialMessage}',conv.qualification_data #> '{whatsapp_menu,initialMessage}',true);
   end if;
   update public.crm_conversations set qualification_data=jsonb_set(coalesce(qualification_data,'{}'::jsonb),'{whatsapp_menu}',next_context,true),
     qualification_status=case when estado='nuevo' and operador is null and sede_id is null and assigned_by is null and not derivado and not handoff_ready and qualification_status in ('pending','needs_review') then coalesce(p_qualification_status,qualification_status) else qualification_status end,
     next_step=case when estado='nuevo' and operador is null and sede_id is null and assigned_by is null and not derivado and not handoff_ready and qualification_status in ('pending','needs_review') then coalesce(p_next_step,next_step) else next_step end,
     updated_at=now() where id=conv.id;
 end if;
 -- Ordering uncertainty is sticky, even if this revision arrives late.
 if p_context->'order_review' = 'true'::jsonb then
   update public.crm_conversations set qualification_data=jsonb_set(coalesce(qualification_data,'{}'::jsonb),'{whatsapp_order_review}', '{"required":true,"reason":"ambiguous_message_order"}'::jsonb,true), updated_at=now() where id=conv.id;
 end if;
 return jsonb_build_object('conversationId',conv.id,'replay',false);
end $$;
revoke all on function public.crm_bind_whatsapp_context(text,bigint,text,text,text,jsonb,text,text,text) from public, anon, authenticated;
grant execute on function public.crm_bind_whatsapp_context(text,bigint,text,text,text,jsonb,text,text,text) to service_role;
commit;
