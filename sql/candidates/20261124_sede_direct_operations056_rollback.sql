-- Manual rollback only. Preserves operation history and all business rows.
-- New keyed writes must be disabled by the application (typed 503) while the
-- completed lookup/receipt remains readable; never DROP the ledger or DELETE sedes.
begin;
revoke insert, update on public.sede_direct_operations from service_role;
grant select on public.sede_direct_operations to service_role;
notify pgrst, 'reload schema';
commit;
