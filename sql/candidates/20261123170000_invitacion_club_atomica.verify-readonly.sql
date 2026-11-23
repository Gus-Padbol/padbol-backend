-- Catalog-only check for an explicitly approved activation target.
-- No business rows, RPC execution, DML, DDL, fixture triggers, or role changes.
-- The sibling .verify.sql is a disposable LOCAL test and MUST NOT run remotely.
-- A missing function or any unexpected owner/configuration/privilege blocks activation.
BEGIN READ ONLY;
SET LOCAL statement_timeout = '10s';

WITH target AS (
  SELECT to_regprocedure(
    'public.completar_invitacion_club_atomica(text,text,text,jsonb,jsonb)'
  )::oid AS oid
)
SELECT
  p.oid IS NOT NULL AS function_exists,
  n.nspname AS function_schema,
  p.proname AS function_name,
  pg_get_userbyid(p.proowner) AS function_owner,
  p.prosecdef AS security_definer,
  p.provolatile AS volatility,
  p.proconfig AS configuration,
  pg_get_function_identity_arguments(p.oid) AS identity_arguments,
  pg_get_function_result(p.oid) AS result_type,
  has_function_privilege('service_role', p.oid, 'EXECUTE') AS service_role_execute,
  has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_execute,
  has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated_execute,
  EXISTS (
    SELECT 1
    FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
    WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE'
  ) AS public_execute,
  md5(pg_get_functiondef(p.oid)) AS effective_definition_md5,
  pg_get_functiondef(p.oid) AS effective_definition
FROM target t
LEFT JOIN pg_proc p ON p.oid = t.oid
LEFT JOIN pg_namespace n ON n.oid = p.pronamespace;

ROLLBACK;
