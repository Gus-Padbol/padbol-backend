-- Apply a scoreboard mutation and its point-history change under the same row
-- lock. The backend authenticates callers before invoking this service-only RPC.
-- Every writer advances the same version, including roster and sync writers.
CREATE OR REPLACE FUNCTION public.scoreboard_advance_version() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  NEW.updated_at := greatest(clock_timestamp(), coalesce(OLD.updated_at, '-infinity'::timestamptz) + interval '1 microsecond');
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS scoreboard_advance_version ON public.scoreboard_partidos;
CREATE TRIGGER scoreboard_advance_version BEFORE UPDATE ON public.scoreboard_partidos
FOR EACH ROW EXECUTE FUNCTION public.scoreboard_advance_version();
REVOKE ALL ON FUNCTION public.scoreboard_advance_version() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.scoreboard_commit_mutation(
  p_id uuid, p_expected_updated_at timestamptz, p_next jsonb,
  p_kind text, p_history jsonb DEFAULT NULL, p_history_id uuid DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  current_row public.scoreboard_partidos%ROWTYPE;
  next_row public.scoreboard_partidos%ROWTYPE;
  history_row public.scoreboard_historial_puntos%ROWTYPE;
  removed integer;
BEGIN
  IF p_kind IS NULL OR p_kind NOT IN ('point','undo','update') OR jsonb_typeof(p_next) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='Invalid scoreboard mutation';
  END IF;
  SELECT * INTO current_row FROM public.scoreboard_partidos WHERE id=p_id FOR UPDATE;
  IF NOT FOUND OR current_row.updated_at IS DISTINCT FROM p_expected_updated_at THEN RETURN NULL; END IF;
  IF p_kind='point' AND (current_row.estado IS DISTINCT FROM 'en_curso'
    OR current_row.cronometro_inicio IS NULL OR coalesce(current_row.cronometro_pausado,false)) THEN RETURN NULL; END IF;
  IF p_kind='undo' THEN
    IF p_history_id IS NULL THEN RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='Missing point history'; END IF;
    DELETE FROM public.scoreboard_historial_puntos WHERE id=p_history_id AND partido_id=p_id;
    GET DIAGNOSTICS removed = ROW_COUNT;
    IF removed <> 1 THEN RETURN NULL; END IF;
  END IF;
  next_row := jsonb_populate_record(current_row,p_next);
  UPDATE public.scoreboard_partidos SET
    estado=next_row.estado, saque_actual=next_row.saque_actual,
    score_a=next_row.score_a, score_b=next_row.score_b,
    games_a=next_row.games_a, games_b=next_row.games_b,
    sets_a=next_row.sets_a, sets_b=next_row.sets_b,
    historial_sets=next_row.historial_sets, es_tiebreak=next_row.es_tiebreak,
    ultimo_punto=next_row.ultimo_punto, historial_puntos=next_row.historial_puntos,
    cronometro_inicio=next_row.cronometro_inicio, cronometro_pausado=next_row.cronometro_pausado,
    cronometro_segundos=next_row.cronometro_segundos,
    updated_at=greatest(clock_timestamp(),coalesce(current_row.updated_at,'-infinity'::timestamptz)+interval '1 microsecond')
  WHERE id=p_id RETURNING * INTO current_row;
  IF p_kind='point' THEN
    IF p_history IS NULL THEN RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='Missing point history'; END IF;
    history_row := jsonb_populate_record(NULL::public.scoreboard_historial_puntos,p_history);
    INSERT INTO public.scoreboard_historial_puntos
      (partido_id,equipo,score_a_antes,score_b_antes,set_numero,games_a_antes,games_b_antes,
       sets_a_antes,sets_b_antes,es_tiebreak_antes,estado_antes,historial_sets_antes,saque_actual_antes)
    VALUES (p_id,history_row.equipo,history_row.score_a_antes,history_row.score_b_antes,history_row.set_numero,
       history_row.games_a_antes,history_row.games_b_antes,history_row.sets_a_antes,history_row.sets_b_antes,
       history_row.es_tiebreak_antes,history_row.estado_antes,history_row.historial_sets_antes,history_row.saque_actual_antes);
  END IF;
  RETURN to_jsonb(current_row) - 'control_token_hash' - 'control_token_created_at' - 'control_token_revoked_at';
END $$;
REVOKE ALL ON FUNCTION public.scoreboard_commit_mutation(uuid,timestamptz,jsonb,text,jsonb,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.scoreboard_commit_mutation(uuid,timestamptz,jsonb,text,jsonb,uuid) TO service_role;
