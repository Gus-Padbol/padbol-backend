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
