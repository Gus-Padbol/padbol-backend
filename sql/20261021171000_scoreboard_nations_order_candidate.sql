-- Experimental only. Compare deployed definition and dependency OIDs first.
-- This wrapper does not by itself cover direct writers or resuming Nations.
BEGIN;
DO $$ BEGIN
 IF to_regprocedure('public.guardar_plan_nations(bigint,uuid,text,bigint,uuid,text,jsonb)') IS NULL THEN RAISE EXCEPTION 'Expected Nations plan function is missing'; END IF;
 IF to_regprocedure('public.guardar_plan_nations_before_occupancy_candidate(bigint,uuid,text,bigint,uuid,text,jsonb)') IS NOT NULL THEN RAISE EXCEPTION 'Candidate backup function already exists'; END IF;
END $$;
ALTER FUNCTION public.guardar_plan_nations(bigint,uuid,text,bigint,uuid,text,jsonb) RENAME TO guardar_plan_nations_before_occupancy_candidate;
REVOKE ALL ON FUNCTION public.guardar_plan_nations_before_occupancy_candidate(bigint,uuid,text,bigint,uuid,text,jsonb) FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION public.guardar_plan_nations(p_torneo_id bigint,p_actor_id uuid,p_action text,p_revision bigint,p_request_id uuid,p_request_digest text,p_payload jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('manual-booking-cross-occupancy-v1',0));
 RETURN public.guardar_plan_nations_before_occupancy_candidate(p_torneo_id,p_actor_id,p_action,p_revision,p_request_id,p_request_digest,p_payload);
END $$;
REVOKE ALL ON FUNCTION public.guardar_plan_nations(bigint,uuid,text,bigint,uuid,text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.guardar_plan_nations(bigint,uuid,text,bigint,uuid,text,jsonb) TO service_role;
COMMIT;
