-- Dependencia explícita: requiere sql/migrations/20261026010000_content_workspace.sql
-- (content_workspace_items, content_workspace_files y bucket privado content-workspace-private).
-- Candidato local. NO crea buckets, NO migra filas y NO elimina datos.
begin;

-- Fail closed if the previous per-PP-entry shape exists. Never silently keep
-- wrong columns or drop real rows.
do $guard$
declare cols text[];
begin
  if to_regclass('public.content_library_entries') is not null then
    select array_agg(attname) into cols
      from pg_attribute
      where attrelid='public.content_library_entries'::regclass
        and attnum>0 and not attisdropped;
    if 'sede_id'=any(cols) or not ('enabled'=any(cols)) then
      raise exception 'CONTENT_LIBRARY_SCHEMA_OLD_SHAPE: manual reviewed migration required';
    end if;
  end if;
end $guard$;

create table if not exists public.content_library_categories (
  sede_id bigint not null references public.sedes(id),
  category_key text not null check (category_key ~ '^[a-z0-9][a-z0-9_-]{1,63}$'),
  enabled boolean not null default false,
  updated_by uuid not null,
  updated_at timestamptz not null default now(),
  primary key (sede_id, category_key)
);
alter table public.content_library_categories enable row level security;
revoke all on public.content_library_categories from public,anon,authenticated;
grant select,insert,update on public.content_library_categories to service_role;

create table if not exists public.content_library_entries (
  id uuid primary key default gen_random_uuid(),
  category_key text not null check (category_key ~ '^[a-z0-9][a-z0-9_-]{1,63}$'),
  item_id uuid not null references public.content_workspace_items(id),
  file_id uuid not null references public.content_workspace_files(id),
  source_version bigint not null check (source_version > 0),
  enabled boolean not null default true,
  published_by uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (item_id, file_id)
);
alter table public.content_library_entries enable row level security;
revoke all on public.content_library_entries from public,anon,authenticated;
grant select,insert,update on public.content_library_entries to service_role;
create index if not exists content_library_entries_category_idx
  on public.content_library_entries(category_key, updated_at desc) where enabled;

commit;
