-- Additive preparation only. Does not enable any tenant, operator or sender.
begin;

alter table public.whatsapp_tenants
  add column if not exists inbox_enabled boolean not null default false;
comment on column public.whatsapp_tenants.inbox_enabled is
  'Explicit history capability, default OFF. Does not activate messaging or grant a role.';

create table if not exists public.whatsapp_history_access_audit (
  id uuid primary key default gen_random_uuid(),
  actor_user_id uuid not null,
  tenant_id uuid,
  resource_id uuid,
  action text not null check (action in ('list_tenants', 'list_history', 'read_exchange')),
  occurred_at timestamptz not null default clock_timestamp(),
  constraint whatsapp_history_audit_resource_check check (
    (action = 'list_tenants' and tenant_id is null and resource_id is null)
    or (action = 'list_history' and tenant_id is not null and resource_id is not null and resource_id = tenant_id)
    or (action = 'read_exchange' and tenant_id is not null and resource_id is not null)
  )
);
create index if not exists whatsapp_history_audit_tenant_time_idx
  on public.whatsapp_history_access_audit(tenant_id, occurred_at desc);

create or replace function public.whatsapp_history_audit_server_time()
returns trigger language plpgsql set search_path = pg_catalog as $$
begin
  new.occurred_at := clock_timestamp();
  return new;
end;
$$;
drop trigger if exists whatsapp_history_audit_server_time on public.whatsapp_history_access_audit;
create trigger whatsapp_history_audit_server_time before insert
  on public.whatsapp_history_access_audit for each row
  execute function public.whatsapp_history_audit_server_time();

alter table public.whatsapp_history_access_audit enable row level security;
revoke all on public.whatsapp_history_access_audit from public, anon, authenticated, service_role;
grant select, insert on public.whatsapp_history_access_audit to service_role;
revoke all on function public.whatsapp_history_audit_server_time() from public, anon, authenticated;
comment on table public.whatsapp_history_access_audit is
  'Minimal authorized history access: actor/resource/action/server time only; no body, phone, IP, token or payload. Operational retention and authorized operator must be configured before real-data activation.';

create index if not exists whatsapp_inbound_history_cursor_idx
  on public.whatsapp_inbound_messages(tenant_id, received_at desc, id desc);
create index if not exists whatsapp_outbox_exchange_history_idx
  on public.whatsapp_outbox(tenant_id, channel_id, inbound_message_id, created_at, id);
commit;
