-- Esquema requerido por las rutas backend de "Busca tu dupla".
-- Idempotente y cerrado a clientes directos: el acceso se realiza únicamente
-- por el backend autenticado con service role.

create table if not exists public.busca_dupla_torneo (
  id bigint generated always as identity primary key,
  torneo_id bigint not null references public.torneos (id) on delete cascade,
  user_id uuid not null,
  created_at timestamptz not null default now(),
  constraint busca_dupla_torneo_torneo_user_uniq unique (torneo_id, user_id)
);

create index if not exists idx_busca_dupla_torneo_torneo_id
  on public.busca_dupla_torneo (torneo_id);

create table if not exists public.busca_dupla_invitacion (
  id bigint generated always as identity primary key,
  torneo_id bigint not null references public.torneos (id) on delete cascade,
  from_user_id uuid not null,
  to_user_id uuid not null,
  estado text not null default 'pendiente',
  created_at timestamptz not null default now(),
  constraint busca_dupla_invitacion_distinto check (from_user_id <> to_user_id),
  constraint busca_dupla_invitacion_estado_chk check (
    estado in ('pendiente', 'aceptada', 'rechazada', 'cancelada')
  ),
  constraint busca_dupla_invitacion_triple_uniq unique (torneo_id, from_user_id, to_user_id)
);

create index if not exists idx_busca_dupla_inv_torneo
  on public.busca_dupla_invitacion (torneo_id);
create index if not exists idx_busca_dupla_inv_to_pendiente
  on public.busca_dupla_invitacion (to_user_id) where estado = 'pendiente';

alter table public.busca_dupla_torneo enable row level security;
alter table public.busca_dupla_invitacion enable row level security;
revoke all on table public.busca_dupla_torneo from anon, authenticated;
revoke all on table public.busca_dupla_invitacion from anon, authenticated;
