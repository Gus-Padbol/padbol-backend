-- CRM unificado: contactos y conversaciones comunes para WhatsApp y correo.
-- No inserta canales, credenciales ni mensajes reales. Aplicar primero sólo local.
-- Reglas: exclusión de canal por intento (no permanente); agrupación por email/teléfono
-- normalizados; sin fusión por nombre; coincidencias ambiguas quedan para revisión.

begin;

create table if not exists public.crm_contacts (
  id uuid primary key default gen_random_uuid(),
  email_normalized text,
  phone_normalized text,
  nombre text,
  review_needed boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint crm_contacts_email_or_phone_check
    check (email_normalized is not null or phone_normalized is not null),
  constraint crm_contacts_email_check
    check (email_normalized is null or email_normalized ~ '^[^@]+@[^@]+$'),
  constraint crm_contacts_phone_check
    check (phone_normalized is null or phone_normalized ~ '^[0-9]{8,15}$'),
  constraint crm_contacts_nombre_check
    check (nombre is null or length(trim(nombre)) between 1 and 160)
);

create index if not exists idx_crm_contacts_email on public.crm_contacts (email_normalized);
create index if not exists idx_crm_contacts_phone on public.crm_contacts (phone_normalized);

-- Refuerzo de concurrencia: a lo sumo un contacto por email y por teléfono normalizado.
create unique index if not exists uq_crm_contacts_email
  on public.crm_contacts (email_normalized) where email_normalized is not null;
create unique index if not exists uq_crm_contacts_phone
  on public.crm_contacts (phone_normalized) where phone_normalized is not null;

create table if not exists public.crm_conversations (
  id uuid primary key default gen_random_uuid(),
  contact_id uuid not null references public.crm_contacts(id) on delete cascade,
  source_channel text not null,
  source_ref text not null,
  attempt_id text not null,
  identity_used text,
  estado text not null default 'nuevo',
  operador text,
  derivado boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint crm_conversations_channel_check
    check (source_channel in ('whatsapp', 'email')),
  constraint crm_conversations_attempt_ref_unique unique (attempt_id, source_channel, source_ref),
  constraint crm_conversations_source_ref_check
    check (length(source_ref) between 1 and 512),
  constraint crm_conversations_estado_check
    check (estado in ('nuevo', 'en_atencion', 'derivado', 'cerrado'))
);

create index if not exists idx_crm_conversations_contact on public.crm_conversations (contact_id, created_at desc);
create index if not exists idx_crm_conversations_attempt on public.crm_conversations (attempt_id);

create table if not exists public.crm_channel_attempts (
  id uuid primary key default gen_random_uuid(),
  attempt_id text not null unique,
  contact_id uuid references public.crm_contacts(id) on delete cascade,
  channel text not null,
  created_at timestamptz not null default now(),
  constraint crm_channel_attempts_channel_check
    check (channel in ('whatsapp', 'email')),
  constraint crm_channel_attempts_attempt_check
    check (length(attempt_id) between 1 and 256)
);

comment on table public.crm_contacts is
  'Contacto común de CRM. Se agrupa por email/teléfono normalizados; nunca por nombre.';
comment on table public.crm_conversations is
  'Conversación unificada por canal de origen. Conserva trazabilidad de identidad, estado, operador y derivación.';
comment on table public.crm_channel_attempts is
  'Exclusión temporal de canal por intento: dentro del mismo attempt_id sólo vale un canal.';

create table if not exists public.crm_replies (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.crm_conversations(id) on delete cascade,
  body text not null,
  operador text,
  status text not null default 'pending',
  created_at timestamptz not null default now(),
  constraint crm_replies_body_check check (length(trim(body)) between 1 and 4096),
  constraint crm_replies_status_check check (status in ('pending', 'sent', 'cancelled'))
);

create index if not exists idx_crm_replies_conversation on public.crm_replies (conversation_id, created_at desc);

alter table public.crm_contacts enable row level security;
alter table public.crm_conversations enable row level security;
alter table public.crm_channel_attempts enable row level security;
alter table public.crm_replies enable row level security;

revoke all on table public.crm_contacts from anon, authenticated;
revoke all on table public.crm_conversations from anon, authenticated;
revoke all on table public.crm_channel_attempts from anon, authenticated;
revoke all on table public.crm_replies from anon, authenticated;

grant all on table public.crm_contacts to service_role;
grant all on table public.crm_conversations to service_role;
grant all on table public.crm_channel_attempts to service_role;
grant all on table public.crm_replies to service_role;

commit;
