-- Hidden QA stays available only through the existing owner restoration workflow.
-- No rows, assignments, historical activity or audit entries are deleted.
begin;

create or replace function public.crm_commercial_form_is_allowed(p_conversation uuid) returns boolean
language sql stable set search_path=pg_catalog,public as $$
 select exists(select 1 from public.crm_conversations c where c.id=p_conversation and c.source_channel='email' and c.test_hidden_at is null
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

revoke all on function public.crm_commercial_form_is_allowed(uuid) from public,anon,authenticated;
grant execute on function public.crm_commercial_form_is_allowed(uuid) to service_role;

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
 where c.status in ('open','suspended') and conv.source_channel='whatsapp' and conv.origin='whatsapp:1376102838911694' and conv.test_hidden_at is null
 and public.crm_commercial_team_case_allowed(p_actor,p_superadmin,c.assigned_user_id)
$$;

revoke all on function public.crm_commercial_team_case_list(uuid,boolean) from public,anon,authenticated;
grant execute on function public.crm_commercial_team_case_list(uuid,boolean) to service_role;

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
 where c.id=p_case and c.status in ('open','suspended') and conv.source_channel='whatsapp' and conv.origin='whatsapp:1376102838911694' and conv.test_hidden_at is null
 and public.crm_commercial_team_case_allowed(p_actor,p_superadmin,c.assigned_user_id)
$$;

revoke all on function public.crm_commercial_team_case_read(uuid,boolean,uuid) from public,anon,authenticated;
grant execute on function public.crm_commercial_team_case_read(uuid,boolean,uuid) to service_role;

create or replace function public.crm_commercial_team_activity(p_actor uuid,p_superadmin boolean,p_type text,p_case uuid,p_body text) returns jsonb
language plpgsql set search_path=pg_catalog,public as $$
declare v_assigned uuid;v_id uuid;v_conversation uuid;
begin
 if p_actor is null or p_type not in ('whatsapp','form') or length(btrim(coalesce(p_body,''))) not between 1 and 2000 then raise exception 'activity unavailable'; end if;
 perform 1 from public.crm_commercial_advisors where user_id=p_actor for update;
 if p_type='whatsapp' then
  select conversation_id into v_conversation from public.crm_commercial_cases where id=p_case;
  perform 1 from public.crm_conversations where id=v_conversation for update;
  select assigned_user_id into v_assigned from public.crm_commercial_cases where id=p_case and conversation_id=v_conversation and status in ('open','suspended') and exists(select 1 from public.crm_conversations where id=v_conversation and source_channel='whatsapp' and origin='whatsapp:1376102838911694' and test_hidden_at is null) for update;
 else
  perform 1 from public.crm_conversations where id=p_case for update;
  select assigned_user_id into v_assigned from public.crm_commercial_form_cases where conversation_id=p_case and public.crm_commercial_form_is_allowed(p_case) for update;
 end if;
 if v_assigned is null or not public.crm_commercial_team_case_allowed(p_actor,p_superadmin,v_assigned) then raise exception 'activity unavailable'; end if;
 insert into public.crm_commercial_team_activities(case_type,case_id,actor_id,body) values(p_type,p_case,p_actor,btrim(p_body)) returning id into v_id;
 return jsonb_build_object('id',v_id);
end $$;

revoke all on function public.crm_commercial_team_activity(uuid,boolean,text,uuid,text) from public,anon,authenticated;
grant execute on function public.crm_commercial_team_activity(uuid,boolean,text,uuid,text) to service_role;

create or replace function public.crm_commercial_team_activity_list(p_actor uuid,p_superadmin boolean,p_type text,p_case uuid) returns jsonb
language sql stable set search_path=pg_catalog,public as $$
 select coalesce(jsonb_agg(jsonb_build_object('id',a.id,'body',a.body,'actorId',a.actor_id,'createdAt',a.created_at) order by a.created_at,a.id),'[]'::jsonb)
 from public.crm_commercial_team_activities a where a.case_type=p_type and a.case_id=p_case
 and ((p_type='whatsapp' and exists(select 1 from public.crm_commercial_cases c join public.crm_conversations conv on conv.id=c.conversation_id
 where c.id=p_case and c.status in ('open','suspended') and conv.source_channel='whatsapp' and conv.origin='whatsapp:1376102838911694' and conv.test_hidden_at is null and public.crm_commercial_team_case_allowed(p_actor,p_superadmin,c.assigned_user_id)))
 or (p_type='form' and exists(select 1 from public.crm_commercial_form_cases f where f.conversation_id=p_case and public.crm_commercial_form_is_allowed(p_case) and public.crm_commercial_team_case_allowed(p_actor,p_superadmin,f.assigned_user_id))))
$$;

revoke all on function public.crm_commercial_team_activity_list(uuid,boolean,text,uuid) from public,anon,authenticated;
grant execute on function public.crm_commercial_team_activity_list(uuid,boolean,text,uuid) to service_role;

create or replace function public.crm_commercial_team_progress(p_actor uuid,p_superadmin boolean,p_type text,p_case uuid,p_version bigint,p_state text,p_next text) returns jsonb
language plpgsql set search_path=pg_catalog,public as $$
declare v_conv uuid;v_assigned uuid;v_version bigint;
begin
 if p_actor is null or p_type not in ('whatsapp','form') or p_state not in ('nuevo','en_atencion','en_espera','cerrado') or length(coalesce(p_next,''))>2000 or p_version is null or p_version<0 then raise exception 'progress invalid'; end if;
 perform 1 from public.crm_commercial_advisors where user_id=p_actor for update;
 if p_type='whatsapp' then select conversation_id into v_conv from public.crm_commercial_cases where id=p_case; else v_conv:=p_case; end if;
 perform 1 from public.crm_conversations where id=v_conv and test_hidden_at is null for update;
 if not found then raise exception 'case unavailable'; end if;
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

create or replace function public.crm_commercial_team_call_open(p_actor uuid,p_superadmin boolean,p_type text,p_case uuid) returns jsonb
language plpgsql set search_path=pg_catalog,public as $$
declare v_assigned uuid;v_conversation uuid;v_id uuid;
begin
 if p_actor is null or p_type not in ('whatsapp','form') then raise exception 'call unavailable'; end if;
 perform 1 from public.crm_commercial_advisors where user_id=p_actor for update;
 if p_type='whatsapp' then select conversation_id into v_conversation from public.crm_commercial_cases where id=p_case;
 else v_conversation:=p_case; end if;
 perform 1 from public.crm_conversations where id=v_conversation for update;
 if p_type='whatsapp' then
  select assigned_user_id into v_assigned from public.crm_commercial_cases where id=p_case and conversation_id=v_conversation and status in ('open','suspended') and exists(select 1 from public.crm_conversations where id=v_conversation and source_channel='whatsapp' and origin='whatsapp:1376102838911694' and test_hidden_at is null) for update;
 else select assigned_user_id into v_assigned from public.crm_commercial_form_cases where conversation_id=p_case and public.crm_commercial_form_is_allowed(p_case) for update; end if;
 if v_assigned is null or not public.crm_commercial_team_case_allowed(p_actor,p_superadmin,v_assigned) then raise exception 'call unavailable'; end if;
 insert into public.crm_commercial_team_calls(case_type,case_id,conversation_id,opened_by) values(p_type,p_case,v_conversation,p_actor) returning id into v_id;
 insert into public.crm_commercial_team_audit(actor_id,action,subject_id) values(p_actor,'call_opened',v_id);
 return jsonb_build_object('id',v_id,'status','pending');
end $$;

revoke all on function public.crm_commercial_team_call_open(uuid,boolean,text,uuid) from public,anon,authenticated;
grant execute on function public.crm_commercial_team_call_open(uuid,boolean,text,uuid) to service_role;

create or replace function public.crm_commercial_team_call_complete(p_actor uuid,p_superadmin boolean,p_type text,p_case uuid,p_call uuid,p_situation text,p_discussed text,p_distinguishing text) returns jsonb
language plpgsql set search_path=pg_catalog,public as $$
declare v_assigned uuid;v_conversation uuid;
begin
 if p_actor is null or p_type not in ('whatsapp','form') or length(btrim(coalesce(p_situation,''))) not between 3 and 2000 or length(btrim(coalesce(p_discussed,''))) not between 3 and 2000 or length(btrim(coalesce(p_distinguishing,''))) not between 3 and 2000 then raise exception 'call summary required'; end if;
 perform 1 from public.crm_commercial_advisors where user_id=p_actor for update;
 if p_type='whatsapp' then select conversation_id into v_conversation from public.crm_commercial_cases where id=p_case; else v_conversation:=p_case; end if;
 perform 1 from public.crm_conversations where id=v_conversation for update;
 if p_type='whatsapp' then
  select assigned_user_id into v_assigned from public.crm_commercial_cases where id=p_case and conversation_id=v_conversation and status in ('open','suspended') and exists(select 1 from public.crm_conversations where id=v_conversation and source_channel='whatsapp' and origin='whatsapp:1376102838911694' and test_hidden_at is null) for update;
 else select assigned_user_id into v_assigned from public.crm_commercial_form_cases where conversation_id=p_case and public.crm_commercial_form_is_allowed(p_case) for update; end if;
 if v_assigned is null or not public.crm_commercial_team_case_allowed(p_actor,p_superadmin,v_assigned) then raise exception 'call unavailable'; end if;
 update public.crm_commercial_team_calls set status='completed',situation=btrim(p_situation),discussed=btrim(p_discussed),distinguishing=btrim(p_distinguishing),completed_by=p_actor,completed_at=now()
 where id=p_call and case_type=p_type and case_id=p_case and conversation_id=v_conversation and status='pending';
 if not found then raise exception 'call unavailable'; end if;
 insert into public.crm_commercial_team_audit(actor_id,action,subject_id) values(p_actor,'call_completed',p_call);
 return jsonb_build_object('id',p_call,'status','completed');
end $$;

revoke all on function public.crm_commercial_team_call_complete(uuid,boolean,text,uuid,uuid,text,text,text) from public,anon,authenticated;
grant execute on function public.crm_commercial_team_call_complete(uuid,boolean,text,uuid,uuid,text,text,text) to service_role;

create or replace function public.crm_commercial_team_calls_list(p_actor uuid,p_superadmin boolean,p_type text,p_case uuid) returns jsonb
language sql stable set search_path=pg_catalog,public as $$
 select coalesce(jsonb_agg(jsonb_build_object('id',calls.id,'status',calls.status,'situation',calls.situation,'discussed',calls.discussed,'distinguishing',calls.distinguishing,'createdAt',calls.created_at,'completedAt',calls.completed_at) order by calls.created_at desc),'[]'::jsonb)
 from public.crm_commercial_team_calls calls where calls.case_type=p_type and calls.case_id=p_case and
 ((p_type='whatsapp' and exists(select 1 from public.crm_commercial_cases c join public.crm_conversations cv on cv.id=c.conversation_id where c.id=p_case and c.conversation_id=calls.conversation_id and cv.source_channel='whatsapp' and cv.origin='whatsapp:1376102838911694' and cv.test_hidden_at is null and c.status in ('open','suspended') and public.crm_commercial_team_case_allowed(p_actor,p_superadmin,c.assigned_user_id)))
 or (p_type='form' and exists(select 1 from public.crm_commercial_form_cases f where f.conversation_id=p_case and f.conversation_id=calls.conversation_id and public.crm_commercial_form_is_allowed(p_case) and public.crm_commercial_team_case_allowed(p_actor,p_superadmin,f.assigned_user_id))))
$$;

revoke all on function public.crm_commercial_team_calls_list(uuid,boolean,text,uuid) from public,anon,authenticated;
grant execute on function public.crm_commercial_team_calls_list(uuid,boolean,text,uuid) to service_role;

create or replace function public.crm_commercial_team_media_member(p_actor uuid,p_superadmin boolean,p_case uuid,p_event uuid) returns jsonb
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
 and conv.source_channel='whatsapp' and conv.origin='whatsapp:1376102838911694' and conv.test_hidden_at is null
 and public.crm_commercial_team_case_allowed(p_actor,p_superadmin,c.assigned_user_id)
$$;

revoke all on function public.crm_commercial_team_media_member(uuid,boolean,uuid,uuid) from public,anon,authenticated;
grant execute on function public.crm_commercial_team_media_member(uuid,boolean,uuid,uuid) to service_role;

create or replace function public.crm_commercial_team_schedule_read(p_actor uuid,p_superadmin boolean,p_type text,p_case uuid) returns jsonb
language plpgsql stable set search_path=pg_catalog,public as $$
declare v_assigned uuid; v_date timestamptz; v_hours integer[];v_outcome text;
begin
 if p_actor is null or p_type not in ('form','whatsapp') then raise exception 'case unavailable'; end if;
 if p_type='whatsapp' then
  select c.assigned_user_id,c.next_contact_at,c.reminder_hours,c.closure_outcome into v_assigned,v_date,v_hours,v_outcome from public.crm_commercial_cases c
  join public.crm_conversations conv on conv.id=c.conversation_id
  where c.id=p_case and c.status in ('open','suspended') and conv.source_channel='whatsapp' and conv.origin='whatsapp:1376102838911694' and conv.test_hidden_at is null;
 else
  select assigned_user_id,next_contact_at,reminder_hours,closure_outcome into v_assigned,v_date,v_hours,v_outcome from public.crm_commercial_form_cases
  where conversation_id=p_case and public.crm_commercial_form_is_allowed(p_case);
 end if;
 if v_assigned is null or not public.crm_commercial_team_case_allowed(p_actor,p_superadmin,v_assigned) then raise exception 'case unavailable'; end if;
 return jsonb_build_object('nextContactAt',v_date,'reminderHours',v_hours,'closureOutcome',v_outcome);
end $$;

revoke all on function public.crm_commercial_team_schedule_read(uuid,boolean,text,uuid) from public,anon,authenticated;
grant execute on function public.crm_commercial_team_schedule_read(uuid,boolean,text,uuid) to service_role;

create or replace function public.crm_commercial_team_schedule_list(p_actor uuid,p_superadmin boolean) returns jsonb
language sql stable set search_path=pg_catalog,public as $$
 select coalesce(jsonb_agg(jsonb_build_object('id',x.id,'channel',x.channel,'conversationId',x.conversation_id,'nextContactAt',x.next_contact_at,'reminderHours',x.reminder_hours,'closureOutcome',x.closure_outcome)),'[]'::jsonb)
 from (
  select c.id,c.conversation_id,'whatsapp'::text channel,c.next_contact_at,c.reminder_hours,c.closure_outcome from public.crm_commercial_cases c
  join public.crm_conversations conv on conv.id=c.conversation_id
  where c.status in ('open','suspended') and conv.source_channel='whatsapp' and conv.origin='whatsapp:1376102838911694' and conv.test_hidden_at is null
  and public.crm_commercial_team_case_allowed(p_actor,p_superadmin,c.assigned_user_id)
  union all
  select f.conversation_id,f.conversation_id,'form'::text,f.next_contact_at,f.reminder_hours,f.closure_outcome from public.crm_commercial_form_cases f
  where public.crm_commercial_form_is_allowed(f.conversation_id) and public.crm_commercial_team_case_allowed(p_actor,p_superadmin,f.assigned_user_id)
 ) x where p_actor is not null
$$;

revoke all on function public.crm_commercial_team_schedule_list(uuid,boolean) from public,anon,authenticated;
grant execute on function public.crm_commercial_team_schedule_list(uuid,boolean) to service_role;

create or replace function public.crm_commercial_followup_case_member(p_actor uuid,p_superadmin boolean,p_type text,p_case uuid)
returns uuid language plpgsql stable set search_path=pg_catalog,public as $$
declare v_conversation uuid; v_assigned uuid;
begin
 if p_type='whatsapp' then
   select c.conversation_id,c.assigned_user_id into v_conversation,v_assigned
   from public.crm_commercial_cases c join public.crm_conversations v on v.id=c.conversation_id
   where c.id=p_case and c.status in ('open','suspended') and v.source_channel='whatsapp' and v.origin='whatsapp:1376102838911694' and v.test_hidden_at is null;
 elsif p_type='form' then
   select f.conversation_id,f.assigned_user_id into v_conversation,v_assigned from public.crm_commercial_form_cases f
   where f.conversation_id=p_case and public.crm_commercial_form_is_allowed(f.conversation_id);
 else raise exception 'followup unavailable';
 end if;
 if v_conversation is null or not public.crm_commercial_team_case_allowed(p_actor,p_superadmin,v_assigned) then raise exception 'followup unavailable'; end if;
 return v_conversation;
end $$;

revoke all on function public.crm_commercial_followup_case_member(uuid,boolean,text,uuid) from public,anon,authenticated;
grant execute on function public.crm_commercial_followup_case_member(uuid,boolean,text,uuid) to service_role;

create or replace function public.crm_commercial_case_assign(p_actor uuid,p_superadmin boolean,p_case uuid,p_advisor uuid,p_version bigint) returns jsonb
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
 if v_case.status not in ('open','suspended') or not exists (select 1 from public.crm_conversations where id=v_conversation and source_channel='whatsapp' and origin='whatsapp:1376102838911694' and test_hidden_at is null) then raise exception 'case unavailable'; end if;
 if v_case.assignment_version<>p_version then raise exception 'assignment conflict'; end if;
 if exists(select 1 from public.crm_commercial_case_send_attempts where case_id=p_case and status in ('reserved','dispatching','uncertain')) then raise exception 'pending send'; end if;
 update public.crm_commercial_cases set assigned_user_id=p_advisor,assignment_version=assignment_version+1 where id=p_case returning * into v_case;
 insert into public.crm_commercial_team_audit(actor_id,action,subject_id,details) values(p_actor,'case_assigned',p_case,jsonb_build_object('assigned_user_id',p_advisor,'version',v_case.assignment_version));
 return jsonb_build_object('id',v_case.id,'assignedAdvisorId',v_case.assigned_user_id,'assignmentVersion',v_case.assignment_version);
end $$;

revoke all on function public.crm_commercial_case_assign(uuid,boolean,uuid,uuid,bigint) from public,anon,authenticated;
grant execute on function public.crm_commercial_case_assign(uuid,boolean,uuid,uuid,bigint) to service_role;

create or replace function public.crm_commercial_team_claim_reply(p_case_id uuid,p_actor uuid,p_superadmin boolean,p_reply_id uuid,p_body text)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
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
    or not exists(select 1 from public.crm_conversations where id=v_conversation and source_channel='whatsapp' and origin='whatsapp:1376102838911694' and test_hidden_at is null) then raise exception 'case unavailable'; end if;
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

notify pgrst, 'reload schema';

commit;
