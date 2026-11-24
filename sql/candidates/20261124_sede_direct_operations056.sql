-- LOCAL CANDIDATE ONLY. Additive actor/key durable ledger for direct seat alta.
-- No RPC, no scheduler, no business-row backfill; private service-only table.
begin;
create table if not exists public.sede_direct_operations (
  actor_id uuid not null,
  operation_key uuid not null,
  payload_digest text not null,
  canonical_version smallint not null,
  state text not null,
  sede_id bigint references public.sedes(id),
  receipt jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (actor_id, operation_key),
  constraint sede_direct_operations_digest_check check (payload_digest ~ '^[0-9a-f]{64}$'),
  constraint sede_direct_operations_version_check check (canonical_version >= 1),
  constraint sede_direct_operations_state_check check (state in ('prepared','completed','cancelled')),
  constraint sede_direct_operations_state_shape_check check (
    (state = 'completed' and sede_id is not null and receipt is not null)
    or (state = 'prepared' and sede_id is null and receipt is null)
    or (state = 'cancelled' and receipt is null)
  )
);
create index if not exists sede_direct_operations_sede_idx
  on public.sede_direct_operations (sede_id) where sede_id is not null;
alter table public.sede_direct_operations enable row level security;
revoke all on public.sede_direct_operations from public, anon, authenticated;
grant select, insert, update on public.sede_direct_operations to service_role;
notify pgrst, 'reload schema';
commit;
