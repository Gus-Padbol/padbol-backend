-- Origen y contenido mínimo de consultas entrantes para la bandeja unificada.
-- No configura proveedores ni habilita envíos.
begin;

alter table public.crm_conversations
  add column if not exists origin text,
  add column if not exists subject text,
  add column if not exists inbound_body text,
  add column if not exists received_at timestamptz;

update public.crm_conversations
set origin = coalesce(origin, source_channel),
    received_at = coalesce(received_at, created_at)
where origin is null or received_at is null;

alter table public.crm_conversations
  alter column origin set not null,
  alter column received_at set not null;

alter table public.crm_conversations
  add constraint crm_conversations_origin_check
    check (length(trim(origin)) between 1 and 120),
  add constraint crm_conversations_subject_check
    check (subject is null or length(subject) between 1 and 512),
  add constraint crm_conversations_inbound_body_check
    check (inbound_body is null or length(inbound_body) between 1 and 4000);

create index if not exists idx_crm_conversations_origin_received
  on public.crm_conversations (origin, received_at desc);

commit;
