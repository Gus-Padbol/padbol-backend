-- Candidato aislado: requiere revisión y aplicación QA. No transporte ni permisos de bot.
begin;
do $$begin if not exists(select 1 from information_schema.columns where table_schema='public' and table_name='crm_conversations' and column_name='ticket_number') then raise exception 'SUPPORT_REQUIRES_PERSISTED_CRM_TICKET_NUMBER'; end if; end$$;
create table if not exists public.crm_support_preparation_config (
 singleton boolean primary key default true check(singleton),producer_enabled boolean not null default false,whatsapp_origin text
);
insert into public.crm_support_preparation_config(singleton)values(true)on conflict do nothing;
create table if not exists public.crm_support_event_context (
 event_id uuid primary key references public.crm_inbound_events(id)on delete cascade,
 conversation_id uuid not null references public.crm_conversations(id)on delete cascade,
 menu_inbound_id uuid not null,tenant_id uuid not null,channel_id uuid not null,
 origin text not null,source_ref text not null,menu_revision bigint not null,
 context_kind text not null check(context_kind in('primary','followup','unknown')),
 effective_topic text,confirmed boolean not null default false,created_at timestamptz not null default now(),
 check(not confirmed or effective_topic is not null)
);
alter table public.crm_support_event_context enable row level security;
revoke all on public.crm_support_event_context from public,anon,authenticated,service_role;
grant select on public.crm_support_event_context to service_role;
create table if not exists public.crm_support_cases (
 id bigserial primary key,public_reference text not null unique,
 conversation_id uuid not null unique references public.crm_conversations(id)on delete cascade,
 source_channel text not null check(source_channel in('email','whatsapp')),
 source_event_id uuid not null references public.crm_inbound_events(id),
 version integer not null default 1 check(version>0),lifecycle_state text not null default 'received',
 lifecycle_data jsonb not null default '{}'::jsonb,
 tenant_id uuid,channel_id uuid,
 acknowledgement_policy text not null check(acknowledgement_policy in('reuse_existing_menu_only','prepare_only')),
 created_at timestamptz not null default now(),updated_at timestamptz not null default now()
);
alter table public.crm_support_cases add column if not exists tenant_id uuid,add column if not exists channel_id uuid;
create table if not exists public.crm_support_ingest_journal (
 event_id uuid primary key references public.crm_inbound_events(id)on delete cascade,
 conversation_id uuid not null references public.crm_conversations(id)on delete cascade,
 routing_state text not null default 'classification_pending' check(routing_state in('classification_pending','support_ready')),
 created_at timestamptz not null default now(),updated_at timestamptz not null default now()
);
create table if not exists public.crm_support_links (
  conversation_id uuid primary key references public.crm_conversations(id) on delete cascade,
  ticket_id bigint references public.support_tickets(id),
  requester_user_id uuid,
  sede_id bigint,
  assigned_area text not null default 'tecnica' check(assigned_area='tecnica'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((ticket_id is null and requester_user_id is null and sede_id is null) or (ticket_id is not null and requester_user_id is not null))
);
create table if not exists public.crm_support_preparation_jobs (
  event_id uuid primary key references public.crm_inbound_events(id) on delete cascade,
  conversation_id uuid not null references public.crm_support_links(conversation_id) on delete cascade,
  preparation_state text not null check(preparation_state in('identity_required','prepared')),
  mode text not null default 'preparation' check(mode='preparation'),
  actor_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.crm_support_preparation_jobs alter column actor_id drop not null;
alter table public.crm_support_preparation_config enable row level security;
alter table public.crm_support_cases enable row level security;
alter table public.crm_support_ingest_journal enable row level security;
revoke all on public.crm_support_preparation_config,public.crm_support_cases,public.crm_support_ingest_journal from public,anon,authenticated,service_role;
grant select on public.crm_support_cases,public.crm_support_ingest_journal to service_role;
alter table public.crm_support_links enable row level security;
alter table public.crm_support_preparation_jobs enable row level security;
revoke all on public.crm_support_links, public.crm_support_preparation_jobs from public, anon, authenticated, service_role;
grant select on public.crm_support_links, public.crm_support_preparation_jobs to service_role;
create or replace function public.crm_prepare_support_event_internal(
 p_conversation_id uuid,p_event_id uuid,p_actor_id uuid,p_ticket_id bigint default null,
 p_requester_user_id uuid default null,p_sede_id bigint default null
) returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare c public.crm_conversations%rowtype; e public.crm_inbound_events%rowtype;
 t public.support_tickets%rowtype; l public.crm_support_links%rowtype; j public.crm_support_preparation_jobs%rowtype; k public.crm_support_cases%rowtype; cfg public.crm_support_preparation_config%rowtype;
begin
 select * into c from public.crm_conversations where id=p_conversation_id for update;
 if not found then raise exception 'SUPPORT_CONVERSATION_NOT_FOUND'; end if;
 select * into cfg from public.crm_support_preparation_config where singleton;
 if not coalesce((c.source_channel='email' and c.origin='support_email' and c.qualification_data#>>'{mailbox,address}'='support@padbol.com'),false) and not coalesce((c.source_channel='whatsapp' and c.origin=cfg.whatsapp_origin and exists(select 1 from public.crm_support_event_context x where x.event_id=p_event_id and x.conversation_id=c.id and x.origin=c.origin and x.confirmed and x.effective_topic='soporte') and c.qualification_data#>>'{whatsapp_order_review,required}' is distinct from 'true' and c.qualification_data#>>'{whatsapp_message_order_review,required}' is distinct from 'true'),false)then raise exception 'SUPPORT_SCOPE_REQUIRED';end if;
 select * into e from public.crm_inbound_events where id=p_event_id;
 if not found or e.conversation_id is distinct from c.id or e.source_channel is distinct from c.source_channel or e.origin is distinct from c.origin then raise exception 'SUPPORT_EVENT_MISMATCH'; end if;
 if c.source_channel='whatsapp' and not exists(select 1 from public.crm_support_event_context x where x.event_id=e.id and x.conversation_id=c.id and x.origin=e.origin and x.source_ref=e.source_ref and x.confirmed and x.effective_topic='soporte')then raise exception 'SUPPORT_CLASSIFICATION_PENDING';end if;
 if c.ticket_number is null then raise exception 'SUPPORT_REFERENCE_NOT_PERSISTED'; end if;
 insert into public.crm_support_cases(public_reference,conversation_id,source_channel,source_event_id,acknowledgement_policy,tenant_id,channel_id)values('PB-'||c.ticket_number,c.id,c.source_channel,e.id,case when c.source_channel='whatsapp' then 'reuse_existing_menu_only' else 'prepare_only' end,(select tenant_id from public.crm_support_event_context where event_id=e.id),(select channel_id from public.crm_support_event_context where event_id=e.id))on conflict(conversation_id)do nothing;
 select * into k from public.crm_support_cases where conversation_id=c.id;
 if c.source_channel='whatsapp' and not exists(select 1 from public.crm_support_event_context x where x.event_id=e.id and x.tenant_id=k.tenant_id and x.channel_id=k.channel_id)then raise exception 'SUPPORT_CASE_TENANT_MISMATCH';end if;
 if p_ticket_id is null and (p_requester_user_id is not null or p_sede_id is not null) then raise exception 'SUPPORT_VERIFIED_TICKET_REQUIRED'; end if;
 if p_ticket_id is not null then
  if p_requester_user_id is null then raise exception 'SUPPORT_VERIFIED_IDENTITY_REQUIRED'; end if;
  select * into t from public.support_tickets where id=p_ticket_id for update;
  if not found or t.requester_user_id is distinct from p_requester_user_id or t.sede_id is distinct from p_sede_id then raise exception 'SUPPORT_TICKET_SCOPE_MISMATCH'; end if;
 end if;
 insert into public.crm_support_links(conversation_id) values(c.id) on conflict do nothing;
 select * into l from public.crm_support_links where conversation_id=c.id for update;
 if l.ticket_id is not null and p_ticket_id is not null and l.ticket_id<>p_ticket_id then raise exception 'SUPPORT_LINK_CONFLICT'; end if;
 if p_ticket_id is not null then
  update public.crm_support_links set ticket_id=p_ticket_id,requester_user_id=p_requester_user_id,sede_id=p_sede_id,updated_at=now() where conversation_id=c.id;
  -- Recupera trabajos anteriores que esperaban la identidad, sin crear ticket falso.
  update public.crm_support_preparation_jobs set preparation_state='prepared',updated_at=now() where conversation_id=c.id and preparation_state='identity_required';
 end if;
 select * into l from public.crm_support_links where conversation_id=c.id;
 insert into public.crm_support_preparation_jobs(event_id,conversation_id,preparation_state,actor_id)
 values(e.id,c.id,case when l.ticket_id is null then 'identity_required' else 'prepared' end,p_actor_id)
 on conflict(event_id) do nothing;
 select * into j from public.crm_support_preparation_jobs where event_id=e.id;
 if j.conversation_id<>c.id then raise exception 'SUPPORT_EVENT_LINK_CONFLICT'; end if;
 return jsonb_build_object('conversationId',c.id,'eventId',e.id,'ticketId',l.ticket_id,'assignedArea',l.assigned_area,'preparationState',j.preparation_state,'mode',j.mode,'sendEnabled',false,'caseId',k.id,'caseReference',k.public_reference,'acknowledgementPolicy',k.acknowledgement_policy);
end $$;
revoke all on function public.crm_prepare_support_event_internal(uuid,uuid,uuid,bigint,uuid,bigint) from public,anon,authenticated,service_role;
create or replace function public.crm_prepare_support_event(p_conversation_id uuid,p_event_id uuid,p_actor_id uuid,p_ticket_id bigint default null,p_requester_user_id uuid default null,p_sede_id bigint default null)returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$begin
 if p_actor_id is null then raise exception 'SUPPORT_ACTOR_REQUIRED';end if;
 return public.crm_prepare_support_event_internal(p_conversation_id,p_event_id,p_actor_id,p_ticket_id,p_requester_user_id,p_sede_id);
end$$;
revoke all on function public.crm_prepare_support_event(uuid,uuid,uuid,bigint,uuid,bigint) from public,anon,authenticated;
grant execute on function public.crm_prepare_support_event(uuid,uuid,uuid,bigint,uuid,bigint) to service_role;
-- Trigger durable y conservador: no lee un menú viejo como clasificación del evento nuevo.
create or replace function public.crm_capture_support_event(p_event_id uuid)returns boolean language plpgsql security definer set search_path=pg_catalog,public as $$
declare c public.crm_conversations%rowtype;e public.crm_inbound_events%rowtype;cfg public.crm_support_preparation_config%rowtype;
begin
 select * into cfg from public.crm_support_preparation_config where singleton;
 if not coalesce(cfg.producer_enabled,false)then return false;end if;
 select * into e from public.crm_inbound_events where id=p_event_id;
 if not found then return false;end if;
 select * into c from public.crm_conversations where id=e.conversation_id;
 if not found then return false;end if;
 if (e.source_channel='whatsapp' and e.origin=cfg.whatsapp_origin) or (e.source_channel='email' and e.origin='support_email' and c.qualification_data#>>'{mailbox,address}'='support@padbol.com')then
  insert into public.crm_support_ingest_journal(event_id,conversation_id)values(e.id,c.id)on conflict do nothing;
 else return false;end if;
 if e.source_channel='whatsapp' and not exists(select 1 from public.crm_support_event_context x where x.event_id=e.id and x.conversation_id=c.id and x.origin=e.origin and x.source_ref=e.source_ref and x.confirmed and x.effective_topic='soporte')then return false;end if;
 perform public.crm_prepare_support_event_internal(c.id,e.id,null,null,null,null);
 update public.crm_support_ingest_journal set routing_state='support_ready',updated_at=now()where event_id=e.id;
 return true;
end$$;
revoke all on function public.crm_capture_support_event(uuid)from public,anon,authenticated,service_role;
create or replace function public.crm_support_ingest_trigger()returns trigger language plpgsql security definer set search_path=pg_catalog,public as $$
declare event_id uuid;begin
 if TG_TABLE_NAME='crm_inbound_events'then perform public.crm_capture_support_event(NEW.id);
 else
  for event_id in select e.id from public.crm_inbound_events e where e.conversation_id=NEW.id and e.source_channel='email'loop perform public.crm_capture_support_event(event_id);end loop;
 end if;return NEW;
end$$;
revoke all on function public.crm_support_ingest_trigger()from public,anon,authenticated,service_role;
drop trigger if exists crm_support_capture_inbound on public.crm_inbound_events;
create trigger crm_support_capture_inbound after insert on public.crm_inbound_events for each row execute function public.crm_support_ingest_trigger();
drop trigger if exists crm_support_capture_classification on public.crm_conversations;
create trigger crm_support_capture_classification after update of qualification_data on public.crm_conversations for each row execute function public.crm_support_ingest_trigger();
create or replace function public.crm_reconcile_support_preparation(p_limit integer default 100)returns integer language plpgsql security definer set search_path=pg_catalog,public as $$
declare e record;n integer:=0;begin
 if p_limit is null or p_limit<1 or p_limit>500 then raise exception 'SUPPORT_BATCH_INVALID';end if;
 for e in select ev.id from public.crm_inbound_events ev
 join public.crm_conversations c on c.id=ev.conversation_id
 cross join public.crm_support_preparation_config cfg
 left join public.crm_support_ingest_journal j on j.event_id=ev.id
 where cfg.producer_enabled and j.routing_state is distinct from 'support_ready' and (
 (ev.source_channel='email' and ev.origin='support_email' and c.qualification_data#>>'{mailbox,address}'='support@padbol.com') or
 (ev.source_channel='whatsapp' and ev.origin=cfg.whatsapp_origin and exists(select 1 from public.crm_support_event_context x where x.event_id=ev.id and x.conversation_id=c.id and x.origin=ev.origin and x.source_ref=ev.source_ref and x.confirmed and x.effective_topic='soporte')))
 order by ev.created_at,ev.id limit p_limit loop if public.crm_capture_support_event(e.id)then n:=n+1;end if;end loop;
 return n;
end$$;
revoke all on function public.crm_reconcile_support_preparation(integer)from public,anon,authenticated;
grant execute on function public.crm_reconcile_support_preparation(integer)to service_role;
commit;
