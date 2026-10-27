-- Commercial-specific progress must not alter a shared WhatsApp conversation.
begin;
alter table public.crm_commercial_cases add column progress_state text not null default 'nuevo' check(progress_state in ('nuevo','en_atencion','en_espera','cerrado'));
alter table public.crm_commercial_cases add column commercial_next_step text;
alter table public.crm_commercial_form_cases add column progress_state text not null default 'nuevo' check(progress_state in ('nuevo','en_atencion','en_espera','cerrado'));
alter table public.crm_commercial_form_cases add column commercial_next_step text;
create function public.crm_commercial_team_progress(p_actor uuid,p_superadmin boolean,p_type text,p_case uuid,p_version bigint,p_state text,p_next text) returns jsonb
language plpgsql set search_path=pg_catalog,public as $$
declare v_conv uuid;v_assigned uuid;v_version bigint;
begin
 if p_actor is null or p_type not in ('whatsapp','form') or p_state not in ('nuevo','en_atencion','en_espera','cerrado') or length(coalesce(p_next,''))>2000 or p_version is null or p_version<0 then raise exception 'progress invalid'; end if;
 perform 1 from public.crm_commercial_advisors where user_id=p_actor for update;
 if p_type='whatsapp' then select conversation_id into v_conv from public.crm_commercial_cases where id=p_case; else v_conv:=p_case; end if;
 perform 1 from public.crm_conversations where id=v_conv for update;
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
commit;
