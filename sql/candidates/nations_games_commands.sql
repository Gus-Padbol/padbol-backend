-- LOCAL CANDIDATE. Caller authorization must run BEFORE this service-only command.
-- No grants. Not enabled in HTTP routes. Stable request id must survive retries.
ALTER TABLE nations_marker_private.nations_marker_match ADD COLUMN games_epoch integer NOT NULL DEFAULT 0;
ALTER TABLE nations_marker_private.nations_marker_match ADD COLUMN tracking_status text NOT NULL DEFAULT 'active';
CREATE TABLE nations_marker_private.games_reset_archive(match_id text NOT NULL,epoch integer NOT NULL,snapshot jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(match_id,epoch));
REVOKE ALL ON nations_marker_private.games_reset_archive FROM PUBLIC;
CREATE TABLE nations_marker_private.games_command_receipts(
 scoreboard_id uuid NOT NULL, request_id uuid NOT NULL, command jsonb NOT NULL,
 result jsonb NOT NULL, PRIMARY KEY(scoreboard_id,request_id));
REVOKE ALL ON nations_marker_private.games_command_receipts FROM PUBLIC;
-- Recovery intent is committed with the final point. It is not a dispatcher.
-- A verified reconciliation worker must complete it before enabling this candidate.
CREATE TABLE nations_marker_private.games_finalization_intents(
 scoreboard_id uuid NOT NULL, epoch integer NOT NULL, effect_kind text NOT NULL DEFAULT 'tournament_finalization',
 request_id uuid NOT NULL, partido_torneo_id bigint NOT NULL, occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 final_snapshot jsonb NOT NULL, status text NOT NULL DEFAULT 'pending' CHECK(status IN('pending','completed','blocked')),
 attempts integer NOT NULL DEFAULT 0, next_attempt_at timestamptz, last_error text,
 lease_token uuid, lease_until timestamptz,
 PRIMARY KEY(scoreboard_id,epoch,effect_kind));
REVOKE ALL ON nations_marker_private.games_finalization_intents FROM PUBLIC;
CREATE FUNCTION nations_marker_private.commit_games_command_candidate(
 p_id uuid,p_request_id uuid,p_command jsonb,p_expected timestamptz,
 p_next jsonb,p_history jsonb DEFAULT NULL,p_history_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER
SET search_path=pg_catalog,nations_marker_private AS $$
DECLARE sb record; receipt record; agg record; kind text; result jsonb; events jsonb; game_id text;
BEGIN
 IF p_request_id IS NULL OR jsonb_typeof(p_command) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'GAME_COMMAND_INVALID'; END IF;
 kind:=p_command->>'kind';
 IF jsonb_typeof(p_command->'actorId') IS DISTINCT FROM 'string' OR length(trim(p_command->>'actorId'))=0 THEN RAISE EXCEPTION 'GAME_ACTOR_REQUIRED'; END IF;
 IF kind IS NULL OR kind NOT IN('point','undo','reset') THEN RAISE EXCEPTION 'GAME_COMMAND_INVALID'; END IF;
 -- Match existing occupancy wrapper ordering; never acquire this after row locks.
 PERFORM pg_advisory_xact_lock(hashtextextended('manual-booking-cross-occupancy-v1',0));
 SELECT * INTO sb FROM public.scoreboard_partidos WHERE id=p_id FOR UPDATE;
 IF NOT FOUND THEN RETURN NULL; END IF;
 SELECT * INTO agg FROM nations_marker_private.nations_marker_match WHERE match_id=p_id::text FOR UPDATE;
 IF FOUND AND kind='reset' AND agg.tracking_status='reset_pending' THEN
   SELECT * INTO receipt FROM nations_marker_private.games_command_receipts WHERE scoreboard_id=p_id AND request_id=p_request_id;
   IF FOUND AND receipt.command IS NOT DISTINCT FROM p_command AND (p_command->>'epoch')::int+1=agg.games_epoch THEN
     RETURN jsonb_build_object('reconciled',true,'refreshRequired',true,'gamesEpoch',agg.games_epoch,'trackingStatus',agg.tracking_status);
   END IF;
 END IF;
 IF agg.match_id IS NOT NULL THEN
   IF jsonb_typeof(p_command->'epoch') IS DISTINCT FROM 'number' OR (p_command->>'epoch')::int IS DISTINCT FROM agg.games_epoch THEN RAISE EXCEPTION 'GAME_EPOCH_CONFLICT'; END IF;
   IF agg.tracking_status IS DISTINCT FROM 'active' THEN RAISE EXCEPTION 'GAME_TRACKING_RESTART_REQUIRED'; END IF;
 END IF;
 SELECT * INTO receipt FROM nations_marker_private.games_command_receipts WHERE scoreboard_id=p_id AND request_id=p_request_id;
 IF FOUND THEN
   IF receipt.command IS DISTINCT FROM p_command THEN RAISE EXCEPTION 'GAME_REQUEST_KEY_REUSED'; END IF;
   RETURN receipt.result;
 END IF;
 IF sb.updated_at IS DISTINCT FROM p_expected THEN RETURN NULL; END IF;
 SELECT * INTO agg FROM nations_marker_private.nations_marker_match WHERE match_id=p_id::text FOR UPDATE;
 IF kind='reset' AND FOUND THEN
   IF jsonb_typeof(p_next) IS DISTINCT FROM 'object' OR
      p_next->>'estado' IS DISTINCT FROM 'pendiente' OR
      (p_next->>'games_a')::int IS DISTINCT FROM 0 OR (p_next->>'games_b')::int IS DISTINCT FROM 0 OR
      (p_next->>'sets_a')::int IS DISTINCT FROM 0 OR (p_next->>'sets_b')::int IS DISTINCT FROM 0 OR
      (p_next->>'score_a')::int IS DISTINCT FROM 0 OR (p_next->>'score_b')::int IS DISTINCT FROM 0 OR
      p_next->'historial_sets' IS DISTINCT FROM '[]'::jsonb THEN RAISE EXCEPTION 'GAME_RESET_INVALID'; END IF;
   IF p_next->'cronometro_inicio' IS DISTINCT FROM 'null'::jsonb OR
      (p_next->>'cronometro_segundos')::int IS DISTINCT FROM 0 OR
      (p_next->>'cronometro_pausado')::boolean IS DISTINCT FROM false THEN RAISE EXCEPTION 'GAME_RESET_CLOCK_INVALID'; END IF;
   INSERT INTO nations_marker_private.games_reset_archive(match_id,epoch,snapshot) VALUES(p_id::text,agg.games_epoch,to_jsonb(agg));
   UPDATE nations_marker_private.nations_marker_match SET games_epoch=games_epoch+1,tracking_status='reset_pending',revision=revision+1,updated_at=clock_timestamp() WHERE match_id=p_id::text;
   INSERT INTO nations_marker_private.nations_marker_audit(match_id,revision,kind,actor,payload) VALUES(p_id::text,agg.revision+1,'reset',p_command->>'actorId',jsonb_build_object('eventId',p_request_id,'sourceEpoch',agg.games_epoch,'resultEpoch',agg.games_epoch+1));
   -- Reset requires explicit tracking reinitialization; old stints must not survive.
   -- Preserve historical ledger through last-to-first reversals, no destructive purge.
   IF agg.games_ledger IS NOT NULL THEN
     IF jsonb_typeof(agg.games_ledger->'active') IS DISTINCT FROM 'array' OR
        jsonb_typeof(agg.games_ledger->'events') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'GAME_LEDGER_INVALID'; END IF;
     events:=agg.games_ledger->'events';
     FOR game_id IN SELECT value FROM jsonb_array_elements_text(agg.games_ledger->'active') WITH ORDINALITY q(value,n) ORDER BY n DESC LOOP
       events:=events||jsonb_build_array(jsonb_build_object('type','reversal','historyId',game_id));
     END LOOP;
     UPDATE nations_marker_private.nations_marker_match SET games_ledger=jsonb_build_object('version',1,'total',0,'active','[]'::jsonb,'events',events),updated_at=clock_timestamp() WHERE match_id=p_id::text;
   END IF;
 END IF;
 -- Tracked fallback undo has no authoritative snapshot: reject rather than invent.
 IF kind='undo' AND p_history_id IS NULL THEN RAISE EXCEPTION 'GAME_UNDO_HISTORY_REQUIRED'; END IF;
 result:=public.scoreboard_commit_mutation(p_id,p_expected,p_next,CASE WHEN kind='reset' THEN 'update' ELSE kind END,p_history,p_history_id);
 IF result IS NULL THEN RAISE EXCEPTION 'GAME_COMMAND_CONFLICT'; END IF;
 SELECT * INTO agg FROM nations_marker_private.nations_marker_match WHERE match_id=p_id::text;
 IF FOUND THEN result:=result||jsonb_build_object('gamesEpoch',agg.games_epoch,'trackingStatus',agg.tracking_status); END IF;
 IF kind='point' AND coalesce(sb.estado,'') NOT IN('terminado','finalizado')
    AND result->>'estado' IN('terminado','finalizado') AND to_jsonb(sb)->>'partido_torneo_id' IS NOT NULL THEN
   INSERT INTO nations_marker_private.games_finalization_intents(scoreboard_id,epoch,request_id,partido_torneo_id,final_snapshot)
   VALUES(p_id,(p_command->>'epoch')::int,p_request_id,(to_jsonb(sb)->>'partido_torneo_id')::bigint,
     jsonb_build_object('scoreboard_id',p_id,'partido_torneo_id',to_jsonb(sb)->'partido_torneo_id',
       'torneo_id',to_jsonb(sb)->'torneo_id','sede_id',to_jsonb(sb)->'sede_id',
       'estado',result->'estado','sets_a',result->'sets_a','sets_b',result->'sets_b',
       'games_a',result->'games_a','games_b',result->'games_b','score_a',result->'score_a','score_b',result->'score_b',
       'historial_sets',result->'historial_sets'));
 END IF;
 INSERT INTO nations_marker_private.games_command_receipts VALUES(p_id,p_request_id,p_command,result);
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION nations_marker_private.commit_games_command_candidate(uuid,uuid,jsonb,timestamptz,jsonb,jsonb,uuid) FROM PUBLIC;
