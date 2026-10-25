begin;
alter table public.crm_commercial_followups add column dispatch_enabled boolean not null default false;
alter table public.crm_commercial_followups add column recipient_wa_id text;
alter table public.crm_commercial_followups add column dispatch_activated_at timestamptz;
alter table public.crm_commercial_followups add column started_superadmin boolean not null default false;
alter table public.crm_commercial_followups add column consent_revoked_at timestamptz;
alter table public.crm_commercial_followups drop constraint crm_commercial_followups_status_check;
alter table public.crm_commercial_followups add constraint crm_commercial_followups_status_check check(status in ('active','paused','cancelled','completed'));
create unique index crm_commercial_followup_one_recipient on public.crm_commercial_followups(recipient_wa_id)where dispatch_enabled and status='active';
create table public.crm_commercial_followup_dispatches(
 id uuid primary key default gen_random_uuid(),plan_id uuid not null references public.crm_commercial_followups(id),conversation_id uuid not null references public.crm_conversations(id),step integer not null check(step between 1 and 3),claim_token uuid not null,
 status text not null check(status in ('reserved','dispatching','accepted','uncertain','cancelled')),recipient_wa_id text not null,template_name text not null,language_code text not null,body text not null,provider_message_id text,created_at timestamptz not null default now(),accepted_at timestamptz,updated_at timestamptz not null default now(),unique(plan_id,step)
);
create table public.crm_commercial_followup_optouts(recipient_wa_id text primary key,conversation_id uuid not null,created_at timestamptz not null default now());
-- Preserve earlier explicit opt-outs; deploying this worker must not erase their meaning.
insert into public.crm_commercial_followup_optouts(recipient_wa_id,conversation_id,created_at)
 select distinct on (x.phone) x.phone,x.conversation_id,coalesce(x.received_at,now()) from (
 select case when c.source_channel='whatsapp' then c.identity_used else co.phone_normalized end phone,c.id conversation_id,e.received_at from public.crm_inbound_events e join public.crm_conversations c on c.id=e.conversation_id join public.crm_contacts co on co.id=c.contact_id
 where lower(trim(coalesce(e.body,'')))~'^(stop|baja|cancelar|unsubscribe|desuscribir)([[:space:][:punct:]]|$)' or lower(trim(coalesce(e.body,''))) in ('no más mensajes','no mas mensajes','no more messages')
 )x where x.phone~'^[0-9]{8,15}$' order by x.phone,x.received_at on conflict do nothing;
alter table public.crm_commercial_followup_dispatches enable row level security;
alter table public.crm_commercial_followup_optouts enable row level security;
revoke all on public.crm_commercial_followup_dispatches,public.crm_commercial_followup_optouts from public,anon,authenticated;
grant select,insert,update on public.crm_commercial_followup_dispatches to service_role;
grant select,insert on public.crm_commercial_followup_optouts to service_role;
create function public.crm_commercial_followup_info(p_actor uuid,p_superadmin boolean,p_type text,p_case uuid) returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare cv uuid;recipient text;channel text;orig text;state text;review boolean;assigned uuid;super_now boolean;
begin
 super_now:=p_superadmin and exists(select 1 from public.user_roles r join auth.users u on u.id=r.user_id and lower(u.email)=lower(r.email) where r.user_id=p_actor and r.role='super_admin' and u.email_confirmed_at is not null);
 begin cv:=public.crm_commercial_followup_case_member(p_actor,super_now,p_type,p_case);exception when others then return jsonb_build_object('eligible',false,'reason','case_unavailable');end;
 select c.source_channel,c.origin,case when c.source_channel='whatsapp' then c.identity_used else co.phone_normalized end,co.review_needed into channel,orig,recipient,review from public.crm_conversations c join public.crm_contacts co on co.id=c.contact_id where c.id=cv;
 if p_type='whatsapp' then select progress_state,assigned_user_id into state,assigned from public.crm_commercial_cases where id=p_case and status='open';else select progress_state,assigned_user_id into state,assigned from public.crm_commercial_form_cases where conversation_id=p_case;end if;
 if state is distinct from 'en_espera' then return jsonb_build_object('eligible',false,'reason','waiting_state_required');end if;
 if review is distinct from false or recipient is null or recipient!~'^[0-9]{8,15}$' or (p_type='whatsapp' and (channel<>'whatsapp' or orig<>'whatsapp:1376102838911694')) then return jsonb_build_object('eligible',false,'reason','recipient_not_verified');end if;
 if exists(select 1 from public.crm_commercial_followups where dispatch_enabled and status='active' and recipient_wa_id=recipient and (case_type<>p_type or case_id<>p_case)) then return jsonb_build_object('eligible',false,'reason','another_followup_active');end if;
 if exists(select 1 from public.crm_commercial_followup_optouts where recipient_wa_id=recipient) then return jsonb_build_object('eligible',false,'reason','opted_out');end if;
 if exists(select 1 from public.crm_commercial_team_calls where conversation_id=cv and status='pending') or not exists(select 1 from public.crm_commercial_team_calls where conversation_id=cv and status='completed') then return jsonb_build_object('eligible',false,'reason','call_summary_required');end if;
 if exists(select 1 from public.crm_replies where conversation_id=cv and status='pending') or exists(select 1 from public.crm_commercial_followup_dispatches where (conversation_id=cv or recipient_wa_id=recipient) and status in ('reserved','dispatching','uncertain')) then return jsonb_build_object('eligible',false,'reason','send_requires_review');end if;
 return jsonb_build_object('eligible',true,'conversationId',cv,'recipient',recipient,'assigned',assigned);
end$$;
create function public.crm_commercial_followup_enable(p_actor uuid,p_superadmin boolean,p_type text,p_case uuid,p_language text,p_consent_evidence text,p_template_key text) returns jsonb language plpgsql set search_path=pg_catalog,public as $$
declare info jsonb;result jsonb;cv uuid;phone text;
begin
 cv:=public.crm_commercial_followup_case_member(p_actor,p_superadmin,p_type,p_case);
 perform 1 from public.crm_conversations where id=cv for update;
 select case when c.source_channel='whatsapp' then c.identity_used else co.phone_normalized end into phone from public.crm_conversations c join public.crm_contacts co on co.id=c.contact_id where c.id=cv;
 if phone is not null then perform pg_advisory_xact_lock(hashtextextended('commercial_followup:'||phone,0));end if;
 info:=public.crm_commercial_followup_info(p_actor,p_superadmin,p_type,p_case);
 if info->>'eligible' is distinct from 'true' then raise exception 'followup not ready';end if;
 if p_template_key is distinct from 'commercial_waiting_'||p_language||'_v1' then raise exception 'followup template invalid';end if;
 result:=public.crm_commercial_followup_start(p_actor,p_superadmin,p_type,p_case,p_language,p_consent_evidence,p_template_key);
 update public.crm_commercial_followups set dispatch_enabled=true,recipient_wa_id=info->>'recipient',dispatch_activated_at=started_at,started_superadmin=p_superadmin where id=(result->>'id')::uuid;
 return result||jsonb_build_object('dispatchEnabled',true,'scheduleHours',jsonb_build_array(48,120,192));
end$$;
-- Called with conversation/plan/case locked, both before durable reservation and immediately before HTTP.
create function public.crm_commercial_followup_check(p_plan uuid,p_step integer,p_now timestamptz,p_allow_attempt uuid default null) returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare f public.crm_commercial_followups;info jsonb;due timestamptz;last_sent timestamptz;cv uuid;state text;recipient text;
begin
 select conversation_id,recipient_wa_id into cv,recipient from public.crm_commercial_followups where id=p_plan;
 perform 1 from public.crm_conversations where id=cv for update;
 if recipient is not null then perform pg_advisory_xact_lock(hashtextextended('commercial_followup:'||recipient,0));end if;
 select * into f from public.crm_commercial_followups where id=p_plan for update;
 if f.id is null or f.status<>'active' or not f.dispatch_enabled or f.dispatch_activated_at is null or f.dispatch_activated_at<>f.started_at or f.consent_revoked_at is not null or length(trim(coalesce(f.consent_evidence,'')))<3 or p_step not between 1 and 3 then return null;end if;
 if f.case_type='whatsapp' then perform 1 from public.crm_commercial_cases where id=f.case_id for update;else perform 1 from public.crm_commercial_form_cases where conversation_id=f.case_id for update;end if;
 -- Exclude this exact durable reservation during second-phase revalidation.
 if p_allow_attempt is not null then
  if not exists(select 1 from public.crm_commercial_followup_dispatches where id=p_allow_attempt and plan_id=f.id and step=p_step and status='reserved') then return null;end if;
 end if;
 -- Context checker intentionally sees unresolved attempts. Temporarily use a specialized direct guard here.
 begin cv:=public.crm_commercial_followup_case_member(f.started_by,f.started_superadmin and exists(select 1 from public.user_roles r join auth.users u on u.id=r.user_id and lower(r.email)=lower(u.email) where r.user_id=f.started_by and r.role='super_admin' and u.email_confirmed_at is not null),f.case_type,f.case_id);exception when others then cv:=null;end;
 if f.case_type='whatsapp' then select progress_state into state from public.crm_commercial_cases where id=f.case_id and status='open';else select progress_state into state from public.crm_commercial_form_cases where conversation_id=f.case_id;end if;
 select case when c.source_channel='whatsapp' then c.identity_used else co.phone_normalized end into recipient from public.crm_conversations c join public.crm_contacts co on co.id=c.contact_id where c.id=f.conversation_id and co.review_needed=false and (f.case_type='form' or (c.source_channel='whatsapp' and c.origin='whatsapp:1376102838911694'));
 if cv is null or state is distinct from 'en_espera' or recipient is distinct from f.recipient_wa_id or recipient is null or recipient!~'^[0-9]{8,15}$' or exists(select 1 from public.crm_commercial_followup_optouts where recipient_wa_id=recipient) or exists(select 1 from public.crm_commercial_team_calls where conversation_id=f.conversation_id and status='pending') or not exists(select 1 from public.crm_commercial_team_calls where conversation_id=f.conversation_id and status='completed') or exists(select 1 from public.crm_replies where conversation_id=f.conversation_id and status='pending') then
  update public.crm_commercial_followups set status='paused',dispatch_enabled=false,paused_at=p_now,paused_reason='context_changed' where id=f.id;return null;
 end if;
 if exists(select 1 from public.crm_commercial_followup_dispatches where (conversation_id=f.conversation_id or recipient_wa_id=recipient) and status in ('reserved','dispatching','uncertain') and id is distinct from p_allow_attempt) then return null;end if;
 if (select count(*) from public.crm_commercial_followup_dispatches where plan_id=f.id and step<p_step and status='accepted')<>p_step-1 then return null;end if;
 due:=f.started_at+case p_step when 1 then interval '48 hours' when 2 then interval '120 hours' else interval '192 hours' end;
 if p_now>due+interval '24 hours' then update public.crm_commercial_followups set status='paused',dispatch_enabled=false,paused_at=p_now,paused_reason='missed_window' where id=f.id;return null;end if;
 select max(accepted_at) into last_sent from public.crm_commercial_followup_dispatches where plan_id=f.id and status='accepted';
 if p_now<due or (last_sent is not null and p_now<last_sent+interval '72 hours') then return null;end if;
 return jsonb_build_object('planId',f.id,'conversationId',f.conversation_id,'recipient',recipient,'language',f.language,'templateKey',f.template_key,'step',p_step);
end$$;
create function public.crm_commercial_followup_claim(p_plan uuid,p_step integer,p_now timestamptz,p_template text,p_language text,p_body text,p_token uuid) returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare info jsonb;attempt uuid;
begin
 info:=public.crm_commercial_followup_check(p_plan,p_step,p_now,null);if info is null then return null;end if;
 if (p_template!~'^[a-z0-9_]+$' or length(p_template)>512) or length(trim(p_body)) not between 1 and 4096 or p_token is null then raise exception 'invalid dispatch';end if;
 insert into public.crm_commercial_followup_dispatches(plan_id,conversation_id,step,claim_token,status,recipient_wa_id,template_name,language_code,body,created_at,updated_at)values(p_plan,(info->>'conversationId')::uuid,p_step,p_token,'reserved',info->>'recipient',p_template,p_language,p_body,p_now,p_now)on conflict(plan_id,step)do nothing returning id into attempt;
 if attempt is null then return null;end if;
 return info||jsonb_build_object('attemptId',attempt);
end$$;
create function public.crm_commercial_followup_pause_event() returns trigger language plpgsql security definer set search_path=pg_catalog,public as $$
declare cv uuid;phone text;optout boolean:=false;own_dispatch boolean:=false;
begin
 cv:=new.conversation_id;
 if tg_table_name='crm_inbound_events' and exists(select 1 from public.crm_inbound_events e where e.id=new.id or (to_jsonb(new)->>'source_ref' is not null and to_jsonb(e)->>'source_ref'=to_jsonb(new)->>'source_ref' and to_jsonb(e)->>'source_channel'=to_jsonb(new)->>'source_channel' and to_jsonb(e)->>'origin'=to_jsonb(new)->>'origin')) then return new;end if;
 if tg_table_name='crm_replies' then
  if exists(select 1 from public.crm_replies where id=new.id)then return new;end if;
  own_dispatch:=new.operador='automation:commercial_followup' and exists(select 1 from public.crm_commercial_followup_dispatches where id::text=current_setting('padbol.commercial_followup_dispatch',true) and conversation_id=cv and status='dispatching');
  if own_dispatch then return new;end if;
 end if;
 perform 1 from public.crm_conversations where id=cv for update;
 select case when c.source_channel='whatsapp' then c.identity_used else co.phone_normalized end into phone from public.crm_conversations c join public.crm_contacts co on co.id=c.contact_id where c.id=cv;
 if phone is not null then perform pg_advisory_xact_lock(hashtextextended('commercial_followup:'||phone,0));end if;
 if tg_table_name='crm_inbound_events' then
  optout:=lower(trim(coalesce(new.body,'')))~'^(stop|baja|cancelar|unsubscribe|desuscribir)([[:space:][:punct:]]|$)' or lower(trim(coalesce(new.body,''))) in ('no más mensajes','no mas mensajes','no more messages');
  if optout then select case when c.source_channel='whatsapp' then c.identity_used else co.phone_normalized end into phone from public.crm_conversations c join public.crm_contacts co on co.id=c.contact_id where c.id=cv;
   if phone~'^[0-9]{8,15}$' then insert into public.crm_commercial_followup_optouts(recipient_wa_id,conversation_id)values(phone,cv)on conflict do nothing;end if;
  end if;
 end if;
 update public.crm_commercial_followups set status='paused',dispatch_enabled=false,paused_at=now(),paused_reason=case when optout then 'consent_revoked' when tg_table_name='crm_inbound_events' then 'inbound_message' when tg_table_name='crm_replies' then 'human_reply' else 'human_call' end,consent_revoked_at=case when optout then now() else consent_revoked_at end where (conversation_id=cv or recipient_wa_id=phone) and status='active';
 return new;
end$$;
drop trigger if exists crm_commercial_followup_pause_on_inbound on public.crm_inbound_events;
create trigger crm_commercial_followup_dispatch_pause_inbound before insert on public.crm_inbound_events for each row execute function public.crm_commercial_followup_pause_event();
create trigger crm_commercial_followup_dispatch_pause_reply before insert on public.crm_replies for each row execute function public.crm_commercial_followup_pause_event();
create trigger crm_commercial_followup_dispatch_pause_call before insert on public.crm_commercial_team_calls for each row execute function public.crm_commercial_followup_pause_event();
create function public.crm_commercial_followup_pause_state() returns trigger language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_case uuid;v_type text;phone text;
begin
 if tg_table_name='crm_commercial_cases' then v_case:=new.id;v_type:='whatsapp';else v_case:=new.conversation_id;v_type:='form';end if;
 if new.progress_state is distinct from old.progress_state then
  perform 1 from public.crm_conversations where id=new.conversation_id for update;
  select case when c.source_channel='whatsapp' then c.identity_used else co.phone_normalized end into phone from public.crm_conversations c join public.crm_contacts co on co.id=c.contact_id where c.id=new.conversation_id;
  if phone is not null then perform pg_advisory_xact_lock(hashtextextended('commercial_followup:'||phone,0));end if;
  update public.crm_commercial_followups set status='paused',dispatch_enabled=false,paused_at=now(),paused_reason='state_changed' where ((case_type=v_type and case_id=v_case) or recipient_wa_id=phone) and status='active';end if;return new;
end$$;
create trigger crm_commercial_followup_dispatch_pause_state after update of progress_state on public.crm_commercial_cases for each row execute function public.crm_commercial_followup_pause_state();
create trigger crm_commercial_followup_dispatch_pause_form_state after update of progress_state on public.crm_commercial_form_cases for each row execute function public.crm_commercial_followup_pause_state();
revoke all on function public.crm_commercial_followup_info(uuid,boolean,text,uuid),public.crm_commercial_followup_enable(uuid,boolean,text,uuid,text,text,text),public.crm_commercial_followup_check(uuid,integer,timestamptz,uuid),public.crm_commercial_followup_claim(uuid,integer,timestamptz,text,text,text,uuid),public.crm_commercial_followup_pause_event(),public.crm_commercial_followup_pause_state() from public,anon,authenticated;
grant execute on function public.crm_commercial_followup_info(uuid,boolean,text,uuid),public.crm_commercial_followup_enable(uuid,boolean,text,uuid,text,text,text),public.crm_commercial_followup_check(uuid,integer,timestamptz,uuid),public.crm_commercial_followup_claim(uuid,integer,timestamptz,text,text,text,uuid) to service_role;
notify pgrst,'reload schema';
commit;
