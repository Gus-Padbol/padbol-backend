begin;
create table public.content_meta_sync_runs (
 account_id text not null check(account_id='1354015098808083'),
 until_day date not null,
 since_day date not null check(until_day=since_day+13),
 status text not null check(status in ('running','succeeded','failed')),
 actor_id uuid not null,
 attempts integer not null default 1 check(attempts>0),
 started_at timestamptz not null default now(),finished_at timestamptz,
 error_code text,
 comparison jsonb,
 primary key(account_id,until_day)
);
create table public.content_meta_monitor_alerts (
 account_id text not null,
 until_day date not null,
 entity_id text not null,
 kind text not null check(kind in ('impressions_drop','link_clicks_drop','cost_per_link_click_increase','coverage_gap')),
 details jsonb not null,
 created_at timestamptz not null default now(),
 primary key(account_id,until_day,entity_id,kind),
 foreign key(account_id,until_day) references public.content_meta_sync_runs(account_id,until_day)
);
create table public.content_meta_sync_events (
 id bigint generated always as identity primary key,
 account_id text not null,until_day date not null,
 event_type text not null check(event_type in ('started','succeeded','failed')),
 details jsonb not null,created_at timestamptz not null default now(),
 foreign key(account_id,until_day) references public.content_meta_sync_runs(account_id,until_day)
);
alter table public.content_meta_sync_events enable row level security;
revoke all on public.content_meta_sync_events from public,anon,authenticated;
grant select,insert on public.content_meta_sync_events to service_role;
grant usage,select on sequence public.content_meta_sync_events_id_seq to service_role;
create trigger content_meta_sync_events_immutable before update or delete on public.content_meta_sync_events for each row execute function public.content_meta_immutable();
alter table public.content_meta_sync_runs enable row level security;
alter table public.content_meta_monitor_alerts enable row level security;
revoke all on public.content_meta_sync_runs,public.content_meta_monitor_alerts from public,anon,authenticated;
grant select,insert,update on public.content_meta_sync_runs to service_role;
grant select,insert on public.content_meta_monitor_alerts to service_role;
create trigger content_meta_monitor_alerts_immutable before update or delete on public.content_meta_monitor_alerts for each row execute function public.content_meta_immutable();
notify pgrst,'reload schema';
commit;
