-- Cada reserva identifica un intento manual real, sin confundir borradores del embudo.
-- Un intento incierto permanece pendiente hasta su reconciliación explícita.
begin;
create table if not exists public.crm_whatsapp_manual_attempts (
  reply_id uuid primary key references public.crm_replies(id) on delete restrict,
  conversation_id uuid not null references public.crm_conversations(id) on delete restrict,
  created_at timestamptz not null default now()
);
create index if not exists idx_crm_wa_manual_attempts_conversation on public.crm_whatsapp_manual_attempts(conversation_id);
alter table public.crm_whatsapp_manual_attempts enable row level security;
revoke all on table public.crm_whatsapp_manual_attempts from public, anon, authenticated;
grant all on table public.crm_whatsapp_manual_attempts to service_role;

create or replace function public.crm_claim_whatsapp_reply(p_id uuid, p_conversation_id uuid, p_body text, p_operator text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_conversation public.crm_conversations%rowtype; v_reply public.crm_replies%rowtype;
begin
  select * into v_conversation from public.crm_conversations where id = p_conversation_id for update;
  if not found or v_conversation.source_channel <> 'whatsapp' then
    raise exception 'invalid whatsapp conversation';
  end if;
  select r.* into v_reply from public.crm_replies r
    join public.crm_whatsapp_manual_attempts a on a.reply_id = r.id
    where r.id = p_id and a.conversation_id = p_conversation_id and r.conversation_id = p_conversation_id;
  if found then return jsonb_build_object('created', false, 'reply', to_jsonb(v_reply)); end if;
  if exists (select 1 from public.crm_whatsapp_manual_attempts a
    join public.crm_replies r on r.id = a.reply_id
    where a.conversation_id = p_conversation_id and r.status = 'pending') then
    return jsonb_build_object('created', false, 'blocked', true);
  end if;
  insert into public.crm_replies (id, conversation_id, body, operador, status)
  values (p_id, p_conversation_id, p_body, p_operator, 'pending') returning * into v_reply;
  insert into public.crm_whatsapp_manual_attempts (reply_id, conversation_id) values (p_id, p_conversation_id);
  return jsonb_build_object('created', true, 'reply', to_jsonb(v_reply));
end $$;
revoke all on function public.crm_claim_whatsapp_reply(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.crm_claim_whatsapp_reply(uuid, uuid, text, text) to service_role;
commit;
