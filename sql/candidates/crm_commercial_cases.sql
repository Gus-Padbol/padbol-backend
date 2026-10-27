-- Candidate foundation, not wired or deployable by itself. No historical backfill.
-- All writes must come from trusted routing logic in the same transaction as
-- inbound classification; these tables alone DO NOT classify messages.
begin;
create table public.crm_commercial_cases (
 id uuid primary key default gen_random_uuid(),
 conversation_id uuid not null references public.crm_conversations(id) on delete restrict,
 assigned_user_id uuid not null,
 status text not null default 'open' check (status in ('open','suspended','closed')),
 created_at timestamptz not null default now(),
 unique (id, conversation_id)
);
create unique index crm_commercial_cases_one_open on public.crm_commercial_cases(conversation_id) where status in ('open','suspended');
create function public.crm_commercial_case_check_conversation() returns trigger
language plpgsql set search_path=pg_catalog,public as $$
begin
 if tg_op='UPDATE' and new.conversation_id<>old.conversation_id then
   raise exception 'commercial case conversation is immutable';
 end if;
 if not exists (select 1 from public.crm_conversations c where c.id=new.conversation_id and c.source_channel='whatsapp') then
   raise exception 'commercial cases require WhatsApp';
 end if;
 return new;
end $$;
create trigger crm_commercial_case_conversation_check before insert or update on public.crm_commercial_cases for each row execute function public.crm_commercial_case_check_conversation();
create table public.crm_commercial_case_inbound (
 case_id uuid not null,
 conversation_id uuid not null,
 inbound_event_id uuid primary key references public.crm_inbound_events(id) on delete restrict,
 foreign key(case_id,conversation_id) references public.crm_commercial_cases(id,conversation_id) on delete restrict
);
create table public.crm_commercial_case_replies (
 case_id uuid not null,
 conversation_id uuid not null,
 reply_id uuid primary key references public.crm_replies(id) on delete restrict,
 foreign key(case_id,conversation_id) references public.crm_commercial_cases(id,conversation_id) on delete restrict
);
create function public.crm_commercial_case_check_membership() returns trigger
language plpgsql set search_path=pg_catalog,public as $$
begin
 if tg_table_name='crm_commercial_case_inbound' then
   if not exists (select 1 from public.crm_inbound_events e where e.id=new.inbound_event_id and e.conversation_id=new.conversation_id and e.source_channel='whatsapp') then
     raise exception 'commercial case inbound does not belong to WhatsApp conversation';
   end if;
 else
   if not exists (select 1 from public.crm_replies r where r.id=new.reply_id and r.conversation_id=new.conversation_id) then
     raise exception 'commercial case reply does not belong to conversation';
   end if;
 end if;
 if not exists (select 1 from public.crm_conversations c where c.id=new.conversation_id and c.source_channel='whatsapp') then
   raise exception 'commercial cases require WhatsApp';
 end if;
 return new;
end $$;
create trigger crm_commercial_case_inbound_check before insert or update on public.crm_commercial_case_inbound for each row execute function public.crm_commercial_case_check_membership();
create trigger crm_commercial_case_reply_check before insert or update on public.crm_commercial_case_replies for each row execute function public.crm_commercial_case_check_membership();
alter table public.crm_commercial_cases enable row level security;
alter table public.crm_commercial_case_inbound enable row level security;
alter table public.crm_commercial_case_replies enable row level security;
revoke all on public.crm_commercial_cases,public.crm_commercial_case_inbound,public.crm_commercial_case_replies from public,anon,authenticated;
grant all on public.crm_commercial_cases,public.crm_commercial_case_inbound,public.crm_commercial_case_replies to service_role;
revoke all on function public.crm_commercial_case_check_membership() from public,anon,authenticated;
revoke all on function public.crm_commercial_case_check_conversation() from public,anon,authenticated;
commit;
