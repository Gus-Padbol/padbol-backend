CREATE TABLE public.scoreboard_partial_correction_audit (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 scoreboard_id uuid NOT NULL REFERENCES public.scoreboard_partidos(id), actor_id uuid NOT NULL,
 reason text NOT NULL, previous_score jsonb NOT NULL, corrected_score jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE public.scoreboard_partial_correction_audit ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.scoreboard_partial_correction_audit FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.scoreboard_partial_correction_audit TO service_role;
CREATE OR REPLACE FUNCTION public.scoreboard_correct_partial(p_id uuid, p_expected timestamptz, p_actor uuid, p_reason text, p_score jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE current_row public.scoreboard_partidos%ROWTYPE; new_row public.scoreboard_partidos%ROWTYPE; old_score jsonb;
BEGIN
 IF p_actor IS NULL OR p_expected IS NULL OR length(trim(coalesce(p_reason,''))) NOT BETWEEN 1 AND 500 OR jsonb_typeof(p_score) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='Invalid correction'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('manual-booking-cross-occupancy-v1',0));
 SELECT * INTO current_row FROM public.scoreboard_partidos WHERE id=p_id FOR UPDATE;
 IF NOT FOUND OR current_row.updated_at IS DISTINCT FROM p_expected THEN RETURN NULL; END IF;
 IF current_row.estado NOT IN ('pendiente','en_curso') THEN RAISE EXCEPTION USING ERRCODE='55000', MESSAGE='Scoreboard is not editable'; END IF;
 old_score := jsonb_build_object('historial_sets',current_row.historial_sets,'sets_a',current_row.sets_a,'sets_b',current_row.sets_b,'games_a',current_row.games_a,'games_b',current_row.games_b,'score_a',current_row.score_a,'score_b',current_row.score_b,'saque_actual',current_row.saque_actual,'es_tiebreak',current_row.es_tiebreak,'historial_puntos',current_row.historial_puntos,'ultimo_punto',current_row.ultimo_punto);
 new_row := jsonb_populate_record(current_row,p_score);
 UPDATE public.scoreboard_partidos SET historial_sets=new_row.historial_sets, sets_a=new_row.sets_a,sets_b=new_row.sets_b,games_a=new_row.games_a,games_b=new_row.games_b,score_a=new_row.score_a,score_b=new_row.score_b,saque_actual=new_row.saque_actual,es_tiebreak=new_row.es_tiebreak,historial_puntos='[]'::jsonb,ultimo_punto=NULL WHERE id=p_id RETURNING * INTO new_row;
 INSERT INTO public.scoreboard_partial_correction_audit(scoreboard_id,actor_id,reason,previous_score,corrected_score) VALUES(p_id,p_actor,trim(p_reason),old_score,p_score);
 RETURN to_jsonb(new_row)-'control_token_hash'-'control_token_created_at'-'control_token_revoked_at';
END $$;
REVOKE ALL ON FUNCTION public.scoreboard_correct_partial(uuid,timestamptz,uuid,text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.scoreboard_correct_partial(uuid,timestamptz,uuid,text,jsonb) TO service_role;
