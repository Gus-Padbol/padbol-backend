-- Suscripciones de notificaciones web push (PWA del CRM).
-- La clave privada VAPID nunca se guarda en la base ni en Git: solo vive en el entorno del servidor.
begin;

create table if not exists public.push_web_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  user_agent text,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  revoked_at timestamptz,
  failure_count integer not null default 0 check (failure_count >= 0)
);

create index if not exists push_web_subscriptions_user
  on public.push_web_subscriptions (user_id) where revoked_at is null;

alter table public.push_web_subscriptions enable row level security;
revoke all on table public.push_web_subscriptions from public,anon,authenticated;
grant all on table public.push_web_subscriptions to service_role;

commit;
