-- Per-case appointment only; no messaging worker or automatic WhatsApp dispatch.
begin;
alter table public.crm_commercial_cases add column if not exists next_contact_at timestamptz;
alter table public.crm_commercial_form_cases add column if not exists next_contact_at timestamptz;
alter table public.crm_commercial_cases add column if not exists reminder_hours integer[] not null default array[24,8] check(cardinality(reminder_hours) between 1 and 5 and array_position(reminder_hours,null) is null and 1<=all(reminder_hours) and 720>=all(reminder_hours));
alter table public.crm_commercial_form_cases add column if not exists reminder_hours integer[] not null default array[24,8] check(cardinality(reminder_hours) between 1 and 5 and array_position(reminder_hours,null) is null and 1<=all(reminder_hours) and 720>=all(reminder_hours));
create or replace function public.crm_commercial_team_schedule_read(p_actor uuid,p_superadmin boolean,p_type text,p_case uuid) returns jsonb
language plpgsql stable set search_path=pg_catalog,public as $$
declare v_assigned uuid; v_date timestamptz; v_hours integer[];
begin
 if p_actor is null or p_type not in ('form','whatsapp') then raise exception 'case unavailable'; end if;
 if p_type='whatsapp' then
  select c.assigned_user_id,c.next_contact_at,c.reminder_hours into v_assigned,v_date,v_hours from public.crm_commercial_cases c
  join public.crm_conversations conv on conv.id=c.conversation_id
  where c.id=p_case and c.status in ('open','suspended') and conv.source_channel='whatsapp' and conv.origin='whatsapp:1376102838911694';
 else
  select assigned_user_id,next_contact_at,reminder_hours into v_assigned,v_date,v_hours from public.crm_commercial_form_cases
  where conversation_id=p_case and public.crm_commercial_form_is_allowed(p_case);
 end if;
 if v_assigned is null or not public.crm_commercial_team_case_allowed(p_actor,p_superadmin,v_assigned) then raise exception 'case unavailable'; end if;
 return jsonb_build_object('nextContactAt',v_date,'reminderHours',v_hours);
end $$;
create or replace function public.crm_commercial_team_progress_scheduled(p_actor uuid,p_superadmin boolean,p_type text,p_case uuid,p_version bigint,p_state text,p_next text,p_next_contact_at timestamptz,p_reminder_hours integer[] default array[24,8]) returns jsonb
language plpgsql set search_path=pg_catalog,public as $$
declare v_result jsonb; v_date timestamptz; v_hours integer[];
begin
 if p_reminder_hours is null or cardinality(p_reminder_hours) not between 1 and 5 or array_position(p_reminder_hours,null) is not null or not (1<=all(p_reminder_hours) and 720>=all(p_reminder_hours)) or cardinality(p_reminder_hours)<>(select count(distinct n) from unnest(p_reminder_hours) n) or (p_next_contact_at is not null and not isfinite(p_next_contact_at)) then raise exception 'schedule invalid'; end if;
 if p_state<>'cerrado' and p_next_contact_at is not null and p_next_contact_at<=statement_timestamp() then raise exception 'schedule invalid'; end if;
 -- Existing function holds the conversation/case locks and enforces assignment version,
 -- actor scope, unfinished-call summary and pending-message guards in this transaction.
 select array_agg(n order by n desc) into v_hours from unnest(p_reminder_hours) n;
 v_result:=public.crm_commercial_team_progress(p_actor,p_superadmin,p_type,p_case,p_version,p_state,p_next);
 v_date:=case when p_state='cerrado' then null else p_next_contact_at end;
 if p_type='whatsapp' then update public.crm_commercial_cases set next_contact_at=v_date,reminder_hours=v_hours where id=p_case;
 else update public.crm_commercial_form_cases set next_contact_at=v_date,reminder_hours=v_hours where conversation_id=p_case; end if;
 insert into public.crm_commercial_team_audit(actor_id,action,subject_id,details)
 values(p_actor,'next_contact_updated',p_case,jsonb_build_object('case_type',p_type,'next_contact_at',v_date,'reminder_hours',v_hours,'version',v_result->'version'));
 return v_result||jsonb_build_object('nextContactAt',v_date,'reminderHours',v_hours);
end $$;
create or replace function public.crm_commercial_team_schedule_list(p_actor uuid,p_superadmin boolean) returns jsonb
language sql stable set search_path=pg_catalog,public as $$
 select coalesce(jsonb_agg(jsonb_build_object('id',x.id,'channel',x.channel,'conversationId',x.conversation_id,'nextContactAt',x.next_contact_at,'reminderHours',x.reminder_hours)),'[]'::jsonb)
 from (
  select c.id,c.conversation_id,'whatsapp'::text channel,c.next_contact_at,c.reminder_hours from public.crm_commercial_cases c
  join public.crm_conversations conv on conv.id=c.conversation_id
  where c.status in ('open','suspended') and conv.source_channel='whatsapp' and conv.origin='whatsapp:1376102838911694'
  and public.crm_commercial_team_case_allowed(p_actor,p_superadmin,c.assigned_user_id)
  union all
  select f.conversation_id,f.conversation_id,'form'::text,f.next_contact_at,f.reminder_hours from public.crm_commercial_form_cases f
  where public.crm_commercial_form_is_allowed(f.conversation_id) and public.crm_commercial_team_case_allowed(p_actor,p_superadmin,f.assigned_user_id)
 ) x where p_actor is not null
$$;
revoke all on function public.crm_commercial_team_schedule_list(uuid,boolean) from public,anon,authenticated;
grant execute on function public.crm_commercial_team_schedule_list(uuid,boolean) to service_role;
revoke all on function public.crm_commercial_team_schedule_read(uuid,boolean,text,uuid) from public,anon,authenticated;
grant execute on function public.crm_commercial_team_schedule_read(uuid,boolean,text,uuid) to service_role;
revoke all on function public.crm_commercial_team_progress_scheduled(uuid,boolean,text,uuid,bigint,text,text,timestamptz,integer[]) from public,anon,authenticated;
grant execute on function public.crm_commercial_team_progress_scheduled(uuid,boolean,text,uuid,bigint,text,text,timestamptz,integer[]) to service_role;
notify pgrst, 'reload schema';
commit;
