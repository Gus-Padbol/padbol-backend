create table if not exists public.crm_prospect_territories (
  territory_key text primary key,
  country text not null,
  region text,
  city text,
  protected boolean not null default true,
  reason text not null,
  source text not null,
  updated_by text,
  updated_at timestamptz not null default now()
);
revoke all on public.crm_prospect_territories from public, anon, authenticated;
grant select, insert, update on public.crm_prospect_territories to service_role;
