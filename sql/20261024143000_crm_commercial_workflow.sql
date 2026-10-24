-- Commercial workflow: assignments, mandatory interaction records and manually armed follow-up.
-- Browser roles have no access; all actions go through authenticated backend service_role calls.
begin;

create table if not exists public.crm_commercial_cases (
  conversation_id uuid primary key references public.crm_conversations(id) on delete cascade,
  assigned_user_id uuid,
  assigned_by uuid,
  assignment_note text,
  stage text not null default 'new' check (stage in ('new','active','waiting','won','lost')),
  next_action text,
  next_action_at timestamptz,
  followup_enabled boolean not null default false,
  followup_plan text,
  followup_activated_at timestamptz,
  followup_activated_by uuid,
  version bigint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (assignment_note is null or length(trim(assignment_note)) between 1 and 2000),
  check (next_action is null or length(trim(next_action)) between 1 and 2000),
  check (followup_plan is null or length(trim(followup_plan)) between 1 and 120),
  check ((not followup_enabled and followup_plan is null and followup_activated_at is null and followup_activated_by is null)
      or (followup_enabled and stage='waiting' and followup_plan is not null and followup_activated_at is not null and followup_activated_by is not null))
);

create table if not exists public.crm_commercial_interactions (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.crm_conversations(id) on delete cascade,
  actor_id uuid not null,
  actor_email text not null,
  kind text not null check (kind in ('call','meeting','message','note')),
  summary text not null check (length(trim(summary)) between 3 and 4000),
  outcome text not null check (length(trim(outcome)) between 3 and 2000),
  next_stage text not null check (next_stage in ('active','waiting','won','lost')),
  next_action text,
  next_action_at timestamptz,
  created_at timestamptz not null default now(),
  check (next_action is null or length(trim(next_action)) between 1 and 2000),
  check ((next_stage <> 'waiting') or (next_action is not null and next_action_at is not null))
);
create index if not exists idx_crm_commercial_cases_assigned on public.crm_commercial_cases(assigned_user_id,stage,updated_at desc);
create index if not exists idx_crm_commercial_interactions_conversation on public.crm_commercial_interactions(conversation_id,created_at desc);

alter table public.crm_commercial_cases enable row level security;
alter table public.crm_commercial_interactions enable row level security;
revoke all on public.crm_commercial_cases, public.crm_commercial_interactions from public, anon, authenticated;
grant all on public.crm_commercial_cases, public.crm_commercial_interactions to service_role;

create or replace function public.crm_commercial_assign(
  p_conversation uuid,p_actor uuid,p_assignee uuid,p_note text,p_version bigint
) returns jsonb language plpgsql security invoker set search_path=public as $$
declare c public.crm_commercial_cases%rowtype; conv public.crm_conversations%rowtype;
begin
  select * into conv from public.crm_conversations where id=p_conversation for update;
  if not found then raise exception 'Conversation not found' using errcode='P0002'; end if;
  insert into public.crm_commercial_cases(conversation_id,assigned_user_id,assigned_by,assignment_note,stage,version)
  values(p_conversation,p_assignee,p_actor,nullif(btrim(p_note),''),'active',0)
  on conflict(conversation_id) do nothing;
  select * into c from public.crm_commercial_cases where conversation_id=p_conversation for update;
  if c.version<>p_version then raise exception 'Case changed' using errcode='40001'; end if;
  update public.crm_commercial_cases set assigned_user_id=p_assignee,assigned_by=p_actor,assignment_note=nullif(btrim(p_note),''),stage=case when stage in ('won','lost') then stage else 'active' end,followup_enabled=false,followup_plan=null,followup_activated_at=null,followup_activated_by=null,version=version+1,updated_at=now() where conversation_id=p_conversation returning * into c;
  update public.crm_conversations set operador=null,estado='derivado',derivado=true,updated_at=now() where id=p_conversation;
  return to_jsonb(c);
end $$;

create or replace function public.crm_commercial_record_interaction(
  p_conversation uuid,p_actor uuid,p_email text,p_kind text,p_summary text,p_outcome text,p_stage text,p_next_action text,p_next_action_at timestamptz,p_version bigint
) returns jsonb language plpgsql security invoker set search_path=public as $$
declare c public.crm_commercial_cases%rowtype; i public.crm_commercial_interactions%rowtype;
begin
  insert into public.crm_commercial_cases(conversation_id,stage,version) values(p_conversation,'new',0) on conflict(conversation_id) do nothing;
  select * into c from public.crm_commercial_cases where conversation_id=p_conversation for update;
  if not found then raise exception 'Conversation not found' using errcode='P0002'; end if;
  if c.version<>p_version then raise exception 'Case changed' using errcode='40001'; end if;
  if length(btrim(coalesce(p_summary,'')))<3 or length(btrim(coalesce(p_outcome,'')))<3 then raise exception 'Summary and outcome required' using errcode='22023'; end if;
  if p_stage='waiting' and (length(btrim(coalesce(p_next_action,'')))<1 or p_next_action_at is null) then raise exception 'Waiting requires next action' using errcode='22023'; end if;
  insert into public.crm_commercial_interactions(conversation_id,actor_id,actor_email,kind,summary,outcome,next_stage,next_action,next_action_at)
  values(p_conversation,p_actor,lower(btrim(p_email)),p_kind,btrim(p_summary),btrim(p_outcome),p_stage,nullif(btrim(p_next_action),''),p_next_action_at) returning * into i;
  update public.crm_commercial_cases set stage=p_stage,next_action=nullif(btrim(p_next_action),''),next_action_at=p_next_action_at,
    followup_enabled=false,followup_plan=null,followup_activated_at=null,followup_activated_by=null,version=version+1,updated_at=now() where conversation_id=p_conversation returning * into c;
  update public.crm_conversations set estado=case when p_stage in ('won','lost') then 'cerrado' else 'en_atencion' end,operador=lower(btrim(p_email)),updated_at=now() where id=p_conversation;
  return jsonb_build_object('case',to_jsonb(c),'interaction',to_jsonb(i));
end $$;

create or replace function public.crm_commercial_activate_followup(
  p_conversation uuid,p_actor uuid,p_plan text,p_version bigint
) returns jsonb language plpgsql security invoker set search_path=public as $$
declare c public.crm_commercial_cases%rowtype;
begin
  select * into c from public.crm_commercial_cases where conversation_id=p_conversation for update;
  if not found then raise exception 'Commercial case not found' using errcode='P0002'; end if;
  if c.version<>p_version then raise exception 'Case changed' using errcode='40001'; end if;
  if c.stage<>'waiting' then raise exception 'Follow-up can only be activated while waiting' using errcode='22023'; end if;
  if length(btrim(coalesce(p_plan,'')))<3 then raise exception 'Follow-up plan required' using errcode='22023'; end if;
  update public.crm_commercial_cases set followup_enabled=true,followup_plan=btrim(p_plan),followup_activated_at=now(),followup_activated_by=p_actor,version=version+1,updated_at=now() where conversation_id=p_conversation returning * into c;
  return to_jsonb(c);
end $$;

-- Any inbound contact resumes human attention and prevents automatic follow-ups.
create or replace function public.crm_commercial_pause_followup_on_inbound() returns trigger language plpgsql security invoker set search_path=public as $$
begin
  update public.crm_commercial_cases set followup_enabled=false,followup_plan=null,followup_activated_at=null,followup_activated_by=null,version=version+1,updated_at=now()
   where conversation_id=new.conversation_id and followup_enabled=true;
  return new;
end $$;
drop trigger if exists crm_commercial_pause_followup_on_inbound on public.crm_inbound_events;
create trigger crm_commercial_pause_followup_on_inbound after insert on public.crm_inbound_events for each row execute function public.crm_commercial_pause_followup_on_inbound();

revoke all on function public.crm_commercial_assign(uuid,uuid,uuid,text,bigint),public.crm_commercial_record_interaction(uuid,uuid,text,text,text,text,text,text,timestamptz,bigint),public.crm_commercial_activate_followup(uuid,uuid,text,bigint) from public,anon,authenticated;
grant execute on function public.crm_commercial_assign(uuid,uuid,uuid,text,bigint),public.crm_commercial_record_interaction(uuid,uuid,text,text,text,text,text,text,timestamptz,bigint),public.crm_commercial_activate_followup(uuid,uuid,text,bigint) to service_role;
commit;
