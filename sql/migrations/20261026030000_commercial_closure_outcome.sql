begin;
alter table public.crm_commercial_cases add column if not exists closure_outcome text check(closure_outcome in ('venta_concretada','no_avanzo'));
alter table public.crm_commercial_form_cases add column if not exists closure_outcome text check(closure_outcome in ('venta_concretada','no_avanzo'));
create or replace function public.crm_commercial_closure_guard() returns trigger language plpgsql set search_path=pg_catalog,public as $$
declare requested text:=nullif(current_setting('padbol.commercial_closure_outcome',true),'');
begin
 if new.progress_state='cerrado' then
  if requested is not null then
   if requested not in ('venta_concretada','no_avanzo') then raise exception 'closure outcome invalid';end if;
   new.closure_outcome:=requested;
  end if;
  if old.progress_state is distinct from 'cerrado' and new.closure_outcome is null then raise exception 'closure outcome required';end if;
  if old.progress_state='cerrado' and old.closure_outcome is not null and new.closure_outcome is null then raise exception 'closure outcome required';end if;
 else new.closure_outcome:=null;
 end if;
 return new;
end$$;
create trigger crm_commercial_closure_guard before update of progress_state,closure_outcome on public.crm_commercial_cases for each row execute function public.crm_commercial_closure_guard();
create trigger crm_commercial_form_closure_guard before update of progress_state,closure_outcome on public.crm_commercial_form_cases for each row execute function public.crm_commercial_closure_guard();
revoke all on function public.crm_commercial_closure_guard() from public,anon,authenticated;
create or replace function public.crm_commercial_team_progress_outcome(p_actor uuid,p_superadmin boolean,p_type text,p_case uuid,p_version bigint,p_state text,p_next text,p_next_contact_at timestamptz,p_reminder_hours integer[],p_outcome text,p_update_schedule boolean default true) returns jsonb language plpgsql set search_path=pg_catalog,public as $$
declare result jsonb;outcome text;previous text:=current_setting('padbol.commercial_closure_outcome',true);
begin
 if p_outcome is not null and (p_outcome not in ('venta_concretada','no_avanzo') or p_state<>'cerrado') then raise exception 'closure outcome invalid';end if;
 perform set_config('padbol.commercial_closure_outcome',coalesce(p_outcome,''),true);
 if p_update_schedule or p_state='cerrado' then result:=public.crm_commercial_team_progress_scheduled(p_actor,p_superadmin,p_type,p_case,p_version,p_state,p_next,p_next_contact_at,p_reminder_hours);
 else result:=public.crm_commercial_team_progress(p_actor,p_superadmin,p_type,p_case,p_version,p_state,p_next);end if;
 perform set_config('padbol.commercial_closure_outcome',coalesce(previous,''),true);
 if p_type='whatsapp' then select closure_outcome into outcome from public.crm_commercial_cases where id=p_case;
 else select closure_outcome into outcome from public.crm_commercial_form_cases where conversation_id=p_case;end if;
 insert into public.crm_commercial_team_audit(actor_id,action,subject_id,details)values(p_actor,'closure_outcome_recorded',p_case,jsonb_build_object('case_type',p_type,'outcome',outcome,'progress_state',p_state,'version',result->'version'));
 return result||jsonb_build_object('closureOutcome',outcome);
end$$;
revoke all on function public.crm_commercial_team_progress_outcome(uuid,boolean,text,uuid,bigint,text,text,timestamptz,integer[],text,boolean) from public,anon,authenticated;
grant execute on function public.crm_commercial_team_progress_outcome(uuid,boolean,text,uuid,bigint,text,text,timestamptz,integer[],text,boolean) to service_role;
create or replace function public.crm_commercial_team_schedule_read(p_actor uuid,p_superadmin boolean,p_type text,p_case uuid) returns jsonb
language plpgsql stable set search_path=pg_catalog,public as $$
declare v_assigned uuid; v_date timestamptz; v_hours integer[];v_outcome text;
begin
 if p_actor is null or p_type not in ('form','whatsapp') then raise exception 'case unavailable'; end if;
 if p_type='whatsapp' then
  select c.assigned_user_id,c.next_contact_at,c.reminder_hours,c.closure_outcome into v_assigned,v_date,v_hours,v_outcome from public.crm_commercial_cases c
  join public.crm_conversations conv on conv.id=c.conversation_id
  where c.id=p_case and c.status in ('open','suspended') and conv.source_channel='whatsapp' and conv.origin='whatsapp:1376102838911694';
 else
  select assigned_user_id,next_contact_at,reminder_hours,closure_outcome into v_assigned,v_date,v_hours,v_outcome from public.crm_commercial_form_cases
  where conversation_id=p_case and public.crm_commercial_form_is_allowed(p_case);
 end if;
 if v_assigned is null or not public.crm_commercial_team_case_allowed(p_actor,p_superadmin,v_assigned) then raise exception 'case unavailable'; end if;
 return jsonb_build_object('nextContactAt',v_date,'reminderHours',v_hours,'closureOutcome',v_outcome);
end $$;
create or replace function public.crm_commercial_team_schedule_list(p_actor uuid,p_superadmin boolean) returns jsonb
language sql stable set search_path=pg_catalog,public as $$
 select coalesce(jsonb_agg(jsonb_build_object('id',x.id,'channel',x.channel,'conversationId',x.conversation_id,'nextContactAt',x.next_contact_at,'reminderHours',x.reminder_hours,'closureOutcome',x.closure_outcome)),'[]'::jsonb)
 from (
  select c.id,c.conversation_id,'whatsapp'::text channel,c.next_contact_at,c.reminder_hours,c.closure_outcome from public.crm_commercial_cases c
  join public.crm_conversations conv on conv.id=c.conversation_id
  where c.status in ('open','suspended') and conv.source_channel='whatsapp' and conv.origin='whatsapp:1376102838911694'
  and public.crm_commercial_team_case_allowed(p_actor,p_superadmin,c.assigned_user_id)
  union all
  select f.conversation_id,f.conversation_id,'form'::text,f.next_contact_at,f.reminder_hours,f.closure_outcome from public.crm_commercial_form_cases f
  where public.crm_commercial_form_is_allowed(f.conversation_id) and public.crm_commercial_team_case_allowed(p_actor,p_superadmin,f.assigned_user_id)
 ) x where p_actor is not null
$$;
notify pgrst, 'reload schema';
commit;
