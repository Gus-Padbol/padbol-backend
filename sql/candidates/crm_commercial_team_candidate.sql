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
