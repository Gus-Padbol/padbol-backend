begin;
create table if not exists public.crm_lead_notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  case_type text not null check (case_type in ('form','whatsapp','email','test')),
  case_id uuid not null,
  conversation_id uuid,
  title text not null,
  body text not null,
  link text,
  read_at timestamptz,
  created_at timestamptz not null default now(),
  unique(user_id,case_type,case_id)
);
create index if not exists crm_lead_notifications_user_unread_idx on public.crm_lead_notifications(user_id,created_at desc) where read_at is null;
alter table public.crm_lead_notifications enable row level security;
revoke all on public.crm_lead_notifications from public,anon,authenticated;
commit;
