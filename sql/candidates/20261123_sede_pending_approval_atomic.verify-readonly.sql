-- Catalog-only. No business rows/RPC invocation, no DDL/DML.
BEGIN READ ONLY;
SET LOCAL statement_timeout='5s';
SELECT p.oid IS NOT NULL AS exists, p.prosecdef AS security_definer, p.proconfig,
 CASE WHEN p.oid IS NOT NULL THEN has_function_privilege('service_role',p.oid,'EXECUTE') END service_execute,
 CASE WHEN p.oid IS NOT NULL THEN has_function_privilege('anon',p.oid,'EXECUTE') END anon_execute,
 CASE WHEN p.oid IS NOT NULL THEN has_function_privilege('authenticated',p.oid,'EXECUTE') END authenticated_execute,
 md5(pg_get_functiondef(p.oid)) definition_md5
FROM (SELECT to_regprocedure('public.aprobar_sede_pendiente_atomica(bigint,uuid,jsonb,jsonb)') oid) t
LEFT JOIN pg_proc p ON p.oid=t.oid;
ROLLBACK;
