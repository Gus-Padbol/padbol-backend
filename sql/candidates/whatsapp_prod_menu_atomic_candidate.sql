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

create function public.crm_commit_whatsapp_menu_transition(
  p_inbound_id uuid, p_conversation_id uuid, p_expected_updated_at timestamptz,
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
    insert into public.crm_whatsapp_menu_events(inbound_message_id, conversation_id)
      values (p_inbound_id, p_conversation_id);
    return jsonb_build_object('created', true, 'stale', true, 'reply_id', null, 'outbox_id', null);
  end if;
  if not v_channel.active or v_inbound.message_type <> 'text' or v_inbound.meta_media_type is not null or v_inbound.received_at > now() or v_inbound.received_at <= now() - interval '24 hours'
     or v_conversation.estado <> 'nuevo' or v_conversation.operador is not null
     or coalesce(v_conversation.derivado, false) or v_conversation.sede_id is not null
     or v_conversation.assigned_by is not null or coalesce(v_conversation.handoff_ready, false)
     or coalesce((v_conversation.qualification_data #>> '{whatsapp_order_review,required}')::boolean, false)
     then raise exception 'not eligible'; end if;
  if p_expected_updated_at is null or v_conversation.updated_at <> p_expected_updated_at then
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
revoke all on function public.crm_commit_whatsapp_menu_transition(uuid, uuid, timestamptz, jsonb, text, text) from public, anon, authenticated;
grant execute on function public.crm_commit_whatsapp_menu_transition(uuid, uuid, timestamptz, jsonb, text, text) to service_role;
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
