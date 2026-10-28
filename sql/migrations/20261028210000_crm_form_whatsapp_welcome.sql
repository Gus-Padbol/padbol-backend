begin;
-- Empty outbox: no historical backfill or network delivery in this migration.
create table public.crm_form_welcome_dispatches (
 id uuid primary key,conversation_id uuid not null references public.crm_conversations(id),
 event_id uuid not null unique references public.crm_inbound_events(id),
 recipient_wa_id text not null unique check(recipient_wa_id ~ '^[1-9][0-9]{7,14}$'),
 language text not null check(language in ('es','en')),consent jsonb not null,template_name text not null,body text not null,
 status text not null check(status in ('reserved','dispatching','accepted','uncertain','cancelled')),
 provider_message_id text,created_at timestamptz not null default now(),updated_at timestamptz not null default now(),accepted_at timestamptz
);
alter table public.crm_form_welcome_dispatches enable row level security;
revoke all on public.crm_form_welcome_dispatches from public,anon,authenticated;
grant select,insert,update on public.crm_form_welcome_dispatches to service_role;
commit;
