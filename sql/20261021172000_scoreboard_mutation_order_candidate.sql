-- Experimental only. Compare production definition, privileges and dependencies before applying.
BEGIN;
DO $$ BEGIN
 IF to_regprocedure('public.scoreboard_commit_mutation(uuid,timestamp with time zone,jsonb,text,jsonb,uuid)') IS NULL THEN RAISE EXCEPTION 'Expected scoreboard mutation function is missing'; END IF;
 IF to_regprocedure('public.scoreboard_commit_mutation_before_occupancy_candidate(uuid,timestamp with time zone,jsonb,text,jsonb,uuid)') IS NOT NULL THEN RAISE EXCEPTION 'Candidate backup function already exists'; END IF;
END $$;
ALTER FUNCTION public.scoreboard_commit_mutation(uuid,timestamptz,jsonb,text,jsonb,uuid) RENAME TO scoreboard_commit_mutation_before_occupancy_candidate;
REVOKE ALL ON FUNCTION public.scoreboard_commit_mutation_before_occupancy_candidate(uuid,timestamptz,jsonb,text,jsonb,uuid) FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION public.scoreboard_commit_mutation(p_id uuid,p_expected_updated_at timestamptz,p_next jsonb,p_kind text,p_history jsonb DEFAULT NULL::jsonb,p_history_id uuid DEFAULT NULL::uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 -- Ordinary points on version-matched standalone boards need no global
 -- occupancy lock. Tournament board triggers lock tournament and match rows,
 -- so linked boards must retain the shared lock even for an ordinary point.
 IF NOT (p_kind='point' AND (NOT (p_next ? 'estado') OR p_next->>'estado'='en_curso')
   AND EXISTS (SELECT 1 FROM public.scoreboard_partidos WHERE id=p_id
     AND updated_at=p_expected_updated_at AND torneo_id IS NULL AND partido_torneo_id IS NULL)) IS TRUE THEN
  PERFORM pg_advisory_xact_lock(hashtextextended('manual-booking-cross-occupancy-v1',0));
 END IF;
 RETURN public.scoreboard_commit_mutation_before_occupancy_candidate(p_id,p_expected_updated_at,p_next,p_kind,p_history,p_history_id);
END $$;
REVOKE ALL ON FUNCTION public.scoreboard_commit_mutation(uuid,timestamptz,jsonb,text,jsonb,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.scoreboard_commit_mutation(uuid,timestamptz,jsonb,text,jsonb,uuid) TO service_role;
COMMIT;
