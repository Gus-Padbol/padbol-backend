-- Experimental only: compare the exact deployed function and dependencies
-- before applying. This covers one RPC, not direct writers or Nations.
BEGIN;
DO $$
BEGIN
 IF to_regprocedure('public.programar_partido_torneo(bigint,bigint,uuid,bigint,timestamp with time zone,integer)') IS NULL THEN
  RAISE EXCEPTION 'Expected tournament scheduling function is missing';
 END IF;
 IF to_regprocedure('public.programar_partido_torneo_before_occupancy_candidate(bigint,bigint,uuid,bigint,timestamp with time zone,integer)') IS NOT NULL THEN
  RAISE EXCEPTION 'Candidate backup function already exists';
 END IF;
END $$;
ALTER FUNCTION public.programar_partido_torneo(bigint,bigint,uuid,bigint,timestamptz,integer)
 RENAME TO programar_partido_torneo_before_occupancy_candidate;
REVOKE ALL ON FUNCTION public.programar_partido_torneo_before_occupancy_candidate(bigint,bigint,uuid,bigint,timestamptz,integer)
 FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION public.programar_partido_torneo(p_torneo_id bigint,p_partido_id bigint,p_actor_id uuid,p_court_id bigint,p_inicio timestamptz,p_duration integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('manual-booking-cross-occupancy-v1',0));
 RETURN public.programar_partido_torneo_before_occupancy_candidate(p_torneo_id,p_partido_id,p_actor_id,p_court_id,p_inicio,p_duration);
END $$;
REVOKE ALL ON FUNCTION public.programar_partido_torneo(bigint,bigint,uuid,bigint,timestamptz,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.programar_partido_torneo(bigint,bigint,uuid,bigint,timestamptz,integer) TO service_role;
COMMIT;
