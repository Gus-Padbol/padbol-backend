-- Experimental: compare deployed function, permissions and dependencies first.
BEGIN;
DO $$ BEGIN
 IF to_regprocedure('public.finalizar_partido_seleccion(bigint,jsonb,uuid,text)') IS NULL THEN RAISE EXCEPTION 'Expected finalization function missing'; END IF;
 IF to_regprocedure('public.finalizar_partido_antes_ocupacion_candidate(bigint,jsonb,uuid,text)') IS NOT NULL THEN RAISE EXCEPTION 'Candidate backup function already exists'; END IF;
END $$;
ALTER FUNCTION public.finalizar_partido_seleccion(bigint,jsonb,uuid,text) RENAME TO finalizar_partido_antes_ocupacion_candidate;
REVOKE ALL ON FUNCTION public.finalizar_partido_antes_ocupacion_candidate(bigint,jsonb,uuid,text) FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION public.finalizar_partido_seleccion(p_partido_id bigint,p_resultado jsonb,p_actor_id uuid,p_fuente text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('manual-booking-cross-occupancy-v1',0));
 RETURN public.finalizar_partido_antes_ocupacion_candidate(p_partido_id,p_resultado,p_actor_id,p_fuente);
END $$;
REVOKE ALL ON FUNCTION public.finalizar_partido_seleccion(bigint,jsonb,uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.finalizar_partido_seleccion(bigint,jsonb,uuid,text) TO service_role;
COMMIT;
