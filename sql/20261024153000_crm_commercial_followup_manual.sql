-- Manual commercial follow-up plans. This stores an approved future plan only;
-- it never sends WhatsApp. Meta template dispatch remains a separate, gated worker.
begin;

create table public.crm_commercial_followups (
  id uuid primary key default gen_random_uuid(),
  case_type text not null check(case_type in ('whatsapp','form')),
  case_id uuid not null,
  conversation_id uuid not null references public.crm_conversations(id) on delete restrict,
  language text not null check(language in ('es','en')),
  consent_evidence text not null check(length(trim(consent_evidence)) between 3 and 2000),
  template_key text not null check(length(trim(template_key)) between 3 and 120),
  status text not null default 'active' check(status in ('active','paused','cancelled')),
  started_by uuid not null,
  started_at timestamptz not null default now(),
  paused_at timestamptz,
  paused_reason text,
  cancelled_at timestamptz,
  cancelled_by uuid
);

create unique index crm_commercial_followups_one_active
  on public.crm_commercial_followups(case_type,case_id) where status='active';
create index crm_commercial_followups_conversation
  on public.crm_commercial_followups(conversation_id,status,started_at desc);
alter table public.crm_commercial_followups enable row level security;
revoke all on public.crm_commercial_followups from public,anon,authenticated;
grant all on public.crm_commercial_followups to service_role;

create function public.crm_commercial_followup_case_member(p_actor uuid,p_superadmin boolean,p_type text,p_case uuid)
returns uuid language plpgsql stable set search_path=pg_catalog,public as $$
declare v_conversation uuid; v_assigned uuid;
begin
 if p_type='whatsapp' then
   select c.conversation_id,c.assigned_user_id into v_conversation,v_assigned
   from public.crm_commercial_cases c join public.crm_conversations v on v.id=c.conversation_id
   where c.id=p_case and c.status in ('open','suspended') and v.source_channel='whatsapp' and v.origin='whatsapp:1376102838911694';
 elsif p_type='form' then
   select f.conversation_id,f.assigned_user_id into v_conversation,v_assigned from public.crm_commercial_form_cases f
   where f.conversation_id=p_case and public.crm_commercial_form_is_allowed(f.conversation_id);
 else raise exception 'followup unavailable';
 end if;
 if v_conversation is null or not public.crm_commercial_team_case_allowed(p_actor,p_superadmin,v_assigned) then raise exception 'followup unavailable'; end if;
 return v_conversation;
end $$;

create function public.crm_commercial_followup_start(p_actor uuid,p_superadmin boolean,p_type text,p_case uuid,p_language text,p_consent_evidence text,p_template_key text)
returns jsonb language plpgsql set search_path=pg_catalog,public as $$
declare v_conv uuid; v_state text; v_id uuid;
begin
 if p_actor is null or p_language not in ('es','en') or length(btrim(coalesce(p_consent_evidence,''))) not between 3 and 2000 or length(btrim(coalesce(p_template_key,''))) not between 3 and 120 then raise exception 'followup invalid'; end if;
 v_conv:=public.crm_commercial_followup_case_member(p_actor,p_superadmin,p_type,p_case);
 perform 1 from public.crm_conversations where id=v_conv for update;
 if p_type='whatsapp' then
   select progress_state into v_state from public.crm_commercial_cases where id=p_case for update;
 else select progress_state into v_state from public.crm_commercial_form_cases where conversation_id=p_case for update;
 end if;
 if v_state<>'en_espera' then raise exception 'followup requires waiting state'; end if;
 if exists(select 1 from public.crm_commercial_team_calls where conversation_id=v_conv and status='pending') then raise exception 'call summary required'; end if;
 update public.crm_commercial_followups set status='cancelled',cancelled_at=now(),cancelled_by=p_actor,paused_reason='replaced manually'
  where case_type=p_type and case_id=p_case and status in ('active','paused');
 insert into public.crm_commercial_followups(case_type,case_id,conversation_id,language,consent_evidence,template_key,started_by)
  values(p_type,p_case,v_conv,p_language,btrim(p_consent_evidence),btrim(p_template_key),p_actor) returning id into v_id;
 insert into public.crm_commercial_team_audit(actor_id,action,subject_id,details)
  values(p_actor,'followup_started',v_id,jsonb_build_object('case_type',p_type,'case_id',p_case,'language',p_language,'template_key',btrim(p_template_key)));
 return jsonb_build_object('id',v_id,'status','active','conversationId',v_conv,'language',p_language,'templateKey',btrim(p_template_key));
end $$;

create function public.crm_commercial_followup_cancel(p_actor uuid,p_superadmin boolean,p_type text,p_case uuid)
returns jsonb language plpgsql set search_path=pg_catalog,public as $$
declare v_conv uuid; v_id uuid;
begin
 if p_actor is null then raise exception 'followup unavailable'; end if;
 v_conv:=public.crm_commercial_followup_case_member(p_actor,p_superadmin,p_type,p_case);
 perform 1 from public.crm_conversations where id=v_conv for update;
 update public.crm_commercial_followups set status='cancelled',cancelled_at=now(),cancelled_by=p_actor,paused_reason='cancelled manually'
  where case_type=p_type and case_id=p_case and status='active' returning id into v_id;
 if v_id is null then raise exception 'followup unavailable'; end if;
 insert into public.crm_commercial_team_audit(actor_id,action,subject_id,details) values(p_actor,'followup_cancelled',v_id,jsonb_build_object('case_type',p_type,'case_id',p_case));
 return jsonb_build_object('id',v_id,'status','cancelled','conversationId',v_conv);
end $$;

-- A fresh customer message always pauses an active plan. It never sends a message.
create function public.crm_commercial_followup_pause_on_inbound() returns trigger language plpgsql security invoker set search_path=pg_catalog,public as $$
begin
 update public.crm_commercial_followups set status='paused',paused_at=now(),paused_reason='inbound_message'
  where conversation_id=new.conversation_id and status='active';
 return new;
end $$;
drop trigger if exists crm_commercial_followup_pause_on_inbound on public.crm_inbound_events;
create trigger crm_commercial_followup_pause_on_inbound after insert on public.crm_inbound_events
 for each row execute function public.crm_commercial_followup_pause_on_inbound();

revoke all on function public.crm_commercial_followup_case_member(uuid,boolean,text,uuid),public.crm_commercial_followup_start(uuid,boolean,text,uuid,text,text,text),public.crm_commercial_followup_cancel(uuid,boolean,text,uuid),public.crm_commercial_followup_pause_on_inbound() from public,anon,authenticated;
grant execute on function public.crm_commercial_followup_case_member(uuid,boolean,text,uuid),public.crm_commercial_followup_start(uuid,boolean,text,uuid,text,text,text),public.crm_commercial_followup_cancel(uuid,boolean,text,uuid) to service_role;
commit;
