-- Soporte humano: tickets abiertos por jugadores o administradores de sede.
create table if not exists support_tickets (
  id bigserial primary key,
  public_id uuid not null default gen_random_uuid() unique,
  requester_user_id uuid not null,
  requester_email text,
  requester_role text not null default 'jugador' check (requester_role in ('jugador','sede')),
  sede_id bigint references sedes(id) on delete set null,
  categoria text not null check (categoria in ('reservas','pagos','torneos','cuenta','configuracion','tecnico','otro')),
  asunto text not null check (char_length(asunto) between 4 and 160),
  estado text not null default 'abierto' check (estado in ('abierto','en_revision','esperando_usuario','resuelto','cerrado')),
  prioridad text not null default 'normal' check (prioridad in ('baja','normal','alta','urgente')),
  assigned_to uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  closed_at timestamptz
);

create table if not exists support_ticket_messages (
  id bigserial primary key,
  ticket_id bigint not null references support_tickets(id) on delete cascade,
  author_user_id uuid not null,
  author_role text not null check (author_role in ('jugador','sede','soporte')),
  body text not null check (char_length(body) between 1 and 5000),
  internal boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists support_tickets_requester_idx on support_tickets(requester_user_id, updated_at desc);
create index if not exists support_tickets_queue_idx on support_tickets(estado, prioridad, updated_at desc);
create index if not exists support_ticket_messages_ticket_idx on support_ticket_messages(ticket_id, created_at);
