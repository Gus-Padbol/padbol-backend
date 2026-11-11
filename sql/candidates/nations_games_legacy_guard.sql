-- LOCAL CANDIDATE. Install after nations_games_commands.sql and atomic history.
-- No grants or public RPC replacement. The context is an internal service signal,
-- not authorization: the command caller must already have authorized the actor.
CREATE FUNCTION nations_marker_private.guard_games_legacy_mutation_candidate()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER
SET search_path=pg_catalog,nations_marker_private AS $$
DECLARE board_id uuid; context jsonb; needs_command boolean; old_row jsonb; new_row jsonb;
BEGIN
 IF TG_TABLE_NAME='scoreboard_historial_puntos' THEN
   IF TG_OP='INSERT' THEN board_id:=NEW.partido_id; ELSE board_id:=OLD.partido_id; END IF;
   -- START holds this same row before inserting its aggregate. A previous
   -- application-level lookup saying "untracked" cannot bypass this check.
   PERFORM 1 FROM public.scoreboard_partidos WHERE id=board_id FOR UPDATE;
   needs_command:=true;
 ELSE
   board_id:=NEW.id;
   old_row:=to_jsonb(OLD); new_row:=to_jsonb(NEW);
   -- Tracking pins sporting identity. Even an internal scoring command must
   -- not detach or move the scoreboard while its committed work is recovered.
   IF (OLD.torneo_id IS DISTINCT FROM NEW.torneo_id
       OR OLD.partido_torneo_id IS DISTINCT FROM NEW.partido_torneo_id
       OR OLD.sede_id IS DISTINCT FROM NEW.sede_id)
      AND (EXISTS(SELECT 1 FROM nations_marker_private.nations_marker_match WHERE match_id=OLD.id::text)
           OR EXISTS(SELECT 1 FROM nations_marker_private.games_finalization_intents
                     WHERE scoreboard_id=OLD.id AND status='pending')) THEN
     RAISE EXCEPTION 'GAME_TRACKING_SCOPE_FROZEN' USING ERRCODE='55000';
   END IF;
   SELECT EXISTS(SELECT 1 FROM unnest(ARRAY['score_a','score_b','games_a','games_b',
      'sets_a','sets_b','historial_sets','historial_puntos','es_tiebreak','ultimo_punto']) k
      WHERE old_row->k IS DISTINCT FROM new_row->k) INTO needs_command;
   -- Also reject a zero-score reset, without rejecting pause/resume/start,
   -- ordinary status transitions, token rotation or sync metadata updates.
   needs_command:=needs_command OR (
      NEW.estado='pendiente' AND NEW.cronometro_inicio IS NULL
      AND NEW.cronometro_pausado IS FALSE AND NEW.cronometro_segundos=0
      AND (OLD.estado IS DISTINCT FROM NEW.estado OR OLD.cronometro_inicio IS NOT NULL
           OR OLD.cronometro_pausado IS DISTINCT FROM false
           OR OLD.cronometro_segundos IS DISTINCT FROM 0));
 END IF;
 IF needs_command AND EXISTS(SELECT 1 FROM nations_marker_private.nations_marker_match WHERE match_id=board_id::text) THEN
   context:=nullif(current_setting('padbol.nations_games_command',true),'')::jsonb;
   IF (context->>'scoreboardId'=board_id::text
       AND nullif(context->>'requestId','') IS NOT NULL
       AND context->>'kind' IN('point','undo','reset','tiebreak')
       AND (TG_TABLE_NAME<>'scoreboard_historial_puntos'
            OR TG_OP='INSERT' AND context->>'kind'='point'
            OR TG_OP='DELETE' AND context->>'kind'='undo')) IS DISTINCT FROM true THEN
     RAISE EXCEPTION 'GAME_COMMAND_REQUIRED' USING ERRCODE='55000';
   END IF;
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION nations_marker_private.guard_games_legacy_mutation_candidate() FROM PUBLIC;
CREATE TRIGGER nations_games_legacy_score_guard_candidate BEFORE UPDATE ON public.scoreboard_partidos
FOR EACH ROW EXECUTE FUNCTION nations_marker_private.guard_games_legacy_mutation_candidate();
CREATE TRIGGER nations_games_legacy_history_guard_candidate BEFORE INSERT OR DELETE ON public.scoreboard_historial_puntos
FOR EACH ROW EXECUTE FUNCTION nations_marker_private.guard_games_legacy_mutation_candidate();
