-- Manual rollback only. Drops capability, preserves all business rows.
BEGIN;
DROP FUNCTION IF EXISTS public.aprobar_sede_pendiente_atomica(bigint,uuid,jsonb,jsonb);
NOTIFY pgrst,'reload schema';
COMMIT;
