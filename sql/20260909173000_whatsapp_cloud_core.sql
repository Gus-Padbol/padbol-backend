-- WhatsApp Cloud API: núcleo local multi-tenant para el primer circuito técnico.
-- No inserta números, credenciales ni activa envíos. Aplicar primero sólo en entorno local.

begin;

create table if not exists public.whatsapp_tenants (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid references public.organizaciones(id) on delete cascade,
  sede_id bigint references public.sedes(id) on delete cascade,
  display_name text not null,
  status text not null default 'inactive',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint whatsapp_tenants_scope_xor_check
    check (num_nonnulls(organization_id, sede_id) = 1),
  constraint whatsapp_tenants_display_name_check
    check (length(trim(display_name)) between 1 and 160),
  constraint whatsapp_tenants_status_check
    check (status in ('inactive', 'active', 'paused'))
);

create unique index if not exists uq_whatsapp_tenants_organization
  on public.whatsapp_tenants (organization_id)
  where organization_id is not null;
create unique index if not exists uq_whatsapp_tenants_sede
  on public.whatsapp_tenants (sede_id)
  where sede_id is not null;

create table if not exists public.whatsapp_tenant_channels (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.whatsapp_tenants(id) on delete cascade,
  meta_phone_number_id text not null,
  meta_waba_id text,
  credential_ref text not null,
  auto_reply_text text not null default
    'Gracias por escribir a Padbol Match. Recibimos tu mensaje y continuaremos por aquí.',
  active boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint whatsapp_tenant_channels_tenant_id_id_unique unique (tenant_id, id),
  constraint whatsapp_tenant_channels_phone_number_id_unique unique (meta_phone_number_id),
  constraint whatsapp_tenant_channels_phone_number_id_check
    check (meta_phone_number_id ~ '^[0-9]{6,32}$'),
  constraint whatsapp_tenant_channels_waba_id_check
    check (meta_waba_id is null or meta_waba_id ~ '^[0-9]{6,32}$'),
  constraint whatsapp_tenant_channels_credential_ref_check
    check (credential_ref ~ '^[A-Z0-9_]{1,40}$'),
  constraint whatsapp_tenant_channels_auto_reply_check
    check (length(trim(auto_reply_text)) between 1 and 4096)
);

create index if not exists idx_whatsapp_tenant_channels_tenant
  on public.whatsapp_tenant_channels (tenant_id, active);

create table if not exists public.whatsapp_inbound_messages (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.whatsapp_tenants(id) on delete cascade,
  channel_id uuid not null,
  provider_message_id text not null,
  from_wa_id text not null,
  message_type text not null,
  text_body text not null,
  received_at timestamptz not null,
  created_at timestamptz not null default now(),
  constraint whatsapp_inbound_messages_channel_fk
    foreign key (tenant_id, channel_id)
    references public.whatsapp_tenant_channels(tenant_id, id)
    on delete cascade,
  constraint whatsapp_inbound_messages_tenant_channel_id_unique
    unique (tenant_id, channel_id, id),
  constraint whatsapp_inbound_messages_provider_unique
    unique (tenant_id, provider_message_id),
  constraint whatsapp_inbound_messages_provider_id_check
    check (length(provider_message_id) between 1 and 512),
  constraint whatsapp_inbound_messages_from_wa_id_check
    check (from_wa_id ~ '^[0-9]{6,20}$'),
  constraint whatsapp_inbound_messages_type_check
    check (message_type = 'text'),
  constraint whatsapp_inbound_messages_text_check
    check (length(text_body) between 1 and 4096)
);

create index if not exists idx_whatsapp_inbound_tenant_received
  on public.whatsapp_inbound_messages (tenant_id, received_at desc);
create index if not exists idx_whatsapp_inbound_tenant_contact
  on public.whatsapp_inbound_messages (tenant_id, from_wa_id, received_at desc);

create table if not exists public.whatsapp_outbox (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.whatsapp_tenants(id) on delete cascade,
  channel_id uuid not null,
  inbound_message_id uuid not null,
  idempotency_key text not null,
  to_wa_id text not null,
  reply_to_provider_message_id text,
  message_type text not null default 'text',
  text_body text not null,
  status text not null default 'pending',
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  last_attempt_at timestamptz,
  customer_service_window_expires_at timestamptz not null,
  provider_message_id text,
  last_error text,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint whatsapp_outbox_channel_fk
    foreign key (tenant_id, channel_id)
    references public.whatsapp_tenant_channels(tenant_id, id)
    on delete cascade,
  constraint whatsapp_outbox_inbound_fk
    foreign key (tenant_id, channel_id, inbound_message_id)
    references public.whatsapp_inbound_messages(tenant_id, channel_id, id)
    on delete cascade,
  constraint whatsapp_outbox_idempotency_unique
    unique (tenant_id, idempotency_key),
  constraint whatsapp_outbox_to_wa_id_check
    check (to_wa_id ~ '^[0-9]{6,20}$'),
  constraint whatsapp_outbox_type_check
    check (message_type = 'text'),
  constraint whatsapp_outbox_text_check
    check (length(text_body) between 1 and 4096),
  constraint whatsapp_outbox_status_check
    check (status in ('pending', 'sending', 'sent', 'expired', 'cancelled')),
  constraint whatsapp_outbox_attempts_check check (attempts >= 0)
);

create index if not exists idx_whatsapp_outbox_pending
  on public.whatsapp_outbox (tenant_id, next_attempt_at, created_at)
  where status = 'pending';

alter table public.whatsapp_tenants enable row level security;
alter table public.whatsapp_tenant_channels enable row level security;
alter table public.whatsapp_inbound_messages enable row level security;
alter table public.whatsapp_outbox enable row level security;

revoke all on table public.whatsapp_tenants from anon, authenticated;
revoke all on table public.whatsapp_tenant_channels from anon, authenticated;
revoke all on table public.whatsapp_inbound_messages from anon, authenticated;
revoke all on table public.whatsapp_outbox from anon, authenticated;

grant all on table public.whatsapp_tenants to service_role;
grant all on table public.whatsapp_tenant_channels to service_role;
grant all on table public.whatsapp_inbound_messages to service_role;
grant all on table public.whatsapp_outbox to service_role;

comment on table public.whatsapp_tenants is
  'Scope aislado del módulo WhatsApp. Vincula exactamente una organización o una sede.';
comment on column public.whatsapp_tenant_channels.credential_ref is
  'Referencia no secreta a una credencial del entorno/secret manager; nunca guarda el access token.';
comment on table public.whatsapp_inbound_messages is
  'Mensajes entrantes mínimos. El tenant se deriva exclusivamente del phone_number_id firmado.';
comment on table public.whatsapp_outbox is
  'Salida transaccional idempotente. Primer hito: sólo respuesta directa dentro de 24 horas.';

commit;
