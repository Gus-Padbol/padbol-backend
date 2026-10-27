-- Private reporting only. No advertising credentials, campaigns, spend or user roles are changed.
begin;
create table public.content_meta_imports (
 id uuid primary key,account_id text not null check(account_id='1354015098808083'),level text not null check(level in ('campaign','adset','ad')),
 sha256 text not null check(sha256 ~ '^[a-f0-9]{64}$'),filename text not null,raw_csv text not null,
 source text not null check(source in ('csv','meta_api')),timezone text not null check(timezone='America/Los_Angeles'),currency text not null check(currency='USD'),
 exported_at text not null,exported_precision text not null check(exported_precision in ('date','timestamp')),partial_day date,coverage text not null default '',from_day date not null,to_day date not null check(to_day>=from_day),
 row_count integer not null check(row_count between 0 and 100000),status text not null default 'preview' check(status in ('preview','committed')),
 created_by uuid not null,created_at timestamptz not null default now(),expires_at timestamptz not null default now()+interval '24 hours',committed_by uuid,committed_at timestamptz,
 unique(account_id,level,sha256)
);
create table public.content_meta_rows (
 import_id uuid not null references public.content_meta_imports(id),day date not null,entity_id text not null,
 campaign_id text not null,campaign_name text not null,adset_id text,adset_name text,ad_id text,entity_name text not null,
 spend numeric(24,8),impressions bigint,clicks bigint,link_clicks bigint,reach_daily bigint,results numeric(24,8),result_indicator text,
 attribution text,actions jsonb not null default '{}',primary key(import_id,day,entity_id)
);
create index content_meta_rows_campaign on public.content_meta_rows(campaign_id,day);
-- One explicitly selected source per account/level/day. Replacing one week preserves other dates.
create table public.content_meta_daily_sources (
 account_id text not null,level text not null,day date not null,import_id uuid not null references public.content_meta_imports(id),
 primary key(account_id,level,day)
);
create table public.content_meta_audit (
 id bigint generated always as identity primary key,import_id uuid not null references public.content_meta_imports(id),actor_id uuid not null,
 action text not null check(action in ('preview','commit')),details jsonb not null,created_at timestamptz not null default now()
);
create function public.content_meta_access(p_actor uuid) returns boolean language sql stable security definer set search_path=pg_catalog,public as $$
 select public.crm_commercial_owner(p_actor,true) or public.content_workspace_coordinator_access(p_actor)
$$;
revoke all on function public.content_meta_access(uuid) from public,anon,authenticated;
grant execute on function public.content_meta_access(uuid) to service_role;
alter table public.content_meta_imports enable row level security;
alter table public.content_meta_rows enable row level security;
alter table public.content_meta_daily_sources enable row level security;
alter table public.content_meta_audit enable row level security;
revoke all on public.content_meta_imports,public.content_meta_rows,public.content_meta_daily_sources,public.content_meta_audit from public,anon,authenticated;
grant select,insert,update on public.content_meta_imports,public.content_meta_daily_sources to service_role;
grant select,insert on public.content_meta_rows,public.content_meta_audit to service_role;
grant usage,select on sequence public.content_meta_audit_id_seq to service_role;
create function public.content_meta_immutable() returns trigger language plpgsql set search_path=pg_catalog,public as $$begin raise exception 'IMMUTABLE';end$$;
create trigger content_meta_rows_immutable before update or delete on public.content_meta_rows for each row execute function public.content_meta_immutable();
create trigger content_meta_audit_immutable before update or delete on public.content_meta_audit for each row execute function public.content_meta_immutable();
create function public.content_meta_preserve_original() returns trigger language plpgsql set search_path=pg_catalog,public as $$begin
 if tg_op='DELETE' then raise exception 'IMMUTABLE';end if;
 if (to_jsonb(new)-'status'-'committed_by'-'committed_at'-'expires_at') is distinct from (to_jsonb(old)-'status'-'committed_by'-'committed_at'-'expires_at') or old.status='committed' then raise exception 'IMMUTABLE';end if;
 return new;
end$$;
create trigger content_meta_preserve_original before update or delete on public.content_meta_imports for each row execute function public.content_meta_preserve_original();
revoke all on function public.content_meta_immutable(),public.content_meta_preserve_original() from public,anon,authenticated;
notify pgrst,'reload schema';
commit;
