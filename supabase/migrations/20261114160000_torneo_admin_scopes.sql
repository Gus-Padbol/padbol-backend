-- REVIEW ONLY — DO NOT APPLY WITHOUT SECURITY REVIEW + GUS IDENTITY.
-- Scope admin: user + tournament + optional court allowlist. No grant rows here.
create table if not exists public.torneo_admin_scopes (
  user_id uuid not null references auth.users(id) on delete cascade,
  torneo_id bigint not null references public.torneos(id) on delete cascade,
  cancha_ids bigint[] not null default '{}'::bigint[],
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  primary key (user_id, torneo_id)
);

alter table public.torneo_admin_scopes enable row level security;

-- A user may read only their own active scopes. Writes are service-role/admin only.
drop policy if exists torneo_admin_scopes_self_read on public.torneo_admin_scopes;
create policy torneo_admin_scopes_self_read on public.torneo_admin_scopes
  for select using (user_id = auth.uid() and revoked_at is null);

create or replace function public.torneo_admin_scope_check(
  p_user_id uuid,
  p_torneo_id bigint,
  p_cancha_id bigint default null
) returns boolean
language sql stable security definer set search_path = public, auth
as $$
  select exists (
    select 1 from public.torneo_admin_scopes s
    where s.user_id = p_user_id
      and s.torneo_id = p_torneo_id
      and s.revoked_at is null
      and (p_cancha_id is null or cardinality(s.cancha_ids) = 0 or p_cancha_id = any(s.cancha_ids))
  ) or exists (
    select 1 from public.user_roles r
    where r.user_id = p_user_id and r.role = 'super_admin'
  );
$$;

revoke all on function public.torneo_admin_scope_check(uuid, bigint, bigint) from public;
grant execute on function public.torneo_admin_scope_check(uuid, bigint, bigint) to service_role;
