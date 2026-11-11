-- Official ranking identities stay independent from auth accounts and point totals.
create table if not exists public.fipa_ranking_operators (
 user_id uuid primary key references auth.users(id) on delete restrict,
 enabled boolean not null default true,
 granted_by uuid references auth.users(id), created_at timestamptz not null default now()
);
create table if not exists public.fipa_ranking_links (
 source_key text primary key check(source_key ~ '^[0-9a-f]{64}$'),
 user_id uuid not null unique references auth.users(id) on delete restrict,
 linked_at timestamptz not null default now()
);
create table if not exists public.fipa_ranking_claim_invites (
 id uuid primary key default gen_random_uuid(), source_key text not null check(source_key ~ '^[0-9a-f]{64}$'),
 token_hash text not null unique, email text not null, player_name text not null,
 verification_note text not null check(length(verification_note) between 10 and 500),
 created_by uuid not null references auth.users(id), created_at timestamptz not null default now(),
 expires_at timestamptz not null, state text not null default 'pending' check(state in ('pending','used','cancelled')),
 used_by uuid references auth.users(id), used_at timestamptz
);
create unique index if not exists fipa_ranking_one_pending on public.fipa_ranking_claim_invites(source_key) where state='pending';
create table if not exists public.fipa_ranking_claim_audit (
 id bigint generated always as identity primary key, source_key text not null,
 action text not null, actor_id uuid not null references auth.users(id),
 invitation_id uuid references public.fipa_ranking_claim_invites(id), created_at timestamptz not null default now()
);
alter table public.fipa_ranking_operators enable row level security;
alter table public.fipa_ranking_links enable row level security;
alter table public.fipa_ranking_claim_invites enable row level security;
alter table public.fipa_ranking_claim_audit enable row level security;
revoke all on public.fipa_ranking_operators,public.fipa_ranking_links,public.fipa_ranking_claim_invites,public.fipa_ranking_claim_audit from public,anon,authenticated;
grant all on public.fipa_ranking_operators,public.fipa_ranking_links,public.fipa_ranking_claim_invites,public.fipa_ranking_claim_audit to service_role;
grant usage,select on sequence public.fipa_ranking_claim_audit_id_seq to service_role;
