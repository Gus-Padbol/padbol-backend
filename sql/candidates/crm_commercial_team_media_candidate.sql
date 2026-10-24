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
