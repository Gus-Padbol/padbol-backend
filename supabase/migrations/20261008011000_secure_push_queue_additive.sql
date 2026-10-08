BEGIN;
create extension if not exists pgcrypto;
create table if not exists public.push_delivery_jobs (
  id uuid primary key default gen_random_uuid(),
  idempotency_key text not null unique,
  source text not null,
  category text not null check (category in ('transactional', 'marketing')),
  event_type text not null,
  title text not null,
  body text not null,
  payload jsonb not null default '{}'::jsonb,
  actor_user_id uuid references auth.users(id) on delete set null,
  recipient_count integer not null default 0,
  token_count integer not null default 0,
  accepted_count integer not null default 0,
  failed_count integer not null default 0,
  status text not null default 'processing'
    check (status in ('processing', 'sent', 'partial', 'no_tokens', 'failed')),
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.push_delivery_attempts (
  id bigserial primary key,
  job_id uuid not null references public.push_delivery_jobs(id) on delete cascade,
  push_token_id integer references public.push_tokens(id) on delete set null,
  user_id uuid references auth.users(id) on delete set null,
  token_fingerprint text not null,
  expo_ticket_id text,
  status text not null
    check (status in ('ticket_ok', 'ticket_error', 'delivered', 'receipt_error', 'invalidated', 'receipt_timeout')),
  error_code text,
  error_message text,
  attempt_count integer not null default 1,
  receipt_check_count integer not null default 0,
  next_receipt_check_at timestamptz,
  receipt_checked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists push_delivery_attempts_pending_receipt_idx
  on public.push_delivery_attempts (next_receipt_check_at)
  where status = 'ticket_ok' and expo_ticket_id is not null;


ALTER TABLE public.push_delivery_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.push_delivery_attempts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.push_delivery_jobs, public.push_delivery_attempts FROM anon, authenticated;
GRANT ALL ON public.push_delivery_jobs, public.push_delivery_attempts TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.push_delivery_attempts_id_seq TO service_role;
NOTIFY pgrst, 'reload schema';
COMMIT;
