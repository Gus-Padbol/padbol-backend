-- Experimental: validate deployed definition and lock order before applying.
BEGIN;
DO $$ BEGIN
 IF to_regprocedure('public.preparar_marcador_torneo_ahora(bigint,bigint,uuid,bigint)') IS NULL THEN RAISE EXCEPTION 'Expected prepare scoreboard function is missing'; END IF;
 IF to_regprocedure('public.preparar_marcador_antes_ocupacion_candidate(bigint,bigint,uuid,bigint)') IS NOT NULL THEN RAISE EXCEPTION 'Candidate backup function already exists'; END IF;
END $$;
ALTER FUNCTION public.preparar_marcador_torneo_ahora(bigint,bigint,uuid,bigint) RENAME TO preparar_marcador_antes_ocupacion_candidate;
REVOKE ALL ON FUNCTION public.preparar_marcador_antes_ocupacion_candidate(bigint,bigint,uuid,bigint) FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION public.preparar_marcador_torneo_ahora(p_torneo_id bigint,p_partido_id bigint,p_actor_id uuid,p_court_id bigint)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('manual-booking-cross-occupancy-v1',0));
 RETURN public.preparar_marcador_antes_ocupacion_candidate(p_torneo_id,p_partido_id,p_actor_id,p_court_id);
END $$;
REVOKE ALL ON FUNCTION public.preparar_marcador_torneo_ahora(bigint,bigint,uuid,bigint) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.preparar_marcador_torneo_ahora(bigint,bigint,uuid,bigint) TO service_role;
COMMIT;
