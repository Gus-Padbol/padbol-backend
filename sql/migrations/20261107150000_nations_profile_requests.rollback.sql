-- Rollback conservador: si hay solicitudes, NO borra datos; aborta y pide exportarlas.
BEGIN;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.nations_profile_requests) THEN
    RAISE EXCEPTION 'Hay solicitudes de perfil: exportalas antes de revertir esta migracion';
  END IF;
END $$;
DROP POLICY IF EXISTS nations_profile_requests_own_select ON public.nations_profile_requests;
DROP INDEX IF EXISTS public.nations_profile_requests_torneo_idx;
DROP TABLE IF EXISTS public.nations_profile_requests;
COMMIT;
