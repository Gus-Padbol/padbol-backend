begin;
create or replace function public.crm_commercial_team_calls_list(p_actor uuid,p_superadmin boolean,p_type text,p_case uuid) returns jsonb
language sql stable set search_path=pg_catalog,public as $$
 select coalesce(jsonb_agg(jsonb_build_object(
   'id',calls.id,'status',calls.status,'situation',calls.situation,'discussed',calls.discussed,
   'distinguishing',calls.distinguishing,'createdAt',calls.created_at,'completedAt',calls.completed_at,
   'openedBy',calls.opened_by,'completedBy',calls.completed_by
 ) order by calls.created_at desc),'[]'::jsonb)
 from public.crm_commercial_team_calls calls where calls.case_type=p_type and calls.case_id=p_case and
 ((p_type='whatsapp' and exists(select 1 from public.crm_commercial_cases c join public.crm_conversations cv on cv.id=c.conversation_id where c.id=p_case and c.conversation_id=calls.conversation_id and cv.source_channel='whatsapp' and cv.origin='whatsapp:1376102838911694' and cv.test_hidden_at is null and c.status in ('open','suspended') and public.crm_commercial_team_case_allowed(p_actor,p_superadmin,c.assigned_user_id)))
 or (p_type='form' and exists(select 1 from public.crm_commercial_form_cases f where f.conversation_id=p_case and f.conversation_id=calls.conversation_id and public.crm_commercial_form_is_allowed(p_case) and public.crm_commercial_team_case_allowed(p_actor,p_superadmin,f.assigned_user_id))))
$$;
revoke all on function public.crm_commercial_team_calls_list(uuid,boolean,text,uuid) from public,anon,authenticated;
grant execute on function public.crm_commercial_team_calls_list(uuid,boolean,text,uuid) to service_role;
commit;
