begin;

-- Explicit owner classification, never a public form field or a mailbox-wide grant.
create table public.crm_commercial_email_triage (
 conversation_id uuid primary key references public.crm_conversations(id) on delete restrict,
 classified_by uuid not null references auth.users(id),
 initial_assigned_user_id uuid not null references auth.users(id),
 reason text not null check(length(btrim(reason)) between 10 and 2000),
 created_at timestamptz not null default now()
);
create table public.crm_commercial_email_triage_audit (
 id uuid primary key default gen_random_uuid(),
 conversation_id uuid not null references public.crm_commercial_email_triage(conversation_id) on delete restrict,
 actor_id uuid not null references auth.users(id),
 details jsonb not null,
 created_at timestamptz not null default now()
);
alter table public.crm_commercial_email_triage enable row level security;
alter table public.crm_commercial_email_triage_audit enable row level security;
revoke all on public.crm_commercial_email_triage,public.crm_commercial_email_triage_audit from public,anon,authenticated,service_role;
grant select on public.crm_commercial_email_triage,public.crm_commercial_email_triage_audit to service_role;

create function public.crm_commercial_email_triage_immutable() returns trigger
language plpgsql set search_path=pg_catalog,public as $$begin raise exception 'COMMERCIAL_EMAIL_TRIAGE_IMMUTABLE';end$$;
revoke all on function public.crm_commercial_email_triage_immutable() from public,anon,authenticated;
create trigger crm_commercial_email_triage_immutable before update or delete on public.crm_commercial_email_triage for each row execute function public.crm_commercial_email_triage_immutable();
create trigger crm_commercial_email_triage_audit_immutable before update or delete on public.crm_commercial_email_triage_audit for each row execute function public.crm_commercial_email_triage_immutable();

create or replace function public.crm_commercial_form_is_allowed(p_conversation uuid) returns boolean
language sql stable set search_path=pg_catalog,public as $$
 select exists(select 1 from public.crm_conversations c
 where c.id=p_conversation and c.source_channel='email' and c.test_hidden_at is null and c.email_return_linked_to is null
 and (
  (c.origin=any(array[
   'web_form:Consulta Padbol · Quiero una cancha Padbol',
   'web_form:Consulta Padbol · Quiero sumar Padbol a mi club',
   'web_form:Consulta Padbol · Quiero abrir un Punto Padbol exclusivo',
   'web_form:Consulta Padbol · Quiero representar Padbol en mi ciudad o región',
   'web_form:Consulta Padbol · Quiero representar Padbol en mi país',
   'web_form:solicitud_licencia','web_form:dev_padbol_contacto_business'])
   and coalesce(c.qualification_data#>>'{routing,workflow}','commercial_lead')='commercial_lead'
   and coalesce(c.qualification_data#>>'{form_submission,fields,workflow}','commercial_lead')='commercial_lead')
  or (c.origin='institutional_email' and exists(select 1 from public.crm_commercial_email_triage t where t.conversation_id=c.id))
 ))
$$;
revoke all on function public.crm_commercial_form_is_allowed(uuid) from public,anon,authenticated;
grant execute on function public.crm_commercial_form_is_allowed(uuid) to service_role;

-- Private operational RPC. The caller must bind p_actor to the verified owner
-- session. Service-role invocation does not replace the persisted owner check.
create function public.crm_commercial_email_classify(p_actor uuid,p_conversation uuid,p_advisor uuid,p_reason text) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
declare c public.crm_conversations%rowtype; t public.crm_commercial_email_triage%rowtype; current_advisor uuid; stamp timestamptz:=now();
begin
 if not public.crm_commercial_owner(p_actor,true) then raise exception 'not authorized';end if;
 if p_conversation is null or p_advisor is null or length(btrim(coalesce(p_reason,''))) not between 10 and 2000 then raise exception 'commercial email triage invalid';end if;
 -- Follow existing assignment ordering: advisor, conversation, form case.
 perform 1 from public.crm_commercial_advisors where user_id=p_advisor for update;
 select * into c from public.crm_conversations where id=p_conversation for update;
 if not found or c.source_channel<>'email' or c.origin<>'institutional_email' or c.test_hidden_at is not null or c.email_return_linked_to is not null then raise exception 'institutional email unavailable';end if;
 select * into t from public.crm_commercial_email_triage where conversation_id=p_conversation;
 if found then
  if t.initial_assigned_user_id<>p_advisor then raise exception 'already classified; use case assignment';end if;
  select assigned_user_id into current_advisor from public.crm_commercial_form_cases where conversation_id=p_conversation;
  if current_advisor is null then raise exception 'classified case unavailable';end if;
  return jsonb_build_object('conversationId',p_conversation,'assignedUserId',current_advisor,'alreadyClassified',true);
 end if;
 if not public.crm_commercial_team_case_allowed(p_advisor,false,p_advisor) then raise exception 'advisor unavailable';end if;
 if exists(select 1 from public.crm_commercial_form_cases where conversation_id=p_conversation) then raise exception 'unclassified case already exists';end if;
 if not exists(select 1 from public.crm_inbound_events e where e.conversation_id=c.id and e.source_channel='email' and e.origin=c.origin) then raise exception 'original inbound email required';end if;
 if c.qualification_data is not null and jsonb_typeof(c.qualification_data)<>'object' then raise exception 'qualification metadata invalid';end if;
 insert into public.crm_commercial_email_triage(conversation_id,classified_by,initial_assigned_user_id,reason,created_at)
 values(p_conversation,p_actor,p_advisor,btrim(p_reason),stamp);
 insert into public.crm_commercial_form_cases(conversation_id,assigned_user_id) values(p_conversation,p_advisor);
 update public.crm_conversations set qualification_data=jsonb_set(coalesce(qualification_data,'{}'::jsonb),'{commercial_triage}',
  jsonb_build_object('kind','owner_classified_institutional_email','classifiedAt',stamp,'classifiedBy',p_actor),true),updated_at=stamp where id=p_conversation;
 insert into public.crm_commercial_email_triage_audit(conversation_id,actor_id,details,created_at)
 values(p_conversation,p_actor,jsonb_build_object('reason',btrim(p_reason),'origin',c.origin,'sourceRef',c.source_ref,'initialAssignedUserId',p_advisor),stamp);
 insert into public.crm_commercial_team_audit(actor_id,action,subject_id,details)
 values(p_actor,'institutional_email_classified',p_conversation,jsonb_build_object('assignedUserId',p_advisor,'origin',c.origin));
 return jsonb_build_object('conversationId',p_conversation,'assignedUserId',p_advisor,'alreadyClassified',false);
end$$;
alter function public.crm_commercial_email_classify(uuid,uuid,uuid,text) owner to postgres;
revoke all on function public.crm_commercial_email_classify(uuid,uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.crm_commercial_email_classify(uuid,uuid,uuid,text) to service_role;
notify pgrst,'reload schema';
commit;
