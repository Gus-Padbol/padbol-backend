begin;
-- Next Generation operations are mediated by the scoped backend, never direct browser access.
alter table public.ng_solicitudes_sede enable row level security;
alter table public.ng_sesiones enable row level security;
revoke all on table public.ng_solicitudes_sede, public.ng_sesiones from anon, authenticated;
grant all on table public.ng_solicitudes_sede, public.ng_sesiones to service_role;
commit;
