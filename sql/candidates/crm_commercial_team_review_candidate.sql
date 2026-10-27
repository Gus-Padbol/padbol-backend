-- Candidate, not enabled. Review is by individual event, never whole conversation.
begin;
create table public.crm_commercial_review_queue (
 case_id uuid not null references public.crm_commercial_cases(id),
 event_id uuid primary key references public.crm_inbound_events(id),
 decision text check(decision in ('commercial','other')),
 reviewed_by uuid, reviewed_at timestamptz,
 created_at timestamptz not null default now()
);
create table public.crm_commercial_review_actions(id bigint generated always as identity primary key,case_id uuid not null references public.crm_commercial_cases(id),actor_id uuid not null,action text not null check(action='resume'),created_at timestamptz not null default now());
alter table public.crm_commercial_review_actions enable row level security;
revoke all on public.crm_commercial_review_actions from public,anon,authenticated;
grant all on public.crm_commercial_review_actions to service_role;
alter table public.crm_commercial_review_queue enable row level security;
revoke all on public.crm_commercial_review_queue from public,anon,authenticated;
grant all on public.crm_commercial_review_queue to service_role;
create function public.crm_commercial_review_is_admin(p_actor uuid) returns boolean
language sql stable set search_path=pg_catalog,public,auth as $$
 select exists(select 1 from public.user_roles r join auth.users u on u.id=r.user_id
 where r.user_id=p_actor and u.email_confirmed_at is not null and lower(trim(u.email))=lower(trim(r.email)) and lower(trim(r.role))='super_admin')
$$;
create function public.crm_commercial_review_enqueue() returns trigger language plpgsql set search_path=pg_catalog,public as $$
begin
 if new.source_channel='whatsapp' then
  insert into public.crm_commercial_review_queue(case_id,event_id)
   select c.id,new.id from public.crm_commercial_cases c where c.conversation_id=new.conversation_id and c.status in ('open','suspended')
   on conflict(event_id) do nothing;
 end if;
 return new;
end $$;
create trigger zz_commercial_review_enqueue after insert on public.crm_inbound_events for each row execute function public.crm_commercial_review_enqueue();
-- Automatic verified menu classification resolves only its own event.
create function public.crm_commercial_review_menu() returns trigger language plpgsql set search_path=pg_catalog,public as $$
declare v_event uuid; v_case uuid; v_status text;
begin
 select e.id into v_event from public.whatsapp_inbound_messages i join public.crm_inbound_events e on e.source_ref=i.provider_message_id and e.conversation_id=new.conversation_id and e.source_channel='whatsapp' where i.id=new.inbound_message_id;
 if v_event is null or new.menu_revision is null then return new; end if;
 select c.id,c.status into v_case,v_status from public.crm_commercial_cases c where c.conversation_id=new.conversation_id and c.status in ('open','suspended') for update;
 if v_case is null then return new; end if;
 if exists(select 1 from public.crm_commercial_case_inbound m where m.case_id=v_case and m.inbound_event_id=v_event) then
  update public.crm_commercial_review_queue set decision='commercial',reviewed_at=now() where event_id=v_event and decision is null;
 end if;
 if v_status='open' and exists(select 1 from public.crm_inbound_events e where e.conversation_id=new.conversation_id and e.source_channel='whatsapp' and not exists(select 1 from public.crm_commercial_case_inbound m where m.inbound_event_id=e.id) and not exists(select 1 from public.crm_commercial_review_queue q where q.event_id=e.id and q.decision is not null)) then
  update public.crm_commercial_cases set status='suspended' where id=v_case;
 end if;
 return new;
end $$;
create trigger zz_commercial_review_menu after insert on public.crm_whatsapp_menu_events for each row execute function public.crm_commercial_review_menu();
create function public.crm_commercial_review_list(p_actor uuid) returns jsonb language plpgsql set search_path=pg_catalog,public as $$
declare v_result jsonb;
begin
 if not public.crm_commercial_review_is_admin(p_actor) then raise exception 'not authorized'; end if;
 select coalesce(jsonb_agg(jsonb_build_object('caseId',c.id,'eventId',e.id,'body',e.body,'receivedAt',e.received_at,'caseStatus',c.status,'version',md5(to_jsonb(e)::text||to_jsonb(c)::text)) order by e.received_at,e.id),'[]'::jsonb) into v_result
 from public.crm_commercial_cases c join public.crm_inbound_events e on e.conversation_id=c.conversation_id and e.source_channel='whatsapp'
 left join public.crm_commercial_review_queue q on q.event_id=e.id
 where c.status='suspended' and not exists(select 1 from public.crm_commercial_case_inbound m where m.inbound_event_id=e.id)
 and (q.event_id is null or q.decision is null);
 return v_result;
end $$;
create function public.crm_commercial_review_decide(p_actor uuid,p_case uuid,p_event uuid,p_version text,p_decision text) returns jsonb language plpgsql set search_path=pg_catalog,public as $$
declare v_conv uuid; v_case public.crm_commercial_cases%rowtype; v_event public.crm_inbound_events%rowtype; v_pending integer;
begin
 if not public.crm_commercial_review_is_admin(p_actor) then raise exception 'not authorized'; end if;
 if p_decision is null or p_decision not in ('commercial','other') then raise exception 'invalid decision'; end if;
 select conversation_id into v_conv from public.crm_commercial_cases where id=p_case;
 perform 1 from public.crm_conversations where id=v_conv for update;
 select * into v_case from public.crm_commercial_cases where id=p_case and conversation_id=v_conv for update;
 select * into v_event from public.crm_inbound_events where id=p_event and conversation_id=v_conv for update;
 if v_case.id is null or v_event.id is null or v_case.status<>'suspended' or v_event.source_channel<>'whatsapp' or exists(select 1 from public.crm_commercial_case_inbound where inbound_event_id=p_event) or exists(select 1 from public.crm_commercial_review_queue where event_id=p_event and decision is not null) then raise exception 'review unavailable'; end if;
 if p_version is distinct from md5(to_jsonb(v_event)::text||to_jsonb(v_case)::text) then raise exception 'review conflict'; end if;
 insert into public.crm_commercial_review_queue(case_id,event_id) values(p_case,p_event) on conflict(event_id) do update set case_id=excluded.case_id where public.crm_commercial_review_queue.decision is null;
 if p_decision='commercial' then
  insert into public.crm_commercial_case_inbound(case_id,conversation_id,inbound_event_id) values(p_case,v_conv,p_event) on conflict(inbound_event_id) do nothing;
  if not exists(select 1 from public.crm_commercial_case_inbound where case_id=p_case and inbound_event_id=p_event) then raise exception 'review conflict'; end if;
 end if;
 update public.crm_commercial_review_queue set decision=p_decision,reviewed_by=p_actor,reviewed_at=now() where event_id=p_event;
 select count(*) into v_pending from public.crm_inbound_events e where e.conversation_id=v_conv and e.source_channel='whatsapp' and not exists(select 1 from public.crm_commercial_case_inbound m where m.inbound_event_id=e.id) and not exists(select 1 from public.crm_commercial_review_queue q where q.event_id=e.id and q.decision is not null);
 -- Only an explicitly reviewed commercial event can resume a suspended case,
 -- and only after every queued message has been individually classified.
 if v_pending=0 and p_decision='commercial' and (exists(select 1 from public.crm_inbound_events x where x.conversation_id=v_conv and x.source_channel='whatsapp') and not exists(select 1 from public.crm_inbound_events e where e.conversation_id=v_conv and e.source_channel='whatsapp' and e.received_at=(select max(x.received_at) from public.crm_inbound_events x where x.conversation_id=v_conv and x.source_channel='whatsapp') and not exists(select 1 from public.crm_commercial_case_inbound m where m.inbound_event_id=e.id and m.case_id=p_case))) then
  update public.crm_commercial_cases set status='open' where id=p_case;
  v_case.status:='open';
 end if;
 return jsonb_build_object('decision',p_decision,'pending',v_pending,'status',v_case.status,'caseVersion',md5(to_jsonb(v_case)::text));
end $$;
create function public.crm_commercial_review_suspended(p_actor uuid) returns jsonb language plpgsql set search_path=pg_catalog,public as $$
declare v_result jsonb;
begin
 if not public.crm_commercial_review_is_admin(p_actor) then raise exception 'not authorized'; end if;
 select coalesce(jsonb_agg(jsonb_build_object('caseId',c.id,'caseVersion',md5(to_jsonb(c)::text),'pending',(select count(*) from public.crm_inbound_events e where e.conversation_id=c.conversation_id and e.source_channel='whatsapp' and not exists(select 1 from public.crm_commercial_case_inbound m where m.inbound_event_id=e.id) and not exists(select 1 from public.crm_commercial_review_queue q where q.event_id=e.id and q.decision is not null)),'lastReviewedAt',(select max(q.reviewed_at) from public.crm_commercial_review_queue q where q.case_id=c.id and q.reviewed_by is not null))),'[]'::jsonb) into v_result
 from public.crm_commercial_cases c where c.status='suspended' and exists(select 1 from public.crm_commercial_review_queue q where q.case_id=c.id and q.reviewed_by is not null);
 return v_result;
end $$;
-- Explicit reactivation is available only to a superadmin after all messages,
-- including historical ones, have been individually accounted for.
create function public.crm_commercial_review_resume(p_actor uuid,p_case uuid,p_version text) returns jsonb language plpgsql set search_path=pg_catalog,public as $$
declare v_conv uuid; v_case public.crm_commercial_cases%rowtype;
begin
 if not public.crm_commercial_review_is_admin(p_actor) then raise exception 'not authorized'; end if;
 select conversation_id into v_conv from public.crm_commercial_cases where id=p_case;
 perform 1 from public.crm_conversations where id=v_conv for update;
 select * into v_case from public.crm_commercial_cases where id=p_case and conversation_id=v_conv for update;
 if v_case.id is null or v_case.status<>'suspended' then raise exception 'review unavailable'; end if;
 if p_version is distinct from md5(to_jsonb(v_case)::text) then raise exception 'review conflict'; end if;
 if not exists(select 1 from public.crm_commercial_review_queue where case_id=p_case and reviewed_by is not null) or not (exists(select 1 from public.crm_inbound_events x where x.conversation_id=v_conv and x.source_channel='whatsapp') and not exists(select 1 from public.crm_inbound_events e where e.conversation_id=v_conv and e.source_channel='whatsapp' and e.received_at=(select max(x.received_at) from public.crm_inbound_events x where x.conversation_id=v_conv and x.source_channel='whatsapp') and not exists(select 1 from public.crm_commercial_case_inbound m where m.inbound_event_id=e.id and m.case_id=p_case))) or exists(select 1 from public.crm_inbound_events e where e.conversation_id=v_conv and e.source_channel='whatsapp' and not exists(select 1 from public.crm_commercial_case_inbound m where m.inbound_event_id=e.id) and not exists(select 1 from public.crm_commercial_review_queue q where q.event_id=e.id and q.decision is not null)) then raise exception 'review pending'; end if;
 insert into public.crm_commercial_review_actions(case_id,actor_id,action) values(p_case,p_actor,'resume');
 update public.crm_commercial_cases set status='open' where id=p_case;
 return jsonb_build_object('status','open');
end $$;
-- Once disclosed, inbound content must remain immutable; updating it could leak
-- an unrelated support message to the assigned commercial advisor.
create function public.crm_commercial_review_protect_inbound() returns trigger language plpgsql set search_path=pg_catalog,public as $$
begin
 if (to_jsonb(new)->'body',to_jsonb(new)->'subject',to_jsonb(new)->'source_channel',to_jsonb(new)->'source_ref',to_jsonb(new)->'origin',to_jsonb(new)->'conversation_id',to_jsonb(new)->'received_at') is distinct from (to_jsonb(old)->'body',to_jsonb(old)->'subject',to_jsonb(old)->'source_channel',to_jsonb(old)->'source_ref',to_jsonb(old)->'origin',to_jsonb(old)->'conversation_id',to_jsonb(old)->'received_at') and (exists(select 1 from public.crm_commercial_case_inbound where inbound_event_id=old.id) or exists(select 1 from public.crm_commercial_review_queue where event_id=old.id and decision is not null)) then raise exception 'commercial event immutable'; end if;
 return new;
end $$;
create trigger crm_commercial_review_protect_inbound before update on public.crm_inbound_events for each row execute function public.crm_commercial_review_protect_inbound();
revoke all on function public.crm_commercial_review_is_admin(uuid),public.crm_commercial_review_enqueue(),public.crm_commercial_review_menu(),public.crm_commercial_review_list(uuid),public.crm_commercial_review_decide(uuid,uuid,uuid,text,text),public.crm_commercial_review_protect_inbound(),public.crm_commercial_review_resume(uuid,uuid,text),public.crm_commercial_review_suspended(uuid) from public,anon,authenticated;
grant execute on function public.crm_commercial_review_list(uuid),public.crm_commercial_review_decide(uuid,uuid,uuid,text,text),public.crm_commercial_review_resume(uuid,uuid,text),public.crm_commercial_review_suspended(uuid) to service_role;
commit;
