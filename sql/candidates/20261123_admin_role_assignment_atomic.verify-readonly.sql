-- Catalog-only, never invokes role assignment.
BEGIN READ ONLY;
SET LOCAL statement_timeout='5s';
SELECT p.oid IS NOT NULL AS exists,p.prosecdef,p.proconfig,
 CASE WHEN p.oid IS NOT NULL THEN has_function_privilege('service_role',p.oid,'EXECUTE') END service_execute,
 CASE WHEN p.oid IS NOT NULL THEN has_function_privilege('anon',p.oid,'EXECUTE') END anon_execute,
 CASE WHEN p.oid IS NOT NULL THEN has_function_privilege('authenticated',p.oid,'EXECUTE') END authenticated_execute,md5(pg_get_functiondef(p.oid)) definition_md5
FROM (SELECT to_regprocedure('public.asignar_rol_admin_atomico(uuid,jsonb)') oid)t LEFT JOIN pg_proc p ON p.oid=t.oid;
ROLLBACK;
