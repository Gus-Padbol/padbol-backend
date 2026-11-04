create table if not exists public.crm_space_requests (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null,
  contact_id uuid,
  status text not null default 'recibida' check (status in ('recibida','en_evaluacion','en_preparacion','enviada')),
  length_m numeric not null,
  width_m numeric not null,
  covered boolean not null default false,
  height_m numeric,
  desired_courts integer,
  files jsonb not null default '[]'::jsonb,
  simulation_path text,
  actor text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists crm_space_requests_conversation_idx on public.crm_space_requests(conversation_id, created_at desc);
revoke all on public.crm_space_requests from public, anon, authenticated;
grant select, insert, update on public.crm_space_requests to service_role;
