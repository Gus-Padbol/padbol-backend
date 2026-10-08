-- Existing organization contract required by WhatsApp tenant foreign keys.
-- Additive only: no memberships, role changes, benefits or seed data.
begin;

create table if not exists public.organizaciones (
  id uuid primary key default gen_random_uuid(),
  nombre text not null,
  nombre_legal text,
  pais_principal text,
  email_contacto text,
  whatsapp_contacto text,
  plan_codigo text not null default 'business',
  limite_sedes integer not null default 1,
  limite_canchas_total integer not null default 1,
  limite_admins_centrales integer not null default 1,
  funciones_habilitadas text[] not null default array['reservas', 'torneos', 'jugadores', 'reportes']::text[],
  estado text not null default 'activa',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint organizaciones_nombre_check check (length(trim(nombre)) > 0),
  constraint organizaciones_estado_check check (estado in ('activa', 'pausada', 'baja')),
  constraint organizaciones_limites_check check (
    limite_sedes > 0 and limite_canchas_total > 0 and limite_admins_centrales > 0
  )
);

alter table public.organizaciones enable row level security;
revoke all on table public.organizaciones from public, anon, authenticated;
grant all on table public.organizaciones to service_role;
commit;
