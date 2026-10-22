-- PRODUCTION CANDIDATE ONLY. Do not apply until separately reviewed. Does not activate sending.
begin;
create table public.crm_whatsapp_menu_events (
  inbound_message_id uuid primary key references public.whatsapp_inbound_messages(id),
  conversation_id uuid not null references public.crm_conversations(id),
  reply_id uuid references public.crm_replies(id),
  outbox_id uuid references public.whatsapp_outbox(id),
  menu_revision bigint,
  created_at timestamptz not null default now(),
  constraint crm_whatsapp_menu_event_reply_pair check ((reply_id is null) = (outbox_id is null))
);
alter table public.crm_whatsapp_menu_events enable row level security;
revoke all on public.crm_whatsapp_menu_events from public, anon, authenticated;
grant all on public.crm_whatsapp_menu_events to service_role;

-- Serialize creation for the same existing contact and WhatsApp origin without
-- merging historical records or changing the identity of any contact.
create function public.crm_get_or_create_whatsapp_conversation(p_payload jsonb)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_contact uuid; v_origin text; v_conversation public.crm_conversations%rowtype; v_event public.crm_inbound_events%rowtype; v_created boolean := false;
begin
  v_contact := (p_payload->>'contact_id')::uuid; v_origin := p_payload->>'origin';
  if v_contact is null or p_payload->>'source_channel' <> 'whatsapp' or length(trim(coalesce(v_origin,''))) not between 1 and 120 then raise exception 'invalid conversation identity'; end if;
  perform 1 from public.crm_contacts where id=v_contact for update;
  if not found then raise exception 'contact not found'; end if;
  select * into v_event from public.crm_inbound_events where source_channel='whatsapp' and origin=v_origin and source_ref=p_payload->>'source_ref';
  if found then
    select * into v_conversation from public.crm_conversations where id=v_event.conversation_id and contact_id=v_contact;
    if not found then raise exception 'inbound identity mismatch'; end if;
    return jsonb_build_object('conversation',to_jsonb(v_conversation),'created',false,'event',to_jsonb(v_event));
  end if;
  select * into v_conversation from public.crm_conversations where contact_id=v_contact and source_channel='whatsapp' and origin=v_origin and estado <> 'cerrado' order by updated_at desc,id desc limit 1 for update;
  if not found then
    insert into public.crm_conversations(contact_id,source_channel,source_ref,attempt_id,identity_used,origin,subject,inbound_body,qualification_data,received_at,estado)
    values(v_contact,'whatsapp',p_payload->>'source_ref',p_payload->>'attempt_id',p_payload->>'identity_used',v_origin,p_payload->>'subject',p_payload->>'inbound_body',coalesce(p_payload->'qualification_data','{}'::jsonb),(p_payload->>'received_at')::timestamptz,'nuevo') returning * into v_conversation;
    v_created := true;
  end if;
  insert into public.crm_inbound_events(conversation_id,source_channel,source_ref,origin,subject,body,received_at)
    values(v_conversation.id,'whatsapp',p_payload->>'source_ref',v_origin,p_payload->>'subject',p_payload->>'inbound_body',(p_payload->>'received_at')::timestamptz)
    returning * into v_event;
  if not v_created then
    update public.crm_conversations set received_at=v_event.received_at,inbound_body=v_event.body,updated_at=now() where id=v_conversation.id;
  end if;
  select * into v_conversation from public.crm_conversations where id=v_conversation.id;
  return jsonb_build_object('conversation',to_jsonb(v_conversation),'created',v_created,'event',to_jsonb(v_event));
end $$;
revoke all on function public.crm_get_or_create_whatsapp_conversation(jsonb) from public,anon,authenticated;
grant execute on function public.crm_get_or_create_whatsapp_conversation(jsonb) to service_role;

create function public.crm_commit_whatsapp_menu_transition(
  p_inbound_id uuid, p_conversation_id uuid, p_expected_version bigint,
  p_state jsonb, p_response text, p_idempotency_key text
) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_inbound public.whatsapp_inbound_messages%rowtype;
  v_channel public.whatsapp_tenant_channels%rowtype;
  v_conversation public.crm_conversations%rowtype;
  v_event public.crm_whatsapp_menu_events%rowtype;
  v_reply uuid; v_outbox uuid; v_revision bigint;
begin
  select * into v_inbound from public.whatsapp_inbound_messages where id = p_inbound_id;
  if not found then raise exception 'inbound not found'; end if;
  select * into v_channel from public.whatsapp_tenant_channels
    where id = v_inbound.channel_id and tenant_id = v_inbound.tenant_id;
  if not found then raise exception 'channel not found'; end if;
  select * into v_conversation from public.crm_conversations where id = p_conversation_id for update;
  if not found or v_conversation.source_channel <> 'whatsapp' then raise exception 'invalid conversation'; end if;
  if not exists (select 1 from public.crm_inbound_events e where e.conversation_id = p_conversation_id
      and e.source_channel = 'whatsapp' and e.source_ref = v_inbound.provider_message_id
      and e.origin = 'whatsapp:' || v_channel.meta_phone_number_id) then
    raise exception 'inbound conversation mismatch';
  end if;
  select * into v_event from public.crm_whatsapp_menu_events where inbound_message_id = p_inbound_id;
  if found then
    if v_event.conversation_id <> p_conversation_id then raise exception 'event conversation mismatch'; end if;
    return jsonb_build_object('created', false, 'reply_id', v_event.reply_id, 'outbox_id', v_event.outbox_id, 'revision', v_event.menu_revision);
  end if;
  -- If an older delivery arrives after a newer transition, keep it in the
  -- inbox for human review instead of interpreting it as an answer to a newer menu.
  if exists (select 1 from public.crm_whatsapp_menu_events e
      join public.whatsapp_inbound_messages prior on prior.id = e.inbound_message_id
      where e.conversation_id = p_conversation_id
      and prior.received_at >= v_inbound.received_at) then
    update public.crm_conversations set qualification_data=jsonb_set(
      coalesce(qualification_data, '{}'::jsonb), '{whatsapp_message_order_review}',
      '{"required":true,"reason":"ambiguous_message_order"}'::jsonb, true),
      updated_at=clock_timestamp() where id=p_conversation_id;
    insert into public.crm_whatsapp_menu_events(inbound_message_id, conversation_id)
      values (p_inbound_id, p_conversation_id);
    return jsonb_build_object('created', true, 'stale', true, 'reply_id', null, 'outbox_id', null);
  end if;
  if not v_channel.active or v_inbound.message_type <> 'text' or v_inbound.meta_media_type is not null or v_inbound.received_at > now() or v_inbound.received_at <= now() - interval '24 hours'
     or v_conversation.estado <> 'nuevo' or v_conversation.operador is not null
     or coalesce(v_conversation.derivado, false) or v_conversation.sede_id is not null
     or v_conversation.assigned_by is not null or coalesce(v_conversation.handoff_ready, false)
     or coalesce((v_conversation.qualification_data #>> '{whatsapp_order_review,required}')::boolean, false)
     or coalesce((v_conversation.qualification_data #>> '{whatsapp_message_order_review,required}')::boolean, false)
     then raise exception 'not eligible'; end if;
  if exists (select 1 from public.crm_whatsapp_menu_events e join public.whatsapp_outbox o on o.id=e.outbox_id
      where e.conversation_id=p_conversation_id and (o.status='sending' or o.last_error='WHATSAPP_SEND_UNCERTAIN_NO_RETRY')) then
    raise exception 'unresolved menu delivery';
  end if;
  if p_expected_version is null or v_conversation.test_visibility_version <> p_expected_version then
    raise exception 'conversation revision changed' using errcode = '40001';
  end if;
  if jsonb_typeof(p_state) <> 'object' or p_state->>'funnel_state' is null
     or jsonb_typeof(p_state->'qualification_data') <> 'object'
     or jsonb_typeof(p_state->'prompt_options') <> 'array'
     or p_state->>'qualification_status' not in ('pending', 'in_progress', 'qualified', 'disqualified', 'needs_review')
     or (p_response is not null and length(trim(p_response)) not between 1 and 2000)
     or (p_response is not null and (p_idempotency_key is null or p_idempotency_key !~ '^[0-9a-f]{64}$')) then
    raise exception 'invalid menu transition';
  end if;
  update public.crm_conversations set
    funnel_state = p_state->>'funnel_state', selected_path = p_state->>'selected_path',
    qualification_data = p_state->'qualification_data',
    qualification_question_count = coalesce((p_state->>'qualification_question_count')::integer, 0),
    qualification_status = p_state->>'qualification_status', next_prompt = p_state->>'next_prompt',
    prompt_options = p_state->'prompt_options', next_step = p_state->>'next_step',
    handoff_ready = coalesce((p_state->>'handoff_ready')::boolean, false), updated_at = clock_timestamp()
    where id = p_conversation_id returning test_visibility_version into v_revision;
  if p_response is not null then
    insert into public.crm_replies(conversation_id, body, operador, status)
      values (p_conversation_id, p_response, 'crm_funnel', 'pending') returning id into v_reply;
    insert into public.whatsapp_outbox(tenant_id, channel_id, inbound_message_id, idempotency_key,
      to_wa_id, reply_to_provider_message_id, message_type, text_body, status, customer_service_window_expires_at)
      values (v_inbound.tenant_id, v_inbound.channel_id, v_inbound.id, p_idempotency_key,
        v_inbound.from_wa_id, v_inbound.provider_message_id, 'text', p_response, 'pending',
        v_inbound.received_at + interval '24 hours') returning id into v_outbox;
  end if;
  insert into public.crm_whatsapp_menu_events(inbound_message_id, conversation_id, reply_id, outbox_id, menu_revision)
    values (p_inbound_id, p_conversation_id, v_reply, v_outbox, v_revision);
  return jsonb_build_object('created', true, 'reply_id', v_reply, 'outbox_id', v_outbox, 'revision', v_revision);
end $$;
revoke all on function public.crm_commit_whatsapp_menu_transition(uuid, uuid, bigint, jsonb, text, text) from public, anon, authenticated;
grant execute on function public.crm_commit_whatsapp_menu_transition(uuid, uuid, bigint, jsonb, text, text) to service_role;
-- Used after CRM authorization; no message bodies or identifiers leave this RPC.
create function public.crm_whatsapp_menu_needs_review(p_conversation_id uuid) returns boolean
language sql security definer set search_path=public,pg_temp stable as $$
  select exists (select 1 from public.crm_whatsapp_menu_events e join public.whatsapp_outbox o on o.id=e.outbox_id
    where e.conversation_id=p_conversation_id and (o.status='sending' or o.last_error='WHATSAPP_SEND_UNCERTAIN_NO_RETRY'))
$$;
revoke all on function public.crm_whatsapp_menu_needs_review(uuid) from public,anon,authenticated;
grant execute on function public.crm_whatsapp_menu_needs_review(uuid) to service_role;
create function public.crm_whatsapp_menu_review_batch(p_conversation_ids uuid[]) returns table(conversation_id uuid)
language sql security definer set search_path=public,pg_temp stable as $$
  select distinct e.conversation_id from public.crm_whatsapp_menu_events e join public.whatsapp_outbox o on o.id=e.outbox_id
    where e.conversation_id=any(p_conversation_ids) and (o.status='sending' or o.last_error='WHATSAPP_SEND_UNCERTAIN_NO_RETRY')
$$;
revoke all on function public.crm_whatsapp_menu_review_batch(uuid[]) from public,anon,authenticated;
grant execute on function public.crm_whatsapp_menu_review_batch(uuid[]) to service_role;
-- A human superadmin reviews provider evidence before releasing an uncertain case.
-- This does not send or retry a message. Identity/permissions are checked by CRM.
create table public.crm_whatsapp_menu_reconciliation (
  id uuid primary key default gen_random_uuid(), outbox_id uuid not null unique references public.whatsapp_outbox(id),
  conversation_id uuid not null references public.crm_conversations(id), reviewer_id uuid not null,
  outcome text not null check(outcome in ('delivered','not_delivered')),
  evidence_sha256 text not null check(evidence_sha256 ~ '^[0-9a-f]{64}$'),
  provider_message_id text, created_at timestamptz not null default now()
);
alter table public.crm_whatsapp_menu_reconciliation enable row level security;
revoke all on public.crm_whatsapp_menu_reconciliation from public,anon,authenticated,service_role;
grant select on public.crm_whatsapp_menu_reconciliation to service_role;
create function public.crm_reconcile_whatsapp_menu(p_conversation_id uuid,p_reviewer_id uuid,p_outcome text,p_evidence_sha256 text,p_provider_id text)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare o public.whatsapp_outbox%rowtype; v_reply uuid; v_count integer;
begin
  if p_reviewer_id is null or p_outcome not in ('delivered','not_delivered') or p_evidence_sha256 !~ '^[0-9a-f]{64}$'
    or (p_outcome='delivered' and (p_provider_id is null or length(trim(p_provider_id)) not between 1 and 512))
    or (p_outcome='not_delivered' and p_provider_id is not null) then raise exception 'invalid review'; end if;
  perform 1 from public.crm_conversations where id=p_conversation_id and source_channel='whatsapp' for update;
  if not found then raise exception 'conversation not found'; end if;
  select count(*) into v_count from public.crm_whatsapp_menu_events e join public.whatsapp_outbox b on b.id=e.outbox_id
    where e.conversation_id=p_conversation_id and (b.status='sending' or b.last_error='WHATSAPP_SEND_UNCERTAIN_NO_RETRY');
  if v_count<>1 then raise exception 'review requires exactly one unresolved delivery'; end if;
  select b.* into o from public.crm_whatsapp_menu_events e join public.whatsapp_outbox b on b.id=e.outbox_id
    where e.conversation_id=p_conversation_id and (b.status='sending' or b.last_error='WHATSAPP_SEND_UNCERTAIN_NO_RETRY') for update of b;
  select e.reply_id into v_reply from public.crm_whatsapp_menu_events e where e.outbox_id=o.id and e.conversation_id=p_conversation_id;
  insert into public.crm_whatsapp_menu_reconciliation(outbox_id,conversation_id,reviewer_id,outcome,evidence_sha256,provider_message_id)
    values(o.id,p_conversation_id,p_reviewer_id,p_outcome,p_evidence_sha256,p_provider_id);
  update public.whatsapp_outbox set status=case when p_outcome='delivered' then 'sent' else 'cancelled' end,
    provider_message_id=case when p_outcome='delivered' then p_provider_id else null end,
    sent_at=case when p_outcome='delivered' then clock_timestamp() else null end,
    last_error=case when p_outcome='delivered' then null else 'REVIEWED_NOT_DELIVERED' end, updated_at=clock_timestamp() where id=o.id;
  update public.crm_replies set status=case when p_outcome='delivered' then 'sent' else 'cancelled' end where id=v_reply and status='pending';
  if not found then raise exception 'review reply not pending'; end if;
  update public.crm_conversations set qualification_data=qualification_data - 'whatsapp_order_review',updated_at=clock_timestamp()
    where id=p_conversation_id and qualification_data #>> '{whatsapp_order_review,reason}'='uncertain_automated_delivery';
  return jsonb_build_object('reviewed',true,'outcome',p_outcome);
end $$;
revoke all on function public.crm_reconcile_whatsapp_menu(uuid,uuid,text,text,text) from public,anon,authenticated;
grant execute on function public.crm_reconcile_whatsapp_menu(uuid,uuid,text,text,text) to service_role;
-- Manual sending must wait for reconciliation of an ambiguous automated send.
-- crm_claim_whatsapp_reply holds the same conversation row lock before insert.
create function public.crm_guard_manual_whatsapp_uncertainty() returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
begin
  perform 1 from public.crm_conversations where id=new.conversation_id for update;
  if not found then raise exception 'conversation not found'; end if;
  if exists (select 1 from public.crm_whatsapp_menu_events e join public.whatsapp_outbox o on o.id=e.outbox_id
      where e.conversation_id=new.conversation_id and (o.status='sending' or o.last_error='WHATSAPP_SEND_UNCERTAIN_NO_RETRY')) then
    raise exception 'unresolved menu delivery';
  end if;
  return new;
end $$;
revoke all on function public.crm_guard_manual_whatsapp_uncertainty() from public,anon,authenticated;
create trigger crm_manual_whatsapp_uncertainty_guard before insert on public.crm_whatsapp_manual_attempts
  for each row execute function public.crm_guard_manual_whatsapp_uncertainty();
-- Confirm the provider acknowledgement and the CRM transcript together.
create function public.crm_confirm_whatsapp_menu_sent(
  p_outbox_id uuid, p_tenant_id uuid, p_provider_message_id text, p_sent_at timestamptz
) returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare v_reply_id uuid;
begin
  if p_provider_message_id is null or length(trim(p_provider_message_id)) = 0 or p_sent_at is null then
    raise exception 'invalid provider acknowledgement';
  end if;
  select e.reply_id into v_reply_id from public.crm_whatsapp_menu_events e
    join public.whatsapp_outbox o on o.id = e.outbox_id
    where o.id = p_outbox_id and o.tenant_id = p_tenant_id and o.status = 'sending' for update of o;
  if not found or v_reply_id is null then raise exception 'menu outbox not claimed'; end if;
  update public.whatsapp_outbox set status = 'sent', provider_message_id = p_provider_message_id,
    sent_at = p_sent_at, last_error = null, updated_at = p_sent_at where id = p_outbox_id;
  update public.crm_replies set status = 'sent' where id = v_reply_id;
  if not found then raise exception 'menu reply not found'; end if;
end $$;
revoke all on function public.crm_confirm_whatsapp_menu_sent(uuid, uuid, text, timestamptz) from public, anon, authenticated;
grant execute on function public.crm_confirm_whatsapp_menu_sent(uuid, uuid, text, timestamptz) to service_role;
commit;
