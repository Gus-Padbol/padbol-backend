-- Atomic note + real conversation state. Invoked only by the authenticated backend
-- after its conversation-scope checks; never exposed to browser database roles.
begin;
create or replace function public.crm_register_activity_with_state(p_activity jsonb, p_state text)
returns jsonb language plpgsql security invoker set search_path = public as $$
declare v_conversation public.crm_conversations%rowtype; v_activity public.crm_activities%rowtype;
begin
  if p_state is null or p_state not in ('nuevo','en_atencion','derivado','cerrado') then
    raise exception 'Invalid conversation state' using errcode='22023';
  end if;
  select * into v_conversation from public.crm_conversations
    where id = (p_activity->>'conversation_id')::uuid for update;
  if not found or v_conversation.contact_id is distinct from (p_activity->>'contact_id')::uuid then
    raise exception 'Conversation not found' using errcode='P0002';
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
revoke all on function public.crm_register_activity_with_state(jsonb,text) from public, anon, authenticated;
grant execute on function public.crm_register_activity_with_state(jsonb,text) to service_role;
commit;
