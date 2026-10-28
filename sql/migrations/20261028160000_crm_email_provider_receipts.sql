begin;
create table if not exists public.crm_email_provider_receipts (
  reply_id uuid primary key references public.crm_replies(id) on delete cascade,
  provider_message_id text not null unique,
  rfc_message_id text not null unique check(length(rfc_message_id) between 3 and 500),
  sent_at timestamptz,
  delivered_at timestamptz,
  bounced_at timestamptz,
  failed_at timestamptz,
  complained_at timestamptz,
  created_at timestamptz not null default now()
);
alter table public.crm_email_provider_receipts enable row level security;
revoke all on public.crm_email_provider_receipts from public,anon,authenticated;
grant select,insert,update on public.crm_email_provider_receipts to service_role;
create unique index if not exists crm_email_return_message_ref_unique
  on public.crm_inbound_events(source_ref)
  where source_channel='email' and source_ref like 'email-message:%';
commit;
