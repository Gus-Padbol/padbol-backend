-- Commercial team workspace: managers, advisors, assignment, history and call summaries.
-- This migration is deliberately guarded at application level and has no automatic outbound sends.
-- Candidate foundation, not wired or deployable by itself. No historical backfill.
-- All writes must come from trusted routing logic in the same transaction as
-- inbound classification; these tables alone DO NOT classify messages.
begin;
create table public.crm_commercial_cases (
 id uuid primary key default gen_random_uuid(),
 conversation_id uuid not null references public.crm_conversations(id) on delete restrict,
 assigned_user_id uuid not null,
 status text not null default 'open' check (status in ('open','suspended','closed')),
 created_at timestamptz not null default now(),
 unique (id, conversation_id)
);
create unique index crm_commercial_cases_one_open on public.crm_commercial_cases(conversation_id) where status in ('open','suspended');
create function public.crm_commercial_case_check_conversation() returns trigger
language plpgsql set search_path=pg_catalog,public as $$
begin
 if tg_op='UPDATE' and new.conversation_id<>old.conversation_id then
   raise exception 'commercial case conversation is immutable';
 end if;
 if not exists (select 1 from public.crm_conversations c where c.id=new.conversation_id and c.source_channel='whatsapp') then
   raise exception 'commercial cases require WhatsApp';
 end if;
 return new;
end $$;
create trigger crm_commercial_case_conversation_check before insert or update on public.crm_commercial_cases for each row execute function public.crm_commercial_case_check_conversation();
create table public.crm_commercial_case_inbound (
 case_id uuid not null,
 conversation_id uuid not null,
 inbound_event_id uuid primary key references public.crm_inbound_events(id) on delete restrict,
 foreign key(case_id,conversation_id) references public.crm_commercial_cases(id,conversation_id) on delete restrict
);
create table public.crm_commercial_case_replies (
 case_id uuid not null,
 conversation_id uuid not null,
 reply_id uuid primary key references public.crm_replies(id) on delete restrict,
 foreign key(case_id,conversation_id) references public.crm_commercial_cases(id,conversation_id) on delete restrict
);
create function public.crm_commercial_case_check_membership() returns trigger
language plpgsql set search_path=pg_catalog,public as $$
begin
 if tg_table_name='crm_commercial_case_inbound' then
   if not exists (select 1 from public.crm_inbound_events e where e.id=new.inbound_event_id and e.conversation_id=new.conversation_id and e.source_channel='whatsapp') then
     raise exception 'commercial case inbound does not belong to WhatsApp conversation';
   end if;
 else
   if not exists (select 1 from public.crm_replies r where r.id=new.reply_id and r.conversation_id=new.conversation_id) then
     raise exception 'commercial case reply does not belong to conversation';
   end if;
 end if;
 if not exists (select 1 from public.crm_conversations c where c.id=new.conversation_id and c.source_channel='whatsapp') then
   raise exception 'commercial cases require WhatsApp';
 end if;
 return new;
end $$;
create trigger crm_commercial_case_inbound_check before insert or update on public.crm_commercial_case_inbound for each row execute function public.crm_commercial_case_check_membership();
create trigger crm_commercial_case_reply_check before insert or update on public.crm_commercial_case_replies for each row execute function public.crm_commercial_case_check_membership();
alter table public.crm_commercial_cases enable row level security;
alter table public.crm_commercial_case_inbound enable row level security;
alter table public.crm_commercial_case_replies enable row level security;
revoke all on public.crm_commercial_cases,public.crm_commercial_case_inbound,public.crm_commercial_case_replies from public,anon,authenticated;
grant all on public.crm_commercial_cases,public.crm_commercial_case_inbound,public.crm_commercial_case_replies to service_role;
revoke all on function public.crm_commercial_case_check_membership() from public,anon,authenticated;
revoke all on function public.crm_commercial_case_check_conversation() from public,anon,authenticated;
commit;

-- Candidate only. Requires crm_commercial_cases.sql and the production atomic
-- menu schema. It assigns ONLY menu transitions with a verifiable revision and
-- exact inbound-event binding. It never backfills old conversations and never
-- assigns post-handoff messages lacking a menu transition.
begin;
create function public.crm_commercial_case_route_menu_event() returns trigger
language plpgsql set search_path=pg_catalog,public as $$
declare
 v_conversation public.crm_conversations%rowtype;
 v_provider text; v_event uuid; v_origin text; v_menu jsonb; v_effective jsonb;
 v_case uuid; v_commercial boolean;
 v_assignee constant uuid := '7225442b-defd-42c1-a5a2-b9c1c339fa69';
begin
 -- No transition revision means a stale/ambiguous inbound: never classify it.
 if new.menu_revision is null then return new; end if;
 select * into v_conversation from public.crm_conversations where id=new.conversation_id for update;
 if not found or v_conversation.source_channel <> 'whatsapp' or v_conversation.origin <> 'whatsapp:1376102838911694' then return new; end if;
 select i.provider_message_id, 'whatsapp:'||c.meta_phone_number_id into v_provider,v_origin
 from public.whatsapp_inbound_messages i join public.whatsapp_tenant_channels c on c.id=i.channel_id and c.tenant_id=i.tenant_id
 where i.id=new.inbound_message_id;
 if v_provider is null or v_origin is distinct from v_conversation.origin then return new; end if;
 v_menu:=v_conversation.qualification_data->'whatsapp_menu';
 if v_menu->>'lastEventId' is distinct from v_provider then return new; end if;
 select e.id into v_event from public.crm_inbound_events e where e.conversation_id=new.conversation_id
  and e.source_channel='whatsapp' and e.origin=v_origin and e.source_ref=v_provider;
 if v_event is null then return new; end if;
 -- Once a followup flow exists, use only its explicit topic; never inherit the
 -- previous case topic when the new flow is still unclassified.
 v_effective:=case when jsonb_typeof(v_menu->'followup')='object' then v_menu->'followup' else v_menu end;
 v_commercial:=coalesce(v_effective->>'topic'='sede' and v_effective->>'stage' in ('subtopic','details','selected'),false);
 select id into v_case from public.crm_commercial_cases where conversation_id=new.conversation_id and status in ('open','suspended') for update;
 if not v_commercial and coalesce(v_effective->>'topic','') not in ('match','next_generation','academy','fipa','soporte','otros') then return new; end if;
 if not v_commercial then
   if v_case is not null then update public.crm_commercial_cases set status='closed' where id=v_case; end if;
   return new;
 end if;
 if v_case is null then
   insert into public.crm_commercial_cases(conversation_id,assigned_user_id) values(new.conversation_id,v_assignee) returning id into v_case;
 else
   update public.crm_commercial_cases set status='open' where id=v_case;
 end if;
 insert into public.crm_commercial_case_inbound(case_id,conversation_id,inbound_event_id)
 values(v_case,new.conversation_id,v_event) on conflict(inbound_event_id) do nothing;
 if new.reply_id is not null then
   insert into public.crm_commercial_case_replies(case_id,conversation_id,reply_id)
   values(v_case,new.conversation_id,new.reply_id) on conflict(reply_id) do nothing;
 end if;
 return new;
end $$;
revoke all on function public.crm_commercial_case_route_menu_event() from public,anon,authenticated;
create trigger crm_commercial_case_route_menu_event after insert on public.crm_whatsapp_menu_events
for each row execute function public.crm_commercial_case_route_menu_event();
-- Ingress is recorded before menu classification. Suspend the prior case in
-- that transaction; do not expose or reply against it while the new message
-- could concern another topic. A verified transition can reopen it.
create function public.crm_commercial_case_suspend_on_inbound() returns trigger
language plpgsql set search_path=pg_catalog,public as $$
begin
 if new.source_channel='whatsapp' then
   update public.crm_commercial_cases set status='suspended'
   where conversation_id=new.conversation_id and status in ('open','suspended');
 end if;
 return new;
end $$;
revoke all on function public.crm_commercial_case_suspend_on_inbound() from public,anon,authenticated;
create trigger crm_commercial_case_suspend_on_inbound after insert on public.crm_inbound_events
for each row execute function public.crm_commercial_case_suspend_on_inbound();
commit;

-- Candidate only; service-role callers must authenticate and bind p_actor to
-- the verified session. This claims and records a reply, but does not send it.
-- A sender must serialize against inbound ingestion until the provider call is
-- complete and must preserve the existing idempotency and uncertain-send rules.
begin;
create table public.crm_commercial_case_send_attempts (
 reply_id uuid primary key references public.crm_replies(id) on delete restrict,
 case_id uuid not null references public.crm_commercial_cases(id) on delete restrict,
 status text not null default 'reserved' check (status in ('reserved','dispatching','sent','cancelled','uncertain'))
);
alter table public.crm_commercial_case_send_attempts enable row level security;
revoke all on public.crm_commercial_case_send_attempts from public,anon,authenticated;
grant all on public.crm_commercial_case_send_attempts to service_role;
create function public.crm_commercial_case_claim_reply(p_case_id uuid,p_actor uuid,p_reply_id uuid,p_body text,p_operator text)
returns jsonb language plpgsql set search_path=pg_catalog,public as $$
declare v_conversation uuid; v_case public.crm_commercial_cases%rowtype; v_result jsonb;
begin
 if p_actor is null or p_reply_id is null or length(trim(coalesce(p_body,''))) not between 1 and 4096
    or lower(trim(coalesce(p_operator,''))) <> 'sm@padbol.com' then raise exception 'invalid commercial reply'; end if;
 select conversation_id into v_conversation from public.crm_commercial_cases where id=p_case_id;
 if v_conversation is null then raise exception 'case unavailable'; end if;
 -- Same lock order as menu and ingress: conversation, then case.
 perform 1 from public.crm_conversations where id=v_conversation for update;
 select * into v_case from public.crm_commercial_cases where id=p_case_id for update;
 if not found or v_case.conversation_id<>v_conversation or v_case.assigned_user_id<>p_actor or v_case.status<>'open'
    or p_actor<>'7225442b-defd-42c1-a5a2-b9c1c339fa69'::uuid then raise exception 'case unavailable'; end if;
 v_result:=public.crm_claim_whatsapp_reply(p_reply_id,v_conversation,p_body,lower(trim(p_operator)));
 if coalesce((v_result->>'blocked')::boolean,false) then return v_result; end if;
 if (v_result#>>'{reply,id}')::uuid is distinct from p_reply_id then raise exception 'claim mismatch'; end if;
 if not coalesce((v_result->>'created')::boolean,false) then
   if not exists(select 1 from public.crm_commercial_case_replies where case_id=p_case_id and reply_id=p_reply_id)
      or v_result#>>'{reply,body}'<>p_body or v_result#>>'{reply,operador}'<>lower(trim(p_operator)) then
     raise exception 'reply already claimed elsewhere';
   end if;
 else
   insert into public.crm_commercial_case_replies(case_id,conversation_id,reply_id) values(p_case_id,v_conversation,p_reply_id);
   insert into public.crm_commercial_case_send_attempts(reply_id,case_id) values(p_reply_id,p_case_id);
 end if;
 return v_result;
end $$;
revoke all on function public.crm_commercial_case_claim_reply(uuid,uuid,uuid,text,text) from public,anon,authenticated;
grant execute on function public.crm_commercial_case_claim_reply(uuid,uuid,uuid,text,text) to service_role;
commit;

-- Candidate only. Not wired to production. Requires prior commercial case migrations.
-- Callers must bind p_actor and p_superadmin to the verified server-side session.
begin;
create table public.crm_commercial_advisors (
 user_id uuid primary key references auth.users(id),
 email text not null unique,
 active boolean not null default true,
 created_at timestamptz not null default now(),
 check (email = lower(btrim(email)))
);
create table public.crm_commercial_team_audit (
 id bigint generated always as identity primary key,
 actor_id uuid not null,
 action text not null,
 subject_id uuid not null,
 details jsonb not null default '{}'::jsonb,
 created_at timestamptz not null default now()
);
alter table public.crm_commercial_cases add column assignment_version bigint not null default 0;
alter table public.crm_commercial_advisors enable row level security;
alter table public.crm_commercial_team_audit enable row level security;
revoke all on public.crm_commercial_advisors,public.crm_commercial_team_audit from public,anon,authenticated;
grant all on public.crm_commercial_advisors,public.crm_commercial_team_audit to service_role;
create function public.crm_commercial_team_manage(p_actor uuid,p_superadmin boolean) returns boolean
language sql stable set search_path=pg_catalog,public as $$
 select coalesce(p_superadmin,false) or exists(select 1 from auth.users where id=p_actor
  and id='7225442b-defd-42c1-a5a2-b9c1c339fa69'::uuid and lower(email)='sm@padbol.com' and email_confirmed_at is not null)
$$;
create function public.crm_commercial_advisor_add(p_actor uuid,p_superadmin boolean,p_email text) returns jsonb
language plpgsql set search_path=pg_catalog,public as $$
declare v_user auth.users%rowtype; v_email text:=lower(btrim(coalesce(p_email,'')));
begin
 if not public.crm_commercial_team_manage(p_actor,p_superadmin) or p_actor is null then raise exception 'not authorized'; end if;
 if length(v_email) not between 3 and 254 then raise exception 'advisor unavailable'; end if;
 select * into v_user from auth.users where lower(email)=v_email and email_confirmed_at is not null;
 if not found or v_user.id='7225442b-defd-42c1-a5a2-b9c1c339fa69'::uuid then raise exception 'advisor unavailable'; end if;
 insert into public.crm_commercial_advisors(user_id,email) values(v_user.id,v_email)
 on conflict(user_id) do update set email=excluded.email,active=true;
 insert into public.crm_commercial_team_audit(actor_id,action,subject_id) values(p_actor,'advisor_enabled',v_user.id);
 return jsonb_build_object('id',v_user.id,'email',v_email,'active',true);
end $$;
create function public.crm_commercial_case_assign(p_actor uuid,p_superadmin boolean,p_case uuid,p_advisor uuid,p_version bigint) returns jsonb
language plpgsql set search_path=pg_catalog,public as $$
declare v_case public.crm_commercial_cases%rowtype; v_conversation uuid; v_manager constant uuid:='7225442b-defd-42c1-a5a2-b9c1c339fa69';
begin
 if p_actor is null or not public.crm_commercial_team_manage(p_actor,p_superadmin) then raise exception 'not authorized'; end if;
 if p_version is null then raise exception 'version required'; end if;
 if p_advisor is distinct from v_manager then
  perform 1 from public.crm_commercial_advisors where user_id=p_advisor and active for update;
  if not found then raise exception 'advisor unavailable'; end if;
 end if;
 select conversation_id into v_conversation from public.crm_commercial_cases where id=p_case;
 if v_conversation is null then raise exception 'case unavailable'; end if;
 perform 1 from public.crm_conversations where id=v_conversation for update;
 select * into v_case from public.crm_commercial_cases where id=p_case for update;
 if v_case.status not in ('open','suspended') or not exists (select 1 from public.crm_conversations where id=v_conversation and source_channel='whatsapp' and origin='whatsapp:1376102838911694') then raise exception 'case unavailable'; end if;
 if v_case.assignment_version<>p_version then raise exception 'assignment conflict'; end if;
 if exists(select 1 from public.crm_commercial_case_send_attempts where case_id=p_case and status in ('reserved','dispatching','uncertain')) then raise exception 'pending send'; end if;
 update public.crm_commercial_cases set assigned_user_id=p_advisor,assignment_version=assignment_version+1 where id=p_case returning * into v_case;
 insert into public.crm_commercial_team_audit(actor_id,action,subject_id,details) values(p_actor,'case_assigned',p_case,jsonb_build_object('assigned_user_id',p_advisor,'version',v_case.assignment_version));
 return jsonb_build_object('id',v_case.id,'assignedAdvisorId',v_case.assigned_user_id,'assignmentVersion',v_case.assignment_version);
end $$;
create function public.crm_commercial_advisor_disable(p_actor uuid,p_superadmin boolean,p_advisor uuid) returns void
language plpgsql set search_path=pg_catalog,public as $$
begin
 if p_actor is null or not public.crm_commercial_team_manage(p_actor,p_superadmin) then raise exception 'not authorized'; end if;
 perform 1 from public.crm_commercial_advisors where user_id=p_advisor for update;
 if not found then raise exception 'advisor unavailable'; end if;
 -- Reassignment first avoids orphan cases and races with dispatch or read.
 if exists(select 1 from public.crm_commercial_cases where assigned_user_id=p_advisor and status in ('open','suspended')) then raise exception 'advisor has active cases'; end if;
 update public.crm_commercial_advisors set active=false where user_id=p_advisor;
 insert into public.crm_commercial_team_audit(actor_id,action,subject_id) values(p_actor,'advisor_disabled',p_advisor);
end $$;
revoke all on function public.crm_commercial_team_manage(uuid,boolean),public.crm_commercial_advisor_add(uuid,boolean,text),public.crm_commercial_case_assign(uuid,boolean,uuid,uuid,bigint),public.crm_commercial_advisor_disable(uuid,boolean,uuid) from public,anon,authenticated;
grant execute on function public.crm_commercial_team_manage(uuid,boolean),public.crm_commercial_advisor_add(uuid,boolean,text),public.crm_commercial_case_assign(uuid,boolean,uuid,uuid,bigint),public.crm_commercial_advisor_disable(uuid,boolean,uuid) to service_role;
commit;

begin;
create function public.crm_commercial_team_role(p_actor uuid,p_superadmin boolean) returns text language sql stable set search_path=pg_catalog,public as $$
 select case when p_actor is null then 'none' when public.crm_commercial_team_manage(p_actor,p_superadmin) then 'manager'
 when exists(select 1 from public.crm_commercial_advisors a join auth.users u on u.id=a.user_id where a.user_id=p_actor and a.active and u.email_confirmed_at is not null and lower(u.email)=a.email) then 'advisor' else 'none' end
$$;
revoke all on function public.crm_commercial_team_role(uuid,boolean) from public,anon,authenticated;
grant execute on function public.crm_commercial_team_role(uuid,boolean) to service_role;
commit;

-- Candidate only. Form cases are separate from WhatsApp cases; no email inbox import.
begin;
create table public.crm_commercial_form_cases (
 conversation_id uuid primary key references public.crm_conversations(id) on delete restrict,
 assigned_user_id uuid not null,
 assignment_version bigint not null default 0,
 created_at timestamptz not null default now()
);
alter table public.crm_commercial_form_cases enable row level security;
revoke all on public.crm_commercial_form_cases from public,anon,authenticated;
grant all on public.crm_commercial_form_cases to service_role;
create function public.crm_commercial_form_is_allowed(p_conversation uuid) returns boolean
language sql stable set search_path=pg_catalog,public as $$
 select exists(select 1 from public.crm_conversations c where c.id=p_conversation and c.source_channel='email'
 and c.origin=any(array[
 'web_form:Consulta Padbol · Quiero una cancha Padbol',
 'web_form:Consulta Padbol · Quiero sumar Padbol a mi club',
 'web_form:Consulta Padbol · Quiero abrir un Punto Padbol exclusivo',
 'web_form:Consulta Padbol · Quiero representar Padbol en mi ciudad o región',
 'web_form:Consulta Padbol · Quiero representar Padbol en mi país',
 'web_form:solicitud_licencia','web_form:dev_padbol_contacto_business'])
 and coalesce(c.qualification_data#>>'{routing,workflow}','commercial_lead')='commercial_lead'
 and coalesce(c.qualification_data#>>'{form_submission,fields,workflow}','commercial_lead')='commercial_lead')
$$;
create function public.crm_commercial_form_register() returns trigger language plpgsql set search_path=pg_catalog,public as $$
begin
 if public.crm_commercial_form_is_allowed(new.id) then
  insert into public.crm_commercial_form_cases(conversation_id,assigned_user_id) values(new.id,'7225442b-defd-42c1-a5a2-b9c1c339fa69') on conflict do nothing;
 end if;
 return new;
end $$;
create trigger crm_commercial_form_register after insert or update of origin,source_channel,qualification_data on public.crm_conversations for each row execute function public.crm_commercial_form_register();
-- Backfill only the same narrowly whitelisted origins and non-conflicting workflows.
insert into public.crm_commercial_form_cases(conversation_id,assigned_user_id)
 select id,'7225442b-defd-42c1-a5a2-b9c1c339fa69'::uuid from public.crm_conversations
 where public.crm_commercial_form_is_allowed(id) on conflict do nothing;
create function public.crm_commercial_form_assign(p_actor uuid,p_superadmin boolean,p_conversation uuid,p_advisor uuid,p_version bigint) returns jsonb
language plpgsql set search_path=pg_catalog,public as $$
declare v_case public.crm_commercial_form_cases%rowtype; v_manager constant uuid:='7225442b-defd-42c1-a5a2-b9c1c339fa69';
begin
 if p_actor is null or not public.crm_commercial_team_manage(p_actor,p_superadmin) then raise exception 'not authorized'; end if;
 if p_version is null then raise exception 'version required'; end if;
 if p_advisor is distinct from v_manager then
  perform 1 from public.crm_commercial_advisors where user_id=p_advisor and active for update;
  if not found then raise exception 'advisor unavailable'; end if;
 end if;
 perform 1 from public.crm_conversations where id=p_conversation for update;
 select * into v_case from public.crm_commercial_form_cases where conversation_id=p_conversation for update;
 if not found or not public.crm_commercial_form_is_allowed(p_conversation) then raise exception 'case unavailable'; end if;
 if v_case.assignment_version<>p_version then raise exception 'assignment conflict'; end if;
 -- Existing email reply pipeline must serialize with this lock before enabling assignment.
 if exists(select 1 from public.crm_replies where conversation_id=p_conversation and status='pending') then raise exception 'pending send'; end if;
 update public.crm_commercial_form_cases set assigned_user_id=p_advisor,assignment_version=assignment_version+1 where conversation_id=p_conversation returning * into v_case;
 insert into public.crm_commercial_team_audit(actor_id,action,subject_id,details) values(p_actor,'form_assigned',p_conversation,jsonb_build_object('assigned_user_id',p_advisor,'version',v_case.assignment_version));
 return jsonb_build_object('id',v_case.conversation_id,'assignedAdvisorId',v_case.assigned_user_id,'assignmentVersion',v_case.assignment_version);
end $$;
create or replace function public.crm_commercial_advisor_disable(p_actor uuid,p_superadmin boolean,p_advisor uuid) returns void
language plpgsql set search_path=pg_catalog,public as $$
begin
 if p_actor is null or not public.crm_commercial_team_manage(p_actor,p_superadmin) then raise exception 'not authorized'; end if;
 perform 1 from public.crm_commercial_advisors where user_id=p_advisor for update;
 if not found then raise exception 'advisor unavailable'; end if;
 if exists(select 1 from public.crm_commercial_cases where assigned_user_id=p_advisor and status in ('open','suspended'))
 or exists(select 1 from public.crm_commercial_form_cases f join public.crm_conversations c on c.id=f.conversation_id
 where f.assigned_user_id=p_advisor and c.estado<>'cerrado' and public.crm_commercial_form_is_allowed(c.id)) then raise exception 'advisor has active cases'; end if;
 update public.crm_commercial_advisors set active=false where user_id=p_advisor;
 insert into public.crm_commercial_team_audit(actor_id,action,subject_id) values(p_actor,'advisor_disabled',p_advisor);
end $$;
revoke all on function public.crm_commercial_form_is_allowed(uuid),public.crm_commercial_form_register(),public.crm_commercial_form_assign(uuid,boolean,uuid,uuid,bigint) from public,anon,authenticated;
grant execute on function public.crm_commercial_form_is_allowed(uuid),public.crm_commercial_form_assign(uuid,boolean,uuid,uuid,bigint) to service_role;
commit;

-- Candidate only. Invoke with verified server session and trusted superadmin determination.
begin;
create function public.crm_commercial_team_case_allowed(p_actor uuid,p_superadmin boolean,p_assigned uuid) returns boolean
language sql stable set search_path=pg_catalog,public as $$
 select p_actor is not null and (public.crm_commercial_team_manage(p_actor,p_superadmin)
  or exists(select 1 from public.crm_commercial_advisors a join auth.users u on u.id=a.user_id
    where a.user_id=p_actor and a.user_id=p_assigned and a.active and u.email_confirmed_at is not null and lower(u.email)=a.email))
$$;
create function public.crm_commercial_team_advisors_list(p_actor uuid,p_superadmin boolean) returns jsonb
language plpgsql stable set search_path=pg_catalog,public as $$
begin
 if p_actor is null or not public.crm_commercial_team_manage(p_actor,p_superadmin) then raise exception 'not authorized'; end if;
 return coalesce((select jsonb_agg(jsonb_build_object('id',x.user_id,'name',x.name,'email',x.email,'active',x.active,'status',x.status,'role',x.role) order by x.email) from (
 select a.user_id,a.email as name,a.email,a.active,case when a.active then 'active' else 'inactive' end as status,'advisor' as role from public.crm_commercial_advisors a
 union all select u.id,'Nico',lower(u.email),true,'active','manager' from auth.users u where u.id='7225442b-defd-42c1-a5a2-b9c1c339fa69' and lower(u.email)='sm@padbol.com' and u.email_confirmed_at is not null and not exists(select 1 from public.crm_commercial_advisors a where a.user_id=u.id)
 ) x),'[]'::jsonb);
end $$;
create function public.crm_commercial_team_case_list(p_actor uuid,p_superadmin boolean) returns jsonb
language sql stable set search_path=pg_catalog,public as $$
 select coalesce(jsonb_agg(jsonb_build_object('id',c.id,'status',c.status,'version',c.assignment_version,
  'assignedAdvisor',jsonb_build_object('id',c.assigned_user_id,'name',coalesce(a.email,'Nico')),
  'contact',jsonb_build_object('name',contact.nombre,'phone',contact.phone_normalized),
  'lastMessageAt',(select max(e.received_at) from public.crm_commercial_case_inbound m
    join public.crm_inbound_events e on e.id=m.inbound_event_id and e.conversation_id=c.conversation_id
    where m.case_id=c.id and m.conversation_id=c.conversation_id)) order by c.created_at desc),'[]'::jsonb)
 from public.crm_commercial_cases c join public.crm_conversations conv on conv.id=c.conversation_id
 join public.crm_contacts contact on contact.id=conv.contact_id
 left join public.crm_commercial_advisors a on a.user_id=c.assigned_user_id
 where c.status in ('open','suspended') and conv.source_channel='whatsapp' and conv.origin='whatsapp:1376102838911694'
 and public.crm_commercial_team_case_allowed(p_actor,p_superadmin,c.assigned_user_id)
$$;
create function public.crm_commercial_team_case_read(p_actor uuid,p_superadmin boolean,p_case uuid) returns jsonb
language sql stable set search_path=pg_catalog,public as $$
 select jsonb_build_object('id',c.id,'status',c.status,'version',c.assignment_version,
   'assignedAdvisor',jsonb_build_object('id',c.assigned_user_id,'name',coalesce(a.email,'Nico')),
   'contact',jsonb_build_object('name',contact.nombre,'phone',contact.phone_normalized),
   'inbound',coalesce((select jsonb_agg(jsonb_build_object('id',e.id,'body',e.body,'received_at',e.received_at) order by e.received_at,e.id)
     from public.crm_commercial_case_inbound m join public.crm_inbound_events e on e.id=m.inbound_event_id and e.conversation_id=c.conversation_id
     where m.case_id=c.id and m.conversation_id=c.conversation_id and e.source_channel='whatsapp'),'[]'::jsonb),
   'replies',coalesce((select jsonb_agg(jsonb_build_object('id',r.id,'body',r.body,'status',r.status,'created_at',r.created_at) order by r.created_at,r.id)
     from public.crm_commercial_case_replies m join public.crm_replies r on r.id=m.reply_id and r.conversation_id=c.conversation_id
     where m.case_id=c.id and m.conversation_id=c.conversation_id),'[]'::jsonb))
 from public.crm_commercial_cases c join public.crm_conversations conv on conv.id=c.conversation_id
 join public.crm_contacts contact on contact.id=conv.contact_id
 left join public.crm_commercial_advisors a on a.user_id=c.assigned_user_id
 where c.id=p_case and c.status in ('open','suspended') and conv.source_channel='whatsapp' and conv.origin='whatsapp:1376102838911694'
 and public.crm_commercial_team_case_allowed(p_actor,p_superadmin,c.assigned_user_id)
$$;
revoke all on function public.crm_commercial_team_case_allowed(uuid,boolean,uuid), public.crm_commercial_team_advisors_list(uuid,boolean),public.crm_commercial_team_case_list(uuid,boolean),public.crm_commercial_team_case_read(uuid,boolean,uuid) from public,anon,authenticated;
grant execute on function public.crm_commercial_team_case_allowed(uuid,boolean,uuid), public.crm_commercial_team_advisors_list(uuid,boolean),public.crm_commercial_team_case_list(uuid,boolean),public.crm_commercial_team_case_read(uuid,boolean,uuid) to service_role;
commit;

-- Commercial-only activities are linked to a case; never expose generic CRM history.
begin;
create table public.crm_commercial_team_activities(
 id uuid primary key default gen_random_uuid(), case_type text not null check(case_type in ('whatsapp','form')),
 case_id uuid not null, actor_id uuid not null, body text not null check(length(btrim(body)) between 1 and 2000),
 created_at timestamptz not null default now()
);
alter table public.crm_commercial_team_activities enable row level security;
revoke all on public.crm_commercial_team_activities from public,anon,authenticated;
grant all on public.crm_commercial_team_activities to service_role;
create function public.crm_commercial_team_activity(p_actor uuid,p_superadmin boolean,p_type text,p_case uuid,p_body text) returns jsonb
language plpgsql set search_path=pg_catalog,public as $$
declare v_assigned uuid;v_id uuid;v_conversation uuid;
begin
 if p_actor is null or p_type not in ('whatsapp','form') or length(btrim(coalesce(p_body,''))) not between 1 and 2000 then raise exception 'activity unavailable'; end if;
 perform 1 from public.crm_commercial_advisors where user_id=p_actor for update;
 if p_type='whatsapp' then
  select conversation_id into v_conversation from public.crm_commercial_cases where id=p_case;
  perform 1 from public.crm_conversations where id=v_conversation for update;
  select assigned_user_id into v_assigned from public.crm_commercial_cases where id=p_case and conversation_id=v_conversation and status in ('open','suspended') and exists(select 1 from public.crm_conversations where id=v_conversation and source_channel='whatsapp' and origin='whatsapp:1376102838911694') for update;
 else
  perform 1 from public.crm_conversations where id=p_case for update;
  select assigned_user_id into v_assigned from public.crm_commercial_form_cases where conversation_id=p_case and public.crm_commercial_form_is_allowed(p_case) for update;
 end if;
 if v_assigned is null or not public.crm_commercial_team_case_allowed(p_actor,p_superadmin,v_assigned) then raise exception 'activity unavailable'; end if;
 insert into public.crm_commercial_team_activities(case_type,case_id,actor_id,body) values(p_type,p_case,p_actor,btrim(p_body)) returning id into v_id;
 return jsonb_build_object('id',v_id);
end $$;
create function public.crm_commercial_team_activity_list(p_actor uuid,p_superadmin boolean,p_type text,p_case uuid) returns jsonb
language sql stable set search_path=pg_catalog,public as $$
 select coalesce(jsonb_agg(jsonb_build_object('id',a.id,'body',a.body,'actorId',a.actor_id,'createdAt',a.created_at) order by a.created_at,a.id),'[]'::jsonb)
 from public.crm_commercial_team_activities a where a.case_type=p_type and a.case_id=p_case
 and ((p_type='whatsapp' and exists(select 1 from public.crm_commercial_cases c join public.crm_conversations conv on conv.id=c.conversation_id
 where c.id=p_case and c.status in ('open','suspended') and conv.source_channel='whatsapp' and conv.origin='whatsapp:1376102838911694' and public.crm_commercial_team_case_allowed(p_actor,p_superadmin,c.assigned_user_id)))
 or (p_type='form' and exists(select 1 from public.crm_commercial_form_cases f where f.conversation_id=p_case and public.crm_commercial_form_is_allowed(p_case) and public.crm_commercial_team_case_allowed(p_actor,p_superadmin,f.assigned_user_id))))
$$;
revoke all on function public.crm_commercial_team_activity(uuid,boolean,text,uuid,text),public.crm_commercial_team_activity_list(uuid,boolean,text,uuid) from public,anon,authenticated;
grant execute on function public.crm_commercial_team_activity(uuid,boolean,text,uuid,text),public.crm_commercial_team_activity_list(uuid,boolean,text,uuid) to service_role;
commit;

-- Commercial-specific progress must not alter a shared WhatsApp conversation.
begin;
alter table public.crm_commercial_cases add column progress_state text not null default 'nuevo' check(progress_state in ('nuevo','en_atencion','en_espera','cerrado'));
alter table public.crm_commercial_cases add column commercial_next_step text;
alter table public.crm_commercial_form_cases add column progress_state text not null default 'nuevo' check(progress_state in ('nuevo','en_atencion','en_espera','cerrado'));
alter table public.crm_commercial_form_cases add column commercial_next_step text;
create function public.crm_commercial_team_progress(p_actor uuid,p_superadmin boolean,p_type text,p_case uuid,p_version bigint,p_state text,p_next text) returns jsonb
language plpgsql set search_path=pg_catalog,public as $$
declare v_conv uuid;v_assigned uuid;v_version bigint;
begin
 if p_actor is null or p_type not in ('whatsapp','form') or p_state not in ('nuevo','en_atencion','en_espera','cerrado') or length(coalesce(p_next,''))>2000 or p_version is null or p_version<0 then raise exception 'progress invalid'; end if;
 perform 1 from public.crm_commercial_advisors where user_id=p_actor for update;
 if p_type='whatsapp' then select conversation_id into v_conv from public.crm_commercial_cases where id=p_case; else v_conv:=p_case; end if;
 perform 1 from public.crm_conversations where id=v_conv for update;
 if p_type='whatsapp' then select assigned_user_id,assignment_version into v_assigned,v_version from public.crm_commercial_cases where id=p_case and conversation_id=v_conv and status in ('open','suspended') for update;
 else select assigned_user_id,assignment_version into v_assigned,v_version from public.crm_commercial_form_cases where conversation_id=p_case and public.crm_commercial_form_is_allowed(p_case) for update; end if;
 if v_assigned is null or not public.crm_commercial_team_case_allowed(p_actor,p_superadmin,v_assigned) then raise exception 'case unavailable'; end if;
 if v_version<>p_version then raise exception 'assignment conflict'; end if;
 if exists(select 1 from public.crm_commercial_team_calls where conversation_id=v_conv and status='pending') then raise exception 'call summary required'; end if;
 if p_state='cerrado' and (exists(select 1 from public.crm_replies where conversation_id=v_conv and status='pending') or (p_type='whatsapp' and exists(select 1 from public.crm_commercial_case_send_attempts where case_id=p_case and status in ('reserved','dispatching','uncertain'))) or (p_type='form' and exists(select 1 from public.crm_commercial_form_send_attempts where conversation_id=p_case and status in ('reserved','dispatching','uncertain')))) then raise exception 'pending send'; end if;
 if p_type='whatsapp' then update public.crm_commercial_cases set progress_state=p_state,commercial_next_step=nullif(btrim(coalesce(p_next,'')),''),assignment_version=assignment_version+1 where id=p_case;
 else update public.crm_commercial_form_cases set progress_state=p_state,commercial_next_step=nullif(btrim(coalesce(p_next,'')),''),assignment_version=assignment_version+1 where conversation_id=p_case; end if;
 insert into public.crm_commercial_team_audit(actor_id,action,subject_id) values(p_actor,'progress_updated',p_case);
 return jsonb_build_object('id',p_case,'progressState',p_state,'nextStep',nullif(btrim(coalesce(p_next,'')),''),'version',v_version+1);
end $$;
revoke all on function public.crm_commercial_team_progress(uuid,boolean,text,uuid,bigint,text,text) from public,anon,authenticated;
grant execute on function public.crm_commercial_team_progress(uuid,boolean,text,uuid,bigint,text,text) to service_role;
commit;

-- Candidate only. Calls take place outside the CRM; the record is not a call service.
begin;
create table public.crm_commercial_team_calls (
 id uuid primary key default gen_random_uuid(), case_type text not null check(case_type in ('form','whatsapp')),
 case_id uuid not null, conversation_id uuid not null references public.crm_conversations(id) on delete restrict,
 opened_by uuid not null, completed_by uuid, status text not null default 'pending' check(status in ('pending','completed')),
 situation text, discussed text, distinguishing text, created_at timestamptz not null default now(), completed_at timestamptz,
 check(status='pending' or (length(btrim(coalesce(situation,'')))>=3 and length(btrim(coalesce(discussed,'')))>=3 and length(btrim(coalesce(distinguishing,'')))>=3 and completed_by is not null and completed_at is not null))
);
create unique index crm_commercial_one_pending_call on public.crm_commercial_team_calls(conversation_id) where status='pending';
alter table public.crm_commercial_team_calls enable row level security;
revoke all on public.crm_commercial_team_calls from public,anon,authenticated;
grant all on public.crm_commercial_team_calls to service_role;
create function public.crm_commercial_team_call_open(p_actor uuid,p_superadmin boolean,p_type text,p_case uuid) returns jsonb
language plpgsql set search_path=pg_catalog,public as $$
declare v_assigned uuid;v_conversation uuid;v_id uuid;
begin
 if p_actor is null or p_type not in ('whatsapp','form') then raise exception 'call unavailable'; end if;
 perform 1 from public.crm_commercial_advisors where user_id=p_actor for update;
 if p_type='whatsapp' then select conversation_id into v_conversation from public.crm_commercial_cases where id=p_case;
 else v_conversation:=p_case; end if;
 perform 1 from public.crm_conversations where id=v_conversation for update;
 if p_type='whatsapp' then
  select assigned_user_id into v_assigned from public.crm_commercial_cases where id=p_case and conversation_id=v_conversation and status in ('open','suspended') and exists(select 1 from public.crm_conversations where id=v_conversation and source_channel='whatsapp' and origin='whatsapp:1376102838911694') for update;
 else select assigned_user_id into v_assigned from public.crm_commercial_form_cases where conversation_id=p_case and public.crm_commercial_form_is_allowed(p_case) for update; end if;
 if v_assigned is null or not public.crm_commercial_team_case_allowed(p_actor,p_superadmin,v_assigned) then raise exception 'call unavailable'; end if;
 insert into public.crm_commercial_team_calls(case_type,case_id,conversation_id,opened_by) values(p_type,p_case,v_conversation,p_actor) returning id into v_id;
 insert into public.crm_commercial_team_audit(actor_id,action,subject_id) values(p_actor,'call_opened',v_id);
 return jsonb_build_object('id',v_id,'status','pending');
end $$;
create function public.crm_commercial_team_call_complete(p_actor uuid,p_superadmin boolean,p_type text,p_case uuid,p_call uuid,p_situation text,p_discussed text,p_distinguishing text) returns jsonb
language plpgsql set search_path=pg_catalog,public as $$
declare v_assigned uuid;v_conversation uuid;
begin
 if p_actor is null or p_type not in ('whatsapp','form') or length(btrim(coalesce(p_situation,''))) not between 3 and 2000 or length(btrim(coalesce(p_discussed,''))) not between 3 and 2000 or length(btrim(coalesce(p_distinguishing,''))) not between 3 and 2000 then raise exception 'call summary required'; end if;
 perform 1 from public.crm_commercial_advisors where user_id=p_actor for update;
 if p_type='whatsapp' then select conversation_id into v_conversation from public.crm_commercial_cases where id=p_case; else v_conversation:=p_case; end if;
 perform 1 from public.crm_conversations where id=v_conversation for update;
 if p_type='whatsapp' then
  select assigned_user_id into v_assigned from public.crm_commercial_cases where id=p_case and conversation_id=v_conversation and status in ('open','suspended') and exists(select 1 from public.crm_conversations where id=v_conversation and source_channel='whatsapp' and origin='whatsapp:1376102838911694') for update;
 else select assigned_user_id into v_assigned from public.crm_commercial_form_cases where conversation_id=p_case and public.crm_commercial_form_is_allowed(p_case) for update; end if;
 if v_assigned is null or not public.crm_commercial_team_case_allowed(p_actor,p_superadmin,v_assigned) then raise exception 'call unavailable'; end if;
 update public.crm_commercial_team_calls set status='completed',situation=btrim(p_situation),discussed=btrim(p_discussed),distinguishing=btrim(p_distinguishing),completed_by=p_actor,completed_at=now()
 where id=p_call and case_type=p_type and case_id=p_case and conversation_id=v_conversation and status='pending';
 if not found then raise exception 'call unavailable'; end if;
 insert into public.crm_commercial_team_audit(actor_id,action,subject_id) values(p_actor,'call_completed',p_call);
 return jsonb_build_object('id',p_call,'status','completed');
end $$;
create function public.crm_commercial_team_calls_list(p_actor uuid,p_superadmin boolean,p_type text,p_case uuid) returns jsonb
language sql stable set search_path=pg_catalog,public as $$
 select coalesce(jsonb_agg(jsonb_build_object('id',calls.id,'status',calls.status,'situation',calls.situation,'discussed',calls.discussed,'distinguishing',calls.distinguishing,'createdAt',calls.created_at,'completedAt',calls.completed_at) order by calls.created_at desc),'[]'::jsonb)
 from public.crm_commercial_team_calls calls where calls.case_type=p_type and calls.case_id=p_case and
 ((p_type='whatsapp' and exists(select 1 from public.crm_commercial_cases c join public.crm_conversations cv on cv.id=c.conversation_id where c.id=p_case and c.conversation_id=calls.conversation_id and cv.source_channel='whatsapp' and cv.origin='whatsapp:1376102838911694' and c.status in ('open','suspended') and public.crm_commercial_team_case_allowed(p_actor,p_superadmin,c.assigned_user_id)))
 or (p_type='form' and exists(select 1 from public.crm_commercial_form_cases f where f.conversation_id=p_case and f.conversation_id=calls.conversation_id and public.crm_commercial_form_is_allowed(p_case) and public.crm_commercial_team_case_allowed(p_actor,p_superadmin,f.assigned_user_id))))
$$;
create function public.crm_commercial_block_unfinished_call() returns trigger language plpgsql set search_path=pg_catalog,public as $$
begin
 if exists(select 1 from public.crm_commercial_team_calls where conversation_id=new.id and status='pending')
 and (new.estado is distinct from old.estado or new.next_step is distinct from old.next_step) then raise exception 'call summary required'; end if;
 return new;
end $$;
create trigger crm_commercial_block_unfinished_call before update of estado,next_step on public.crm_conversations for each row execute function public.crm_commercial_block_unfinished_call();
create function public.crm_commercial_block_unfinished_call_activity() returns trigger language plpgsql set search_path=pg_catalog,public as $$
begin
 -- Lock conversation to serialize with opening/completing a call.
 if new.activity_type in ('phone_call','zoom_meeting') and (exists(select 1 from public.crm_commercial_cases where conversation_id=new.conversation_id) or exists(select 1 from public.crm_commercial_form_cases where conversation_id=new.conversation_id)) then raise exception 'use commercial call workflow'; end if;
 perform 1 from public.crm_conversations where id=new.conversation_id for update;
 if exists(select 1 from public.crm_commercial_team_calls where conversation_id=new.conversation_id and status='pending')
 and (nullif(btrim(coalesce(new.next_step,'')),'') is not null or new.follow_up_at is not null) then raise exception 'call summary required'; end if;
 return new;
end $$;
create trigger crm_commercial_block_unfinished_call_activity before insert or update of next_step,follow_up_at on public.crm_activities for each row execute function public.crm_commercial_block_unfinished_call_activity();
revoke all on function public.crm_commercial_team_call_open(uuid,boolean,text,uuid),public.crm_commercial_team_call_complete(uuid,boolean,text,uuid,uuid,text,text,text),public.crm_commercial_team_calls_list(uuid,boolean,text,uuid),public.crm_commercial_block_unfinished_call(),public.crm_commercial_block_unfinished_call_activity() from public,anon,authenticated;
grant execute on function public.crm_commercial_team_call_open(uuid,boolean,text,uuid),public.crm_commercial_team_call_complete(uuid,boolean,text,uuid,uuid,text,text,text),public.crm_commercial_team_calls_list(uuid,boolean,text,uuid) to service_role;
commit;

-- Candidate only: expose no messages outside the exact classified form origin.
begin;
create function public.crm_commercial_team_form_list(p_actor uuid,p_superadmin boolean) returns jsonb language sql stable set search_path=pg_catalog,public as $$
 select coalesce(jsonb_agg(jsonb_build_object('id',c.id,'channel','form','status',c.estado,'version',f.assignment_version,
  'assignedAdvisor',jsonb_build_object('id',f.assigned_user_id,'name',coalesce(a.email,'Nico')),
  'contact',jsonb_build_object('name',contact.nombre,'email',contact.email_normalized,'phone',contact.phone_normalized),
  'lastMessageAt',c.received_at) order by c.received_at desc),'[]'::jsonb)
 from public.crm_commercial_form_cases f join public.crm_conversations c on c.id=f.conversation_id
 join public.crm_contacts contact on contact.id=c.contact_id left join public.crm_commercial_advisors a on a.user_id=f.assigned_user_id
 where public.crm_commercial_form_is_allowed(c.id) and public.crm_commercial_team_case_allowed(p_actor,p_superadmin,f.assigned_user_id)
$$;
create function public.crm_commercial_team_form_read(p_actor uuid,p_superadmin boolean,p_id uuid) returns jsonb language sql stable set search_path=pg_catalog,public as $$
 select jsonb_build_object('id',c.id,'channel','form','status',c.estado,'version',f.assignment_version,
  'assignedAdvisor',jsonb_build_object('id',f.assigned_user_id,'name',coalesce(a.email,'Nico')),
  'contact',jsonb_build_object('name',contact.nombre,'email',contact.email_normalized,'phone',contact.phone_normalized),
  'subject',c.subject,'body',c.inbound_body,'received_at',c.received_at,
  'fields',c.qualification_data#>'{form_submission,fields}',
  'replies',coalesce((select jsonb_agg(jsonb_build_object('id',r.id,'body',r.body,'status',r.status,'created_at',r.created_at) order by r.created_at,r.id) from public.crm_replies r where r.conversation_id=c.id),'[]'::jsonb),
  'activities',coalesce((select jsonb_agg(jsonb_build_object('id',a.id,'type',a.activity_type,'summary',a.summary,'outcome',a.outcome,'next_step',a.next_step,'follow_up_at',a.follow_up_at,'author',a.author,'created_at',a.created_at) order by a.created_at,a.id) from public.crm_activities a where a.conversation_id=c.id),'[]'::jsonb))
 from public.crm_commercial_form_cases f join public.crm_conversations c on c.id=f.conversation_id
 join public.crm_contacts contact on contact.id=c.contact_id left join public.crm_commercial_advisors a on a.user_id=f.assigned_user_id
 where c.id=p_id and public.crm_commercial_form_is_allowed(c.id) and public.crm_commercial_team_case_allowed(p_actor,p_superadmin,f.assigned_user_id)
$$;
revoke all on function public.crm_commercial_team_form_list(uuid,boolean),public.crm_commercial_team_form_read(uuid,boolean,uuid) from public,anon,authenticated;
grant execute on function public.crm_commercial_team_form_list(uuid,boolean),public.crm_commercial_team_form_read(uuid,boolean,uuid) to service_role;
commit;

-- Candidate only. Existing global CRM email send path must use the same locks
-- before this module and form assignment may be enabled in production.
begin;
create table public.crm_commercial_form_send_attempts(
 reply_id uuid primary key references public.crm_replies(id) on delete restrict,
 conversation_id uuid not null references public.crm_commercial_form_cases(conversation_id) on delete restrict,
 actor_id uuid not null, status text not null check(status in ('reserved','dispatching','sent','cancelled','uncertain'))
);
alter table public.crm_commercial_form_send_attempts enable row level security;
revoke all on public.crm_commercial_form_send_attempts from public,anon,authenticated;
grant all on public.crm_commercial_form_send_attempts to service_role;
-- Enforce the same conversation lock for legacy CRM email inserts, too.
create function public.crm_commercial_form_guard_reply_insert() returns trigger language plpgsql set search_path=pg_catalog,public as $$
begin
 if exists(select 1 from public.crm_commercial_form_cases where conversation_id=new.conversation_id) then
  perform 1 from public.crm_conversations where id=new.conversation_id for update;
  perform 1 from public.crm_commercial_form_cases where conversation_id=new.conversation_id for update;
  if not public.crm_commercial_form_is_allowed(new.conversation_id) then raise exception 'form no longer commercial'; end if;
  if exists(select 1 from public.crm_replies where conversation_id=new.conversation_id and status='pending' and id<>new.id) then raise exception 'pending send'; end if;
 end if;
 return new;
end $$;
create trigger crm_commercial_form_guard_reply_insert before insert on public.crm_replies for each row execute function public.crm_commercial_form_guard_reply_insert();
revoke all on function public.crm_commercial_form_guard_reply_insert() from public,anon,authenticated;
create function public.crm_commercial_team_form_claim_reply(p_actor uuid,p_superadmin boolean,p_case uuid,p_reply_id uuid,p_body text) returns jsonb
language plpgsql set search_path=pg_catalog,public as $$
declare v_assigned uuid;v_email text;v_created boolean;v_reply public.crm_replies%rowtype;
begin
 if p_actor is null or p_reply_id is null or length(btrim(coalesce(p_body,''))) not between 1 and 4096 then raise exception 'invalid reply'; end if;
 select lower(email) into v_email from auth.users where id=p_actor and email_confirmed_at is not null;
 if v_email is null then raise exception 'case unavailable'; end if;
 perform 1 from public.crm_commercial_advisors where user_id=p_actor for update;
 perform 1 from public.crm_conversations where id=p_case for update;
 select assigned_user_id into v_assigned from public.crm_commercial_form_cases where conversation_id=p_case for update;
 if v_assigned is null or not public.crm_commercial_form_is_allowed(p_case) or not public.crm_commercial_team_case_allowed(p_actor,p_superadmin,v_assigned) then raise exception 'case unavailable'; end if;
 if exists(select 1 from public.crm_replies where conversation_id=p_case and status='pending' and id<>p_reply_id) or exists(select 1 from public.crm_commercial_form_send_attempts where conversation_id=p_case and status in ('reserved','dispatching','uncertain') and reply_id<>p_reply_id) then return jsonb_build_object('blocked',true); end if;
 insert into public.crm_replies(id,conversation_id,body,operador,status) values(p_reply_id,p_case,btrim(p_body),v_email,'pending') on conflict(id) do nothing returning * into v_reply;
 v_created:=found;
 if not v_created then
  select * into v_reply from public.crm_replies where id=p_reply_id;
  if v_reply.conversation_id<>p_case or v_reply.operador<>v_email or v_reply.body<>btrim(p_body)
     or not exists(select 1 from public.crm_commercial_form_send_attempts where reply_id=p_reply_id and actor_id=p_actor and conversation_id=p_case) then raise exception 'reply conflict'; end if;
 else
  insert into public.crm_commercial_form_send_attempts(reply_id,conversation_id,actor_id,status) values(p_reply_id,p_case,p_actor,'reserved');
 end if;
 return jsonb_build_object('created',v_created,'reply',to_jsonb(v_reply));
end $$;
revoke all on function public.crm_commercial_team_form_claim_reply(uuid,boolean,uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.crm_commercial_team_form_claim_reply(uuid,boolean,uuid,uuid,text) to service_role;
commit;

-- Candidate only. Requires commercial team, case membership and reply claim foundations.
begin;
create function public.crm_commercial_team_claim_reply(p_case_id uuid,p_actor uuid,p_superadmin boolean,p_reply_id uuid,p_body text)
returns jsonb language plpgsql set search_path=pg_catalog,public as $$
declare v_conversation uuid; v_case public.crm_commercial_cases%rowtype; v_result jsonb; v_operator text;
begin
 if p_actor is null or p_reply_id is null or length(trim(coalesce(p_body,''))) not between 1 and 4096 then raise exception 'invalid commercial reply'; end if;
 select lower(email) into v_operator from auth.users where id=p_actor and email_confirmed_at is not null;
 if v_operator is null then raise exception 'case unavailable'; end if;
 -- Advisor first matches assignment and disable ordering; managers need no membership lock.
 perform 1 from public.crm_commercial_advisors where user_id=p_actor for update;
 select conversation_id into v_conversation from public.crm_commercial_cases where id=p_case_id;
 if v_conversation is null then raise exception 'case unavailable'; end if;
 -- Same lock order as menu and ingress: conversation, then case.
 perform 1 from public.crm_conversations where id=v_conversation for update;
 select * into v_case from public.crm_commercial_cases where id=p_case_id for update;
 if not found or v_case.conversation_id<>v_conversation or v_case.status<>'open'
    or not public.crm_commercial_team_case_allowed(p_actor,p_superadmin,v_case.assigned_user_id)
    or not exists(select 1 from public.crm_conversations where id=v_conversation and source_channel='whatsapp' and origin='whatsapp:1376102838911694') then raise exception 'case unavailable'; end if;
 v_result:=public.crm_claim_whatsapp_reply(p_reply_id,v_conversation,p_body,v_operator);
 if coalesce((v_result->>'blocked')::boolean,false) then return v_result; end if;
 if (v_result#>>'{reply,id}')::uuid is distinct from p_reply_id then raise exception 'claim mismatch'; end if;
 if not coalesce((v_result->>'created')::boolean,false) then
   if not exists(select 1 from public.crm_commercial_case_replies where case_id=p_case_id and reply_id=p_reply_id)
      or v_result#>>'{reply,body}'<>p_body or v_result#>>'{reply,operador}'<>v_operator then
     raise exception 'reply already claimed elsewhere';
   end if;
 else
   insert into public.crm_commercial_case_replies(case_id,conversation_id,reply_id) values(p_case_id,v_conversation,p_reply_id);
   insert into public.crm_commercial_case_send_attempts(reply_id,case_id) values(p_reply_id,p_case_id);
 end if;
 return v_result;
end $$;
revoke all on function public.crm_commercial_team_claim_reply(uuid,uuid,boolean,uuid,text) from public,anon,authenticated;
grant execute on function public.crm_commercial_team_claim_reply(uuid,uuid,boolean,uuid,text) to service_role;
commit;

-- Candidate: prevent new replies in commercially closed cases.
begin;
create or replace function public.crm_commercial_team_claim_reply(p_case_id uuid,p_actor uuid,p_superadmin boolean,p_reply_id uuid,p_body text)
returns jsonb language plpgsql set search_path=pg_catalog,public as $$
declare v_conversation uuid; v_case public.crm_commercial_cases%rowtype; v_result jsonb; v_operator text;
begin
 if p_actor is null or p_reply_id is null or length(trim(coalesce(p_body,''))) not between 1 and 4096 then raise exception 'invalid commercial reply'; end if;
 select lower(email) into v_operator from auth.users where id=p_actor and email_confirmed_at is not null;
 if v_operator is null then raise exception 'case unavailable'; end if;
 -- Advisor first matches assignment and disable ordering; managers need no membership lock.
 perform 1 from public.crm_commercial_advisors where user_id=p_actor for update;
 select conversation_id into v_conversation from public.crm_commercial_cases where id=p_case_id;
 if v_conversation is null then raise exception 'case unavailable'; end if;
 -- Same lock order as menu and ingress: conversation, then case.
 perform 1 from public.crm_conversations where id=v_conversation for update;
 select * into v_case from public.crm_commercial_cases where id=p_case_id for update;
 if not found or v_case.conversation_id<>v_conversation or v_case.status<>'open' or v_case.progress_state='cerrado'
    or not public.crm_commercial_team_case_allowed(p_actor,p_superadmin,v_case.assigned_user_id)
    or not exists(select 1 from public.crm_conversations where id=v_conversation and source_channel='whatsapp' and origin='whatsapp:1376102838911694') then raise exception 'case unavailable'; end if;
 v_result:=public.crm_claim_whatsapp_reply(p_reply_id,v_conversation,p_body,v_operator);
 if coalesce((v_result->>'blocked')::boolean,false) then return v_result; end if;
 if (v_result#>>'{reply,id}')::uuid is distinct from p_reply_id then raise exception 'claim mismatch'; end if;
 if not coalesce((v_result->>'created')::boolean,false) then
   if not exists(select 1 from public.crm_commercial_case_replies where case_id=p_case_id and reply_id=p_reply_id)
      or v_result#>>'{reply,body}'<>p_body or v_result#>>'{reply,operador}'<>v_operator then
     raise exception 'reply already claimed elsewhere';
   end if;
 else
   insert into public.crm_commercial_case_replies(case_id,conversation_id,reply_id) values(p_case_id,v_conversation,p_reply_id);
   insert into public.crm_commercial_case_send_attempts(reply_id,case_id) values(p_reply_id,p_case_id);
 end if;
 return v_result;
end $$;
create or replace function public.crm_commercial_team_form_claim_reply(p_actor uuid,p_superadmin boolean,p_case uuid,p_reply_id uuid,p_body text) returns jsonb
language plpgsql set search_path=pg_catalog,public as $$
declare v_assigned uuid;v_email text;v_created boolean;v_reply public.crm_replies%rowtype;
begin
 if p_actor is null or p_reply_id is null or length(btrim(coalesce(p_body,''))) not between 1 and 4096 then raise exception 'invalid reply'; end if;
 select lower(email) into v_email from auth.users where id=p_actor and email_confirmed_at is not null;
 if v_email is null then raise exception 'case unavailable'; end if;
 perform 1 from public.crm_commercial_advisors where user_id=p_actor for update;
 perform 1 from public.crm_conversations where id=p_case for update;
 select assigned_user_id into v_assigned from public.crm_commercial_form_cases where conversation_id=p_case and progress_state<>'cerrado' for update;
 if v_assigned is null or not public.crm_commercial_form_is_allowed(p_case) or not public.crm_commercial_team_case_allowed(p_actor,p_superadmin,v_assigned) then raise exception 'case unavailable'; end if;
 if exists(select 1 from public.crm_replies where conversation_id=p_case and status='pending' and id<>p_reply_id) or exists(select 1 from public.crm_commercial_form_send_attempts where conversation_id=p_case and status in ('reserved','dispatching','uncertain') and reply_id<>p_reply_id) then return jsonb_build_object('blocked',true); end if;
 insert into public.crm_replies(id,conversation_id,body,operador,status) values(p_reply_id,p_case,btrim(p_body),v_email,'pending') on conflict(id) do nothing returning * into v_reply;
 v_created:=found;
 if not v_created then
  select * into v_reply from public.crm_replies where id=p_reply_id;
  if v_reply.conversation_id<>p_case or v_reply.operador<>v_email or v_reply.body<>btrim(p_body)
     or not exists(select 1 from public.crm_commercial_form_send_attempts where reply_id=p_reply_id and actor_id=p_actor and conversation_id=p_case) then raise exception 'reply conflict'; end if;
 else
  insert into public.crm_commercial_form_send_attempts(reply_id,conversation_id,actor_id,status) values(p_reply_id,p_case,p_actor,'reserved');
 end if;
 return jsonb_build_object('created',v_created,'reply',to_jsonb(v_reply));
end $$;
revoke all on function public.crm_commercial_team_claim_reply(uuid,uuid,boolean,uuid,text) from public,anon,authenticated;
grant execute on function public.crm_commercial_team_claim_reply(uuid,uuid,boolean,uuid,text) to service_role;
revoke all on function public.crm_commercial_team_form_claim_reply(uuid,boolean,uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.crm_commercial_team_form_claim_reply(uuid,boolean,uuid,uuid,text) to service_role;
commit;

-- Candidate: apply after progress and media projection.
begin;
create or replace function public.crm_commercial_team_case_list(p_actor uuid,p_superadmin boolean) returns jsonb
language sql stable set search_path=pg_catalog,public as $$
 select coalesce(jsonb_agg(jsonb_build_object('id',c.id,'status',c.status,'version',c.assignment_version,'progressState',c.progress_state,'nextStep',c.commercial_next_step,
  'assignedAdvisor',jsonb_build_object('id',c.assigned_user_id,'name',coalesce(a.email,'Nico')),
  'contact',jsonb_build_object('name',contact.nombre,'phone',contact.phone_normalized),
  'lastMessageAt',(select max(e.received_at) from public.crm_commercial_case_inbound m
    join public.crm_inbound_events e on e.id=m.inbound_event_id and e.conversation_id=c.conversation_id
    where m.case_id=c.id and m.conversation_id=c.conversation_id)) order by c.created_at desc),'[]'::jsonb)
 from public.crm_commercial_cases c join public.crm_conversations conv on conv.id=c.conversation_id
 join public.crm_contacts contact on contact.id=conv.contact_id
 left join public.crm_commercial_advisors a on a.user_id=c.assigned_user_id
 where c.status in ('open','suspended') and conv.source_channel='whatsapp' and conv.origin='whatsapp:1376102838911694'
 and public.crm_commercial_team_case_allowed(p_actor,p_superadmin,c.assigned_user_id)
$$;
create or replace function public.crm_commercial_team_case_read(p_actor uuid,p_superadmin boolean,p_case uuid) returns jsonb
language sql stable set search_path=pg_catalog,public as $$
 select jsonb_build_object('id',c.id,'status',c.status,'version',c.assignment_version,'progressState',c.progress_state,'nextStep',c.commercial_next_step,
   'assignedAdvisor',jsonb_build_object('id',c.assigned_user_id,'name',coalesce(a.email,'Nico')),
   'contact',jsonb_build_object('name',contact.nombre,'phone',contact.phone_normalized),
   'inbound',coalesce((select jsonb_agg(jsonb_build_object('id',e.id,'body',e.body,'received_at',e.received_at,'hasMedia',exists(select 1 from public.whatsapp_inbound_messages w join public.whatsapp_tenant_channels ch on ch.id=w.channel_id and ch.tenant_id=w.tenant_id and ch.meta_phone_number_id='1376102838911694' where w.provider_message_id=e.source_ref and w.meta_media_id ~ '^[0-9]{1,100}$' and w.meta_media_type in ('image','video','document','sticker'))) order by e.received_at,e.id)
     from public.crm_commercial_case_inbound m join public.crm_inbound_events e on e.id=m.inbound_event_id and e.conversation_id=c.conversation_id
     where m.case_id=c.id and m.conversation_id=c.conversation_id and e.source_channel='whatsapp'),'[]'::jsonb),
   'replies',coalesce((select jsonb_agg(jsonb_build_object('id',r.id,'body',r.body,'status',r.status,'created_at',r.created_at) order by r.created_at,r.id)
     from public.crm_commercial_case_replies m join public.crm_replies r on r.id=m.reply_id and r.conversation_id=c.conversation_id
     where m.case_id=c.id and m.conversation_id=c.conversation_id),'[]'::jsonb))
 from public.crm_commercial_cases c join public.crm_conversations conv on conv.id=c.conversation_id
 join public.crm_contacts contact on contact.id=conv.contact_id
 left join public.crm_commercial_advisors a on a.user_id=c.assigned_user_id
 where c.id=p_case and c.status in ('open','suspended') and conv.source_channel='whatsapp' and conv.origin='whatsapp:1376102838911694'
 and public.crm_commercial_team_case_allowed(p_actor,p_superadmin,c.assigned_user_id)
$$;
create or replace function public.crm_commercial_team_form_list(p_actor uuid,p_superadmin boolean) returns jsonb language sql stable set search_path=pg_catalog,public as $$
 select coalesce(jsonb_agg(jsonb_build_object('id',c.id,'channel','form','status',c.estado,'version',f.assignment_version,'progressState',f.progress_state,'nextStep',f.commercial_next_step,
  'assignedAdvisor',jsonb_build_object('id',f.assigned_user_id,'name',coalesce(a.email,'Nico')),
  'contact',jsonb_build_object('name',contact.nombre,'email',contact.email_normalized,'phone',contact.phone_normalized),
  'lastMessageAt',c.received_at) order by c.received_at desc),'[]'::jsonb)
 from public.crm_commercial_form_cases f join public.crm_conversations c on c.id=f.conversation_id
 join public.crm_contacts contact on contact.id=c.contact_id left join public.crm_commercial_advisors a on a.user_id=f.assigned_user_id
 where public.crm_commercial_form_is_allowed(c.id) and public.crm_commercial_team_case_allowed(p_actor,p_superadmin,f.assigned_user_id)
$$;
create or replace function public.crm_commercial_team_form_read(p_actor uuid,p_superadmin boolean,p_id uuid) returns jsonb language sql stable set search_path=pg_catalog,public as $$
 select jsonb_build_object('id',c.id,'channel','form','status',c.estado,'version',f.assignment_version,'progressState',f.progress_state,'nextStep',f.commercial_next_step,
  'assignedAdvisor',jsonb_build_object('id',f.assigned_user_id,'name',coalesce(a.email,'Nico')),
  'contact',jsonb_build_object('name',contact.nombre,'email',contact.email_normalized,'phone',contact.phone_normalized),
  'subject',c.subject,'body',c.inbound_body,'received_at',c.received_at,
  'fields',c.qualification_data#>'{form_submission,fields}',
  'replies',coalesce((select jsonb_agg(jsonb_build_object('id',r.id,'body',r.body,'status',r.status,'created_at',r.created_at) order by r.created_at,r.id) from public.crm_replies r where r.conversation_id=c.id),'[]'::jsonb),
  'activities',coalesce((select jsonb_agg(jsonb_build_object('id',a.id,'type',a.activity_type,'summary',a.summary,'outcome',a.outcome,'next_step',a.next_step,'follow_up_at',a.follow_up_at,'author',a.author,'created_at',a.created_at) order by a.created_at,a.id) from public.crm_activities a where a.conversation_id=c.id),'[]'::jsonb))
 from public.crm_commercial_form_cases f join public.crm_conversations c on c.id=f.conversation_id
 join public.crm_contacts contact on contact.id=c.contact_id left join public.crm_commercial_advisors a on a.user_id=f.assigned_user_id
 where c.id=p_id and public.crm_commercial_form_is_allowed(c.id) and public.crm_commercial_team_case_allowed(p_actor,p_superadmin,f.assigned_user_id)
$$;
revoke all on function public.crm_commercial_team_case_list(uuid,boolean) from public,anon,authenticated;
grant execute on function public.crm_commercial_team_case_list(uuid,boolean) to service_role;
revoke all on function public.crm_commercial_team_case_read(uuid,boolean,uuid) from public,anon,authenticated;
grant execute on function public.crm_commercial_team_case_read(uuid,boolean,uuid) to service_role;
revoke all on function public.crm_commercial_team_form_list(uuid,boolean) from public,anon,authenticated;
grant execute on function public.crm_commercial_team_form_list(uuid,boolean) to service_role;
revoke all on function public.crm_commercial_team_form_read(uuid,boolean,uuid) from public,anon,authenticated;
grant execute on function public.crm_commercial_team_form_read(uuid,boolean,uuid) to service_role;
commit;

-- Candidate only. Return a conversation only for an explicitly linked commercial event.
begin;
create function public.crm_commercial_team_media_member(p_actor uuid,p_superadmin boolean,p_case uuid,p_event uuid) returns jsonb
language sql stable set search_path=pg_catalog,public as $$
 select jsonb_build_object('conversationId',c.conversation_id,'version',c.assignment_version)
 from public.crm_commercial_cases c
 join public.crm_conversations conv on conv.id=c.conversation_id
 join public.crm_commercial_case_inbound m on m.case_id=c.id and m.conversation_id=c.conversation_id and m.inbound_event_id=p_event
 join public.crm_inbound_events e on e.id=m.inbound_event_id and e.conversation_id=c.conversation_id
 join public.whatsapp_inbound_messages w on w.provider_message_id=e.source_ref
 join public.whatsapp_tenant_channels ch on ch.id=w.channel_id and ch.tenant_id=w.tenant_id and ch.meta_phone_number_id='1376102838911694'
 where c.id=p_case and c.status in ('open','suspended') and e.source_channel='whatsapp'
 and w.meta_media_type in ('image','video','document','sticker')
 and conv.source_channel='whatsapp' and conv.origin='whatsapp:1376102838911694'
 and public.crm_commercial_team_case_allowed(p_actor,p_superadmin,c.assigned_user_id)
$$;
revoke all on function public.crm_commercial_team_media_member(uuid,boolean,uuid,uuid) from public,anon,authenticated;
grant execute on function public.crm_commercial_team_media_member(uuid,boolean,uuid,uuid) to service_role;
commit;

-- Candidate: apply after the media reference migration and team read.
begin;
create or replace function public.crm_commercial_team_case_read(p_actor uuid,p_superadmin boolean,p_case uuid) returns jsonb
language sql stable set search_path=pg_catalog,public as $$
 select jsonb_build_object('id',c.id,'status',c.status,'version',c.assignment_version,
   'assignedAdvisor',jsonb_build_object('id',c.assigned_user_id,'name',coalesce(a.email,'Nico')),
   'contact',jsonb_build_object('name',contact.nombre,'phone',contact.phone_normalized),
   'inbound',coalesce((select jsonb_agg(jsonb_build_object('id',e.id,'body',e.body,'received_at',e.received_at,'hasMedia',exists(select 1 from public.whatsapp_inbound_messages w join public.whatsapp_tenant_channels ch on ch.id=w.channel_id and ch.tenant_id=w.tenant_id and ch.meta_phone_number_id='1376102838911694' where w.provider_message_id=e.source_ref and w.meta_media_id ~ '^[0-9]{1,100}$' and w.meta_media_type in ('image','video','document','sticker'))) order by e.received_at,e.id)
     from public.crm_commercial_case_inbound m join public.crm_inbound_events e on e.id=m.inbound_event_id and e.conversation_id=c.conversation_id
     where m.case_id=c.id and m.conversation_id=c.conversation_id and e.source_channel='whatsapp'),'[]'::jsonb),
   'replies',coalesce((select jsonb_agg(jsonb_build_object('id',r.id,'body',r.body,'status',r.status,'created_at',r.created_at) order by r.created_at,r.id)
     from public.crm_commercial_case_replies m join public.crm_replies r on r.id=m.reply_id and r.conversation_id=c.conversation_id
     where m.case_id=c.id and m.conversation_id=c.conversation_id),'[]'::jsonb))
 from public.crm_commercial_cases c join public.crm_conversations conv on conv.id=c.conversation_id
 join public.crm_contacts contact on contact.id=conv.contact_id
 left join public.crm_commercial_advisors a on a.user_id=c.assigned_user_id
 where c.id=p_case and c.status in ('open','suspended') and conv.source_channel='whatsapp' and conv.origin='whatsapp:1376102838911694'
 and public.crm_commercial_team_case_allowed(p_actor,p_superadmin,c.assigned_user_id)
$$;
revoke all on function public.crm_commercial_team_case_read(uuid,boolean,uuid) from public,anon,authenticated;
grant execute on function public.crm_commercial_team_case_read(uuid,boolean,uuid) to service_role;
commit;

