-- Atomic note + real conversation state. Invoked only by the authenticated backend
-- after its conversation-scope checks; never exposed to browser database roles.
begin;
alter table public.crm_activities add column if not exists support_command_hash text;
create or replace function public.crm_register_activity_with_state(p_activity jsonb, p_state text)
returns jsonb language plpgsql security invoker set search_path = public as $$
declare v_conversation public.crm_conversations%rowtype; v_activity public.crm_activities%rowtype; v_support boolean; v_id uuid; v_hash text;
begin
  if p_state is null or p_state not in ('nuevo','en_atencion','derivado','cerrado') then
    raise exception 'Invalid conversation state' using errcode='22023';
  end if;
  select * into v_conversation from public.crm_conversations
    where id = (p_activity->>'conversation_id')::uuid for update;
  if not found or v_conversation.contact_id is distinct from (p_activity->>'contact_id')::uuid then
    raise exception 'Conversation not found' using errcode='P0002';
  end if;
  v_support := coalesce(v_conversation.source_channel = 'email' and v_conversation.origin = 'support_email'
    and v_conversation.qualification_data->'mailbox'->>'address' = 'support@padbol.com',false);
  if v_support then
    if current_setting('transaction_isolation') <> 'read committed' then raise exception 'Support requires read committed' using errcode='P0001'; end if;
    v_id := (p_activity->>'id')::uuid;
    if v_id is null then raise exception 'Support command reference required' using errcode='22023'; end if;
    v_hash := encode(sha256(convert_to(jsonb_build_object('state',p_state,'activity',p_activity)::text,'UTF8')),'hex');
    select * into v_activity from public.crm_activities where id=v_id;
    if found then
      if v_activity.conversation_id is distinct from v_conversation.id or v_activity.support_command_hash is distinct from v_hash then
        raise exception 'Support reference conflict' using errcode='23505';
      end if;
      return to_jsonb(v_activity);
    end if;
    if v_conversation.estado='cerrado' then raise exception 'Support already closed' using errcode='P0001'; end if;
    if p_state='cerrado' and (not v_conversation.derivado or nullif(trim(v_conversation.operador),'') is null
      or nullif(trim(p_activity->>'outcome'),'') is null or not exists(select 1 from public.crm_replies
        where conversation_id=v_conversation.id and status='sent' and nullif(trim(provider_message_id),'') is not null)
      or exists(select 1 from public.crm_replies where conversation_id=v_conversation.id and status='pending')) then
      raise exception 'Support resolution prerequisites missing' using errcode='P0001';
    end if;
    insert into public.crm_activities(id,contact_id,conversation_id,activity_type,summary,outcome,next_step,follow_up_at,author,support_command_hash)
      values(v_id,v_conversation.contact_id,v_conversation.id,p_activity->>'activity_type',p_activity->>'summary',p_activity->>'outcome',
        p_activity->>'next_step',(p_activity->>'follow_up_at')::timestamptz,p_activity->>'author',v_hash) returning * into v_activity;
    update public.crm_conversations set estado=p_state,operador=p_activity->>'author',
      derivado=case when p_state='derivado' then true else derivado end,updated_at=now() where id=v_conversation.id;
    return to_jsonb(v_activity);
  end if;
  insert into public.crm_activities(contact_id, conversation_id, activity_type, summary, outcome, next_step, follow_up_at, author)
    values(v_conversation.contact_id, v_conversation.id, p_activity->>'activity_type', p_activity->>'summary',
      p_activity->>'outcome', p_activity->>'next_step', (p_activity->>'follow_up_at')::timestamptz, p_activity->>'author')
    returning * into v_activity;
  update public.crm_conversations set estado=p_state, operador=p_activity->>'author', updated_at=now()
    where id=v_conversation.id;
  return to_jsonb(v_activity);
end;
$$;
-- Fence creation of new support replies against concurrent closure. Existing
-- reply IDs can still reach the unique constraint and be recovered without send.
create or replace function public.crm_guard_support_reply_open()
returns trigger language plpgsql security invoker set search_path=public as $$
declare c public.crm_conversations%rowtype;
begin
 select * into c from public.crm_conversations where id=NEW.conversation_id for update;
 if coalesce(c.source_channel='email' and c.origin='support_email' and c.qualification_data->'mailbox'->>'address'='support@padbol.com',false) then
  if current_setting('transaction_isolation') <> 'read committed' then raise exception 'Support requires read committed' using errcode='P0001'; end if;
  if c.estado='cerrado' and not exists(select 1 from public.crm_replies where id=NEW.id) then
   raise exception 'Support already closed' using errcode='23514';
  end if;
 end if;
 return NEW;
end;
$$;
drop trigger if exists crm_support_reply_open on public.crm_replies;
create trigger crm_support_reply_open before insert on public.crm_replies for each row execute function public.crm_guard_support_reply_open();
commit;
