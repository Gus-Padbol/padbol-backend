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
