-- Historial operativo manual y eventos entrantes del CRM.
-- No configura proveedores, jobs ni transporte saliente.
begin;

alter table public.crm_conversations
  add column if not exists funnel_state text not null default 'awaiting_path',
  add column if not exists selected_path text,
  add column if not exists qualification_data jsonb not null default '{}'::jsonb,
  add column if not exists qualification_question_count smallint not null default 0,
  add column if not exists qualification_status text not null default 'pending',
  add column if not exists next_prompt text,
  add column if not exists prompt_options jsonb not null default '[]'::jsonb,
  add column if not exists next_step text,
  add column if not exists handoff_ready boolean not null default false;

do $$ begin
  alter table public.crm_conversations add constraint crm_conversations_funnel_state_check
    check (length(trim(funnel_state)) between 1 and 120);
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.crm_conversations add constraint crm_conversations_selected_path_check
    check (selected_path is null or length(trim(selected_path)) between 1 and 120);
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.crm_conversations add constraint crm_conversations_qualification_data_check
    check (jsonb_typeof(qualification_data) = 'object');
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.crm_conversations add constraint crm_conversations_qualification_status_check
    check (qualification_status in ('pending', 'in_progress', 'qualified', 'disqualified', 'needs_review'));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.crm_conversations add constraint crm_conversations_qualification_question_count_check
    check (qualification_question_count between 0 and 3);
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.crm_conversations add constraint crm_conversations_next_prompt_check
    check (next_prompt is null or length(trim(next_prompt)) between 1 and 2000);
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.crm_conversations add constraint crm_conversations_prompt_options_check
    check (jsonb_typeof(prompt_options) = 'array');
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.crm_conversations add constraint crm_conversations_next_step_check
    check (next_step is null or length(trim(next_step)) between 1 and 2000);
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.crm_conversations add constraint crm_conversations_handoff_ready_check
    check (not handoff_ready or qualification_status = 'qualified');
exception when duplicate_object then null; end $$;

create index if not exists idx_crm_conversations_qualification_queue
  on public.crm_conversations (qualification_status, updated_at desc)
  where estado <> 'cerrado';

create table if not exists public.crm_activities (
  id uuid primary key default gen_random_uuid(),
  contact_id uuid not null references public.crm_contacts(id) on delete cascade,
  conversation_id uuid not null references public.crm_conversations(id) on delete cascade,
  activity_type text not null,
  summary text not null,
  outcome text,
  next_step text,
  follow_up_at timestamptz,
  author text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint crm_activities_type_check
    check (activity_type in ('note', 'phone_call', 'zoom_meeting', 'in_person_meeting')),
  constraint crm_activities_summary_check
    check (length(trim(summary)) between 1 and 2000),
  constraint crm_activities_outcome_check
    check (outcome is null or length(trim(outcome)) between 1 and 2000),
  constraint crm_activities_next_step_check
    check (next_step is null or length(trim(next_step)) between 1 and 2000),
  constraint crm_activities_author_check
    check (length(trim(author)) between 3 and 254)
);

create index if not exists idx_crm_activities_conversation_created
  on public.crm_activities (conversation_id, created_at desc, id desc);
create index if not exists idx_crm_activities_contact_created
  on public.crm_activities (contact_id, created_at desc, id desc);
create index if not exists idx_crm_activities_follow_up
  on public.crm_activities (follow_up_at, id)
  where follow_up_at is not null;

create table if not exists public.crm_inbound_events (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.crm_conversations(id) on delete cascade,
  source_channel text not null,
  source_ref text not null,
  origin text not null,
  subject text,
  body text,
  received_at timestamptz not null,
  created_at timestamptz not null default now(),
  constraint crm_inbound_events_channel_check
    check (source_channel in ('whatsapp', 'email')),
  constraint crm_inbound_events_source_ref_check
    check (length(source_ref) between 1 and 512),
  constraint crm_inbound_events_origin_check
    check (length(trim(origin)) between 1 and 120),
  constraint crm_inbound_events_subject_check
    check (subject is null or length(subject) between 1 and 512),
  constraint crm_inbound_events_body_check
    check (body is null or length(body) between 1 and 4000),
  constraint crm_inbound_events_source_unique
    unique (source_channel, origin, source_ref)
);

create index if not exists idx_crm_inbound_events_conversation_received
  on public.crm_inbound_events (conversation_id, received_at, id);

insert into public.crm_inbound_events
  (conversation_id, source_channel, source_ref, origin, subject, body, received_at)
select id, source_channel, source_ref, origin, subject, inbound_body, received_at
from public.crm_conversations
on conflict (source_channel, origin, source_ref) do nothing;

alter table public.crm_activities enable row level security;
alter table public.crm_inbound_events enable row level security;

revoke all on table public.crm_activities from anon, authenticated;
revoke all on table public.crm_inbound_events from anon, authenticated;

grant all on table public.crm_activities to service_role;
grant all on table public.crm_inbound_events to service_role;

comment on table public.crm_activities is
  'Historial operativo manual por contacto y conversación; no dispara comunicaciones.';
comment on table public.crm_inbound_events is
  'Mensajes entrantes idempotentes. WhatsApp puede agruparlos en un hilo abierto; email no se agrupa automáticamente.';

commit;
