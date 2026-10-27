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
