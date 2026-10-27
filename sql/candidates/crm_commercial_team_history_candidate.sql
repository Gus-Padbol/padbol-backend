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
