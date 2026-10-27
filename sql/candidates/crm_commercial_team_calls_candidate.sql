-- Candidate only. Calls take place outside the CRM; the record is not a call service.
begin;
create table public.crm_commercial_team_calls (
 id uuid primary key default gen_random_uuid(), case_type text not null check(case_type in ('form','whatsapp')),
 case_id uuid not null, conversation_id uuid not null references public.crm_conversations(id) on delete restrict,
 opened_by uuid not null, completed_by uuid, status text not null default 'pending' check(status in ('pending','completed')),
 situation text, discussed text, distinguishing text, created_at timestamptz not null default now(), completed_at timestamptz,
 check(status='pending' or (length(btrim(coalesce(situation,'')))>=3 and length(btrim(coalesce(discussed,'')))>=3 and length(btrim(coalesce(distinguishing,'')))>=3 and completed_by is not null and completed_at is not null))
);
create unique index crm_commercial_one_pending_call on public.crm_commercial_team_calls(conversation_id) where status='pending';
alter table public.crm_commercial_team_calls enable row level security;
revoke all on public.crm_commercial_team_calls from public,anon,authenticated;
grant all on public.crm_commercial_team_calls to service_role;
create function public.crm_commercial_team_call_open(p_actor uuid,p_superadmin boolean,p_type text,p_case uuid) returns jsonb
language plpgsql set search_path=pg_catalog,public as $$
declare v_assigned uuid;v_conversation uuid;v_id uuid;
begin
 if p_actor is null or p_type not in ('whatsapp','form') then raise exception 'call unavailable'; end if;
 perform 1 from public.crm_commercial_advisors where user_id=p_actor for update;
 if p_type='whatsapp' then select conversation_id into v_conversation from public.crm_commercial_cases where id=p_case;
 else v_conversation:=p_case; end if;
 perform 1 from public.crm_conversations where id=v_conversation for update;
 if p_type='whatsapp' then
  select assigned_user_id into v_assigned from public.crm_commercial_cases where id=p_case and conversation_id=v_conversation and status in ('open','suspended') and exists(select 1 from public.crm_conversations where id=v_conversation and source_channel='whatsapp' and origin='whatsapp:1376102838911694') for update;
 else select assigned_user_id into v_assigned from public.crm_commercial_form_cases where conversation_id=p_case and public.crm_commercial_form_is_allowed(p_case) for update; end if;
 if v_assigned is null or not public.crm_commercial_team_case_allowed(p_actor,p_superadmin,v_assigned) then raise exception 'call unavailable'; end if;
 insert into public.crm_commercial_team_calls(case_type,case_id,conversation_id,opened_by) values(p_type,p_case,v_conversation,p_actor) returning id into v_id;
 insert into public.crm_commercial_team_audit(actor_id,action,subject_id) values(p_actor,'call_opened',v_id);
 return jsonb_build_object('id',v_id,'status','pending');
end $$;
create function public.crm_commercial_team_call_complete(p_actor uuid,p_superadmin boolean,p_type text,p_case uuid,p_call uuid,p_situation text,p_discussed text,p_distinguishing text) returns jsonb
language plpgsql set search_path=pg_catalog,public as $$
declare v_assigned uuid;v_conversation uuid;
begin
 if p_actor is null or p_type not in ('whatsapp','form') or length(btrim(coalesce(p_situation,''))) not between 3 and 2000 or length(btrim(coalesce(p_discussed,''))) not between 3 and 2000 or length(btrim(coalesce(p_distinguishing,''))) not between 3 and 2000 then raise exception 'call summary required'; end if;
 perform 1 from public.crm_commercial_advisors where user_id=p_actor for update;
 if p_type='whatsapp' then select conversation_id into v_conversation from public.crm_commercial_cases where id=p_case; else v_conversation:=p_case; end if;
 perform 1 from public.crm_conversations where id=v_conversation for update;
 if p_type='whatsapp' then
  select assigned_user_id into v_assigned from public.crm_commercial_cases where id=p_case and conversation_id=v_conversation and status in ('open','suspended') and exists(select 1 from public.crm_conversations where id=v_conversation and source_channel='whatsapp' and origin='whatsapp:1376102838911694') for update;
 else select assigned_user_id into v_assigned from public.crm_commercial_form_cases where conversation_id=p_case and public.crm_commercial_form_is_allowed(p_case) for update; end if;
 if v_assigned is null or not public.crm_commercial_team_case_allowed(p_actor,p_superadmin,v_assigned) then raise exception 'call unavailable'; end if;
 update public.crm_commercial_team_calls set status='completed',situation=btrim(p_situation),discussed=btrim(p_discussed),distinguishing=btrim(p_distinguishing),completed_by=p_actor,completed_at=now()
 where id=p_call and case_type=p_type and case_id=p_case and conversation_id=v_conversation and status='pending';
 if not found then raise exception 'call unavailable'; end if;
 insert into public.crm_commercial_team_audit(actor_id,action,subject_id) values(p_actor,'call_completed',p_call);
 return jsonb_build_object('id',p_call,'status','completed');
end $$;
create function public.crm_commercial_team_calls_list(p_actor uuid,p_superadmin boolean,p_type text,p_case uuid) returns jsonb
language sql stable set search_path=pg_catalog,public as $$
 select coalesce(jsonb_agg(jsonb_build_object('id',calls.id,'status',calls.status,'situation',calls.situation,'discussed',calls.discussed,'distinguishing',calls.distinguishing,'createdAt',calls.created_at,'completedAt',calls.completed_at) order by calls.created_at desc),'[]'::jsonb)
 from public.crm_commercial_team_calls calls where calls.case_type=p_type and calls.case_id=p_case and
 ((p_type='whatsapp' and exists(select 1 from public.crm_commercial_cases c join public.crm_conversations cv on cv.id=c.conversation_id where c.id=p_case and c.conversation_id=calls.conversation_id and cv.source_channel='whatsapp' and cv.origin='whatsapp:1376102838911694' and c.status in ('open','suspended') and public.crm_commercial_team_case_allowed(p_actor,p_superadmin,c.assigned_user_id)))
 or (p_type='form' and exists(select 1 from public.crm_commercial_form_cases f where f.conversation_id=p_case and f.conversation_id=calls.conversation_id and public.crm_commercial_form_is_allowed(p_case) and public.crm_commercial_team_case_allowed(p_actor,p_superadmin,f.assigned_user_id))))
$$;
create function public.crm_commercial_block_unfinished_call() returns trigger language plpgsql set search_path=pg_catalog,public as $$
begin
 if exists(select 1 from public.crm_commercial_team_calls where conversation_id=new.id and status='pending')
 and (new.estado is distinct from old.estado or new.next_step is distinct from old.next_step) then raise exception 'call summary required'; end if;
 return new;
end $$;
create trigger crm_commercial_block_unfinished_call before update of estado,next_step on public.crm_conversations for each row execute function public.crm_commercial_block_unfinished_call();
create function public.crm_commercial_block_unfinished_call_activity() returns trigger language plpgsql set search_path=pg_catalog,public as $$
begin
 -- Lock conversation to serialize with opening/completing a call.
 if new.activity_type in ('phone_call','zoom_meeting') and (exists(select 1 from public.crm_commercial_cases where conversation_id=new.conversation_id) or exists(select 1 from public.crm_commercial_form_cases where conversation_id=new.conversation_id)) then raise exception 'use commercial call workflow'; end if;
 perform 1 from public.crm_conversations where id=new.conversation_id for update;
 if exists(select 1 from public.crm_commercial_team_calls where conversation_id=new.conversation_id and status='pending')
 and (nullif(btrim(coalesce(new.next_step,'')),'') is not null or new.follow_up_at is not null) then raise exception 'call summary required'; end if;
 return new;
end $$;
create trigger crm_commercial_block_unfinished_call_activity before insert or update of next_step,follow_up_at on public.crm_activities for each row execute function public.crm_commercial_block_unfinished_call_activity();
revoke all on function public.crm_commercial_team_call_open(uuid,boolean,text,uuid),public.crm_commercial_team_call_complete(uuid,boolean,text,uuid,uuid,text,text,text),public.crm_commercial_team_calls_list(uuid,boolean,text,uuid),public.crm_commercial_block_unfinished_call(),public.crm_commercial_block_unfinished_call_activity() from public,anon,authenticated;
grant execute on function public.crm_commercial_team_call_open(uuid,boolean,text,uuid),public.crm_commercial_team_call_complete(uuid,boolean,text,uuid,uuid,text,text,text),public.crm_commercial_team_calls_list(uuid,boolean,text,uuid) to service_role;
commit;
