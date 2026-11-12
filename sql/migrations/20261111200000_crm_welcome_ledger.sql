-- Candidate additive migration (NOT applied). Bounded CRM welcome purpose ledger.
-- Contract 20261111 §2/§3/§4. Server-only. No PII columns.
begin;

create table if not exists public.crm_welcome_ledger (
  attempt_id uuid primary key default gen_random_uuid(),
  contact_id uuid not null references public.crm_contacts(id) on delete restrict,
  purpose text not null check (purpose in ('welcome')),
  status text not null default 'claimed' check (status in ('claimed','accepted','uncertain','rejected')),
  provider_key text not null check (provider_key ~ '^[a-z0-9][a-z0-9:_-]{0,119}$'),
  claimed_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  accepted_at timestamptz,
  uncertain_at timestamptz,
  rejected_at timestamptz,
  provider_message_id text check (provider_message_id is null or length(provider_message_id) between 1 and 512),
  rejection_code text check (rejection_code is null or length(rejection_code) <= 80),
  -- One welcome per contact, ever. Purpose distinguishes future ack/notification
  -- ledgers without colliding with this one.
  constraint crm_welcome_ledger_one_per_purpose unique (contact_id, purpose),
  constraint crm_welcome_ledger_status_time check (
    (status='claimed'   and accepted_at is null     and uncertain_at is null     and rejected_at is null and provider_message_id is null)
    or (status='accepted'  and accepted_at is not null  and provider_message_id is not null)
    or (status='uncertain' and uncertain_at is not null)
    or (status='rejected'  and rejected_at is not null)
  )
);

alter table public.crm_welcome_ledger enable row level security;
revoke all on public.crm_welcome_ledger from public, anon, authenticated;
grant select, insert, update on public.crm_welcome_ledger to service_role;

comment on table public.crm_welcome_ledger is
  'Purpose ledger: at most one welcome attempt per contact. Claim precedes any provider call. Terminal states never release the claim.';
comment on column public.crm_welcome_ledger.provider_key is
  'Stable provider dedup key (secondary, short-term). The durable guarantee is unique(contact_id,purpose).';

commit;
