-- PADBOL PROSPECT: prospección comercial dentro del CRM existente.
-- No crea un CRM paralelo. Los prospectos se vinculan a contactos/conversaciones
-- existentes cuando hay coincidencia; no crean conversaciones ni envíos por sí solos.
begin;

create table if not exists public.crm_prospect_settings (
  singleton boolean primary key default true check (singleton),
  enabled boolean not null default true,
  send_enabled boolean not null default false,
  weights jsonb not null default '{"sport":25,"investment":20,"facilities":15,"locations":10,"compatibility":10,"representation":10,"franchise":5,"contactability":5,"activity":5}'::jsonb,
  daily_limit integer not null default 25 check (daily_limit between 1 and 200),
  updated_by text,
  updated_at timestamptz not null default now(),
  constraint crm_prospect_settings_singleton check (singleton)
);
insert into public.crm_prospect_settings(singleton) values(true) on conflict do nothing;

create table if not exists public.crm_prospects (
  id uuid primary key default gen_random_uuid(),
  dedupe_key text not null unique,
  external_source text not null,
  external_id text,
  name text,
  legal_name text,
  trade_name text,
  website text,
  domain text,
  email text,
  phone text,
  address text,
  city text,
  state text,
  country text not null default 'US',
  region text,
  latitude numeric,
  longitude numeric,
  sector text,
  opportunity_type text,
  parent_company text,
  location_type text not null default 'independent' check (location_type in ('independent','branch','franchise','headquarters','unknown')),
  locations_count integer check (locations_count is null or locations_count between 1 and 10000),
  activities text,
  facility_notes text,
  contact_name text,
  contact_role text,
  source_url text,
  source_checked_at timestamptz,
  data_status jsonb not null default '{}'::jsonb,
  score integer not null default 0 check (score between 0 and 100),
  grade text not null default 'C' check (grade in ('A','B','C')),
  score_breakdown jsonb not null default '[]'::jsonb,
  status text not null default 'investigated' check (status in ('investigated','verified','pending_approval','approved','contacted','delivered','responded','interested','negotiation','no_response','rejected','opt_out','bounced','paused','closed','existing')),
  priority text not null default 'normal' check (priority in ('low','normal','high')),
  assigned_user_id uuid,
  crm_contact_id uuid references public.crm_contacts(id) on delete set null,
  crm_conversation_id uuid references public.crm_conversations(id) on delete set null,
  crm_case_id uuid,
  is_padel_only boolean not null default false,
  exclusion_reason text,
  contact_block_reason text,
  last_verified_at timestamptz,
  created_by text,
  updated_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists crm_prospects_market_idx on public.crm_prospects(country,state,city);
create index if not exists crm_prospects_status_idx on public.crm_prospects(status,priority,score desc);
create index if not exists crm_prospects_domain_idx on public.crm_prospects(domain);
create index if not exists crm_prospects_email_idx on public.crm_prospects(email);
create index if not exists crm_prospects_phone_idx on public.crm_prospects(phone);
create unique INDEX if not exists crm_prospects_source_external_unique on public.crm_prospects(external_source,external_id) where external_id is not null;

create table if not exists public.crm_prospect_runs (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid,
  source text not null,
  country text not null,
  state text,
  city text,
  sector text,
  opportunity_type text,
  requested_limit integer not null default 50,
  found_count integer not null default 0,
  inserted_count integer not null default 0,
  updated_count integer not null default 0,
  duplicate_count integer not null default 0,
  excluded_count integer not null default 0,
  status text not null default 'running' check (status in ('running','completed','failed','simulated')),
  cost_cents integer not null default 0,
  error text,
  metadata jsonb not null default '{}'::jsonb,
  started_at timestamptz not null default now(),
  finished_at timestamptz
);

create table if not exists public.crm_prospect_campaigns (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  opportunity_type text,
  country text,
  language text not null default 'en' check (language in ('en','es')),
  status text not null default 'draft' check (status in ('draft','pending_approval','approved','active','paused','completed','stopped')),
  daily_limit integer not null default 25 check (daily_limit between 1 and 200),
  sender_identity text,
  template_key text,
  subject_template text,
  body_template text,
  approved_by uuid,
  approved_at timestamptz,
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.crm_prospect_campaign_steps (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.crm_prospect_campaigns(id) on delete cascade,
  day integer not null check (day in (0,7,14)),
  subject text not null,
  body text not null,
  unique (campaign_id, day)
);

create table if not exists public.crm_prospect_messages (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.crm_prospect_campaigns(id) on delete cascade,
  prospect_id uuid not null references public.crm_prospects(id) on delete cascade,
  step_day integer not null check (step_day in (0,7,14)),
  recipient text,
  subject text,
  body text,
  status text not null default 'simulated' check (status in ('simulated','queued','sent','delivered','bounced','responded','suppressed','failed','cancelled')),
  idempotency_key text not null unique,
  provider_message_id text,
  scheduled_at timestamptz,
  sent_at timestamptz,
  error text,
  created_at timestamptz not null default now()
);
create index if not exists crm_prospect_messages_campaign_idx on public.crm_prospect_messages(campaign_id,status);

create table if not exists public.crm_prospect_events (
  id bigserial primary key,
  prospect_id uuid references public.crm_prospects(id) on delete cascade,
  campaign_id uuid references public.crm_prospect_campaigns(id) on delete cascade,
  message_id uuid references public.crm_prospect_messages(id) on delete set null,
  event_type text not null,
  detail jsonb not null default '{}'::jsonb,
  actor_id uuid,
  created_at timestamptz not null default now()
);

create table if not exists public.crm_prospect_suppressions (
  id uuid primary key default gen_random_uuid(),
  email text,
  domain text,
  phone text,
  reason text not null,
  source text,
  active boolean not null default true,
  created_by text,
  created_at timestamptz not null default now(),
  constraint crm_prospect_suppression_identity check (email is not null or domain is not null or phone is not null)
);
create unique index if not exists crm_prospect_suppression_email_unique on public.crm_prospect_suppressions(lower(email)) where email is not null and active;
create unique index if not exists crm_prospect_suppression_domain_unique on public.crm_prospect_suppressions(lower(domain)) where domain is not null and active;
create unique index if not exists crm_prospect_suppression_phone_unique on public.crm_prospect_suppressions(phone) where phone is not null and active;

alter table public.crm_prospect_settings enable row level security;
alter table public.crm_prospects enable row level security;
alter table public.crm_prospect_runs enable row level security;
alter table public.crm_prospect_campaigns enable row level security;
alter table public.crm_prospect_campaign_steps enable row level security;
alter table public.crm_prospect_messages enable row level security;
alter table public.crm_prospect_events enable row level security;
alter table public.crm_prospect_suppressions enable row level security;
revoke all on public.crm_prospect_settings,public.crm_prospects,public.crm_prospect_runs,public.crm_prospect_campaigns,public.crm_prospect_campaign_steps,public.crm_prospect_messages,public.crm_prospect_events,public.crm_prospect_suppressions from public,anon,authenticated;
grant all on public.crm_prospect_settings,public.crm_prospects,public.crm_prospect_runs,public.crm_prospect_campaigns,public.crm_prospect_campaign_steps,public.crm_prospect_messages,public.crm_prospect_events,public.crm_prospect_suppressions to service_role;
commit;
