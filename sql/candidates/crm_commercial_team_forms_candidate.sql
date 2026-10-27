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
