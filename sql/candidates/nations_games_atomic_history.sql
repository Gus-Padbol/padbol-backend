-- ISOLATED CANDIDATE ONLY. No remote execution; no GRANT or SECURITY DEFINER.
-- Existing scoreboard_commit_mutation keeps the scoreboard lock through history
-- INSERT/DELETE. This trigger records/reverses the game within that transaction.
-- No duration clock field, existing scoring rule or player identity is changed.
ALTER TABLE nations_marker_private.nations_marker_match ADD COLUMN games_ledger jsonb;

CREATE OR REPLACE FUNCTION nations_marker_private.capture_games_history_candidate()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER
SET search_path=pg_catalog,nations_marker_private AS $$
DECLARE h record; sb record; agg record; ledger jsonb; events jsonb; active jsonb;
 old_total integer; new_total integer; delta integer; team record; pair jsonb;
 event jsonb; last_game jsonb; teams jsonb := '{}'::jsonb; old_sets integer;
BEGIN
 IF TG_OP='INSERT' THEN h:=NEW; ELSE h:=OLD; END IF;
 -- Lock order agrees with marker commands: scoreboard then participation.
 SELECT * INTO sb FROM public.scoreboard_partidos WHERE id=h.partido_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'GAME_SCOREBOARD_MISSING'; END IF;
 -- The scoreboard row is already locked above, as it is during START.
 -- Untracked legacy histories need no marker row lock or marker UPDATE privilege.
 IF NOT EXISTS(SELECT 1 FROM nations_marker_private.nations_marker_match WHERE match_id=h.partido_id::text) THEN RETURN h; END IF;
 SELECT * INTO agg FROM nations_marker_private.nations_marker_match WHERE match_id=h.partido_id::text FOR UPDATE;
 IF NOT FOUND THEN RETURN h; END IF; -- Legacy boards, not opted into tracking.
 IF coalesce(to_jsonb(agg)->>'tracking_status','active')<>'active' THEN RAISE EXCEPTION 'GAME_TRACKING_RESTART_REQUIRED'; END IF;
 IF h.games_a_antes IS NULL OR h.games_b_antes IS NULL OR h.historial_sets_antes IS NULL
    OR sb.games_a IS NULL OR sb.games_b IS NULL OR sb.historial_sets IS NULL THEN
   RAISE EXCEPTION 'GAME_SNAPSHOT_MISSING'; END IF;
 IF h.games_a_antes<0 OR h.games_b_antes<0 OR sb.games_a<0 OR sb.games_b<0 OR
   jsonb_typeof(h.historial_sets_antes) IS DISTINCT FROM 'array' OR jsonb_typeof(sb.historial_sets) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'GAME_SNAPSHOT_INVALID'; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(h.historial_sets_antes) WITH ORDINALITY q(e,n) WHERE
   jsonb_typeof(e) IS DISTINCT FROM 'object' OR jsonb_typeof(e->'a') IS DISTINCT FROM 'number' OR jsonb_typeof(e->'b') IS DISTINCT FROM 'number' OR
   (e->>'a')::int<0 OR (e->>'b')::int<0 OR (e->>'set')::int IS DISTINCT FROM n::int) OR
 EXISTS(SELECT 1 FROM jsonb_array_elements(sb.historial_sets) WITH ORDINALITY q(e,n) WHERE
   jsonb_typeof(e) IS DISTINCT FROM 'object' OR jsonb_typeof(e->'a') IS DISTINCT FROM 'number' OR jsonb_typeof(e->'b') IS DISTINCT FROM 'number' OR
   (e->>'a')::int<0 OR (e->>'b')::int<0 OR (e->>'set')::int IS DISTINCT FROM n::int) THEN RAISE EXCEPTION 'GAME_SET_SNAPSHOT_INVALID'; END IF;
 IF jsonb_array_length(sb.historial_sets)<jsonb_array_length(h.historial_sets_antes) OR
    jsonb_array_length(sb.historial_sets)>jsonb_array_length(h.historial_sets_antes)+1 OR
    EXISTS(SELECT 1 FROM jsonb_array_elements(h.historial_sets_antes) WITH ORDINALITY q(e,n) WHERE e IS DISTINCT FROM sb.historial_sets->(n::int-1)) THEN RAISE EXCEPTION 'GAME_SET_HISTORY_CHANGED'; END IF;
 old_total:=h.games_a_antes+h.games_b_antes;
 SELECT old_total+coalesce(sum((v->>'a')::int+(v->>'b')::int),0) INTO old_total FROM jsonb_array_elements(h.historial_sets_antes) v;
 new_total:=sb.games_a+sb.games_b;
 SELECT new_total+coalesce(sum((v->>'a')::int+(v->>'b')::int),0) INTO new_total FROM jsonb_array_elements(sb.historial_sets) v;
 ledger:=agg.games_ledger;
 IF ledger IS NULL THEN
   IF old_total<>0 THEN RAISE EXCEPTION 'GAME_BASELINE_MISSING'; END IF;
   ledger:=jsonb_build_object('version',1,'total',0,'events','[]'::jsonb,'active','[]'::jsonb);
 END IF;
 IF jsonb_typeof(ledger) IS DISTINCT FROM 'object' OR (ledger->>'version')::int IS DISTINCT FROM 1 THEN RAISE EXCEPTION 'GAME_LEDGER_VERSION'; END IF;
 events:=ledger->'events'; active:=ledger->'active';
 IF jsonb_typeof(events) IS DISTINCT FROM 'array' OR jsonb_typeof(active) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'GAME_LEDGER_INVALID'; END IF;
 IF (ledger->>'total')::int IS DISTINCT FROM jsonb_array_length(active) THEN RAISE EXCEPTION 'GAME_LEDGER_TOTAL_INVALID'; END IF;
 IF TG_OP='INSERT' THEN
   IF (ledger->>'total')::int IS DISTINCT FROM old_total THEN RAISE EXCEPTION 'GAME_LEDGER_OUT_OF_SYNC'; END IF;
   delta:=new_total-old_total;
   IF delta=0 THEN RETURN NEW; END IF;
   IF delta<>1 THEN RAISE EXCEPTION 'GAME_LEDGER_GAP'; END IF;
   IF EXISTS(SELECT 1 FROM jsonb_array_elements(events) e WHERE e->>'historyId'=h.id::text AND e->>'type'='game') THEN RAISE EXCEPTION 'GAME_DUPLICATE'; END IF;
   IF jsonb_typeof(agg.states) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_each(agg.states))<>2 THEN RAISE EXCEPTION 'GAME_TEAMS_INVALID'; END IF;
   FOR team IN SELECT * FROM jsonb_each(agg.states) LOOP
     pair:=team.value->'active';
     IF team.value->>'status' IS DISTINCT FROM 'open' OR jsonb_typeof(pair) IS DISTINCT FROM 'array' OR jsonb_array_length(pair)<>2
       OR (SELECT count(DISTINCT p) FROM jsonb_array_elements_text(pair) p)<>2 THEN RAISE EXCEPTION 'GAME_LINEUP_INVALID'; END IF;
     IF jsonb_typeof(team.value->'lineup'->'iniciales') IS DISTINCT FROM 'array' OR jsonb_typeof(team.value->'lineup'->'suplentes') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'GAME_LINEUP_MISSING'; END IF;
     IF EXISTS(SELECT 1 FROM jsonb_array_elements_text(pair) p WHERE NOT
       ((team.value->'lineup'->'iniciales') @> jsonb_build_array(p) OR (team.value->'lineup'->'suplentes') @> jsonb_build_array(p))) THEN RAISE EXCEPTION 'GAME_PLAYER_OUTSIDE_LINEUP'; END IF;
     teams:=teams||jsonb_build_object(team.key,pair);
   END LOOP;
   old_sets:=jsonb_array_length(h.historial_sets_antes);
   event:=jsonb_build_object('type','game','historyId',h.id::text,'set',old_sets+1,
     'number',h.games_a_antes+h.games_b_antes+1,'ordinal',new_total,'teams',teams);
   events:=events||jsonb_build_array(event); active:=active||jsonb_build_array(h.id::text);
 ELSE
   IF (ledger->>'total')::int IS DISTINCT FROM new_total THEN RAISE EXCEPTION 'GAME_LEDGER_OUT_OF_SYNC'; END IF;
   SELECT e INTO event FROM jsonb_array_elements(events) e WHERE e->>'type'='game' AND e->>'historyId'=h.id::text;
   IF event IS NULL THEN
     IF old_total IS DISTINCT FROM new_total THEN RAISE EXCEPTION 'GAME_UNDO_EVENT_MISSING'; END IF;
     RETURN OLD;
   END IF; -- Undo of an ordinary point, only when no game changed.
   IF active->>-1 IS DISTINCT FROM h.id::text OR old_total<>new_total-1 THEN RAISE EXCEPTION 'GAME_UNDO_ORDER_INVALID'; END IF;
   events:=events||jsonb_build_array(jsonb_build_object('type','reversal','historyId',h.id::text));
   active:=active-(jsonb_array_length(active)-1);
 END IF;
 ledger:=jsonb_build_object('version',1,'total',jsonb_array_length(active),'events',events,'active',active);
 UPDATE nations_marker_private.nations_marker_match
 SET games_ledger=ledger,revision=revision+1,updated_at=clock_timestamp()
 WHERE match_id=h.partido_id::text;
 RETURN h;
END $$;
REVOKE ALL ON FUNCTION nations_marker_private.capture_games_history_candidate() FROM PUBLIC;
CREATE TRIGGER nations_games_atomic_history_candidate AFTER INSERT OR DELETE ON public.scoreboard_historial_puntos
FOR EACH ROW EXECUTE FUNCTION nations_marker_private.capture_games_history_candidate();


-- Commit-time invariant prevents unhandled legacy reset/fallback writers from
-- silently leaving a stale ledger. They must be integrated before enabling.
CREATE OR REPLACE FUNCTION nations_marker_private.verify_games_total_candidate()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,nations_marker_private AS $$
DECLARE sb record; ledger jsonb; total integer; tracking text;
BEGIN
 SELECT * INTO sb FROM public.scoreboard_partidos WHERE id=NEW.id;
 SELECT games_ledger,coalesce(to_jsonb(m)->>'tracking_status','active') INTO ledger,tracking FROM nations_marker_private.nations_marker_match m WHERE match_id=NEW.id::text;
 IF NOT FOUND THEN RETURN NULL; END IF;
 IF tracking='reset_pending' AND (sb.estado IS DISTINCT FROM 'pendiente' OR sb.cronometro_inicio IS NOT NULL OR sb.cronometro_pausado IS DISTINCT FROM false OR sb.cronometro_segundos IS DISTINCT FROM 0 OR sb.score_a IS DISTINCT FROM 0 OR sb.score_b IS DISTINCT FROM 0 OR sb.games_a IS DISTINCT FROM 0 OR sb.games_b IS DISTINCT FROM 0 OR sb.sets_a IS DISTINCT FROM 0 OR sb.sets_b IS DISTINCT FROM 0 OR sb.historial_sets IS DISTINCT FROM '[]'::jsonb) THEN RAISE EXCEPTION 'GAME_RESET_PENDING_WRITE'; END IF;
 total:=sb.games_a+sb.games_b;
 SELECT total+coalesce(sum((e->>'a')::int+(e->>'b')::int),0) INTO total FROM jsonb_array_elements(sb.historial_sets) e;
 IF ledger IS NULL AND total=0 THEN RETURN NULL; END IF;
 IF jsonb_typeof(ledger) IS DISTINCT FROM 'object' OR (ledger->>'total')::int IS DISTINCT FROM total THEN
   RAISE EXCEPTION 'GAME_SCORE_LEDGER_MISMATCH';
 END IF;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION nations_marker_private.verify_games_total_candidate() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER nations_games_total_candidate AFTER UPDATE ON public.scoreboard_partidos
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION nations_marker_private.verify_games_total_candidate();
