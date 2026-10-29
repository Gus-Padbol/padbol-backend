create table if not exists public.fipa_ranking_requests (
 id uuid primary key default gen_random_uuid(),
 source_key text not null check(source_key ~ '^[0-9a-f]{64}$'),
 user_id uuid not null references auth.users(id), email text not null,
 state text not null default 'pending' check(state in ('pending','approved','rejected')),
 created_at timestamptz not null default now(), reviewed_at timestamptz,
 reviewed_by uuid references auth.users(id), review_note text,
 unique(source_key,user_id)
);
alter table public.fipa_ranking_requests enable row level security;
revoke all on public.fipa_ranking_requests from public,anon,authenticated;
grant all on public.fipa_ranking_requests to service_role;
alter table public.fipa_ranking_claim_audit add column if not exists request_id uuid references public.fipa_ranking_requests(id);
