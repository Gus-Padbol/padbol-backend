-- Manual only; preserves every role/user row. New runtime then fails503.
BEGIN;
DROP FUNCTION IF EXISTS public.asignar_rol_admin_atomico(uuid,jsonb);
NOTIFY pgrst,'reload schema';
COMMIT;
