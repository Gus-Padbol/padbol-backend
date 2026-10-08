-- CANDIDATE ONLY. Requires the private manual-played-date contract. All feature capabilities remain OFF.
-- One-time transactional installation. Rejects pre-existing duplicates; no cleanup or row selection.
BEGIN;
LOCK TABLE public.scoreboard_partidos IN SHARE ROW EXCLUSIVE MODE;
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM public.scoreboard_partidos
   WHERE partido_torneo_id IS NOT NULL AND coalesce(lower(btrim(estado)),'') NOT IN ('terminado','finalizado')
   GROUP BY partido_torneo_id HAVING count(*)>1) THEN
   RAISE EXCEPTION 'ACTIVE_SCOREBOARD_DUPLICATES_REQUIRE_REVIEW' USING ERRCODE='23505';
 END IF;
END $$;
-- Reuse QA's existing canonical-state index; no redundant unique index is created.
DO $$ BEGIN
 IF NOT EXISTS (
   SELECT 1 FROM pg_catalog.pg_index i
   JOIN pg_catalog.pg_class idx ON idx.oid=i.indexrelid
   JOIN pg_catalog.pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=i.indkey[0]
   WHERE i.indrelid='public.scoreboard_partidos'::regclass
     AND idx.oid=to_regclass('public.idx_scoreboard_partidos_partido_torneo_activo')
     AND i.indisunique AND i.indisvalid AND i.indisready AND i.indimmediate
     AND i.indnkeyatts=1 AND i.indnatts=1 AND a.attname='partido_torneo_id'
     AND i.indexprs IS NULL
     AND pg_get_expr(i.indpred,i.indrelid) =
       '((partido_torneo_id IS NOT NULL) AND (estado <> ALL (ARRAY[''terminado''::text, ''finalizado''::text])))'
 ) THEN RAISE EXCEPTION 'ACTIVE_SCOREBOARD_INDEX_REQUIRES_REVIEW' USING ERRCODE='55000'; END IF;
 IF EXISTS (SELECT 1 FROM public.scoreboard_partidos WHERE partido_torneo_id IS NOT NULL
   AND (estado IS NULL OR estado NOT IN ('pendiente','en_curso','terminado','finalizado'))) THEN
   RAISE EXCEPTION 'SCOREBOARD_STATE_REQUIRES_REVIEW' USING ERRCODE='23514'; END IF;
END $$;

CREATE FUNCTION public.aplicar_efectos_resultado_manual_durable(
 p_partido_id bigint,p_torneo_id bigint,p_actor_id uuid,p_expected_resultado jsonb,p_expected_revision bigint,
 p_destino_hint bigint,p_expected_context jsonb,p_scoreboard_template jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE p public.partidos%ROWTYPE; target public.partidos%ROWTYPE; t public.torneos%ROWTYPE;
 d public.partido_fecha_juego%ROWTYPE; ta public.equipos%ROWTYPE; tb public.equipos%ROWTYPE;
 sb public.scoreboard_partidos%ROWTYPE; template public.scoreboard_partidos%ROWTYPE;
 winner bigint; slot text; occupied bigint; next_a bigint; next_b bigint;
 advance_status text:='skipped'; advance_reason text:='ya_avanzado'; scoreboard_status text:='skipped';
 active_count integer; count_updated integer; advance jsonb; skipped text; row_id bigint;
BEGIN
 IF p_actor_id IS NULL OR p_partido_id IS NULL OR p_torneo_id IS NULL OR p_expected_revision IS NULL
   OR p_expected_revision<1 OR p_expected_resultado IS NULL THEN
   RAISE EXCEPTION 'MANUAL_EFFECTS_INVALID_INPUT' USING ERRCODE='22023'; END IF;
 -- Stable locks cover both semifinals sharing one target. Hint is rechecked after locking.
 FOR row_id IN SELECT id FROM public.partidos WHERE id=p_partido_id OR id=p_destino_hint ORDER BY id FOR UPDATE LOOP NULL; END LOOP;
 SELECT * INTO p FROM public.partidos WHERE id=p_partido_id;
 IF NOT FOUND OR p.torneo_id IS DISTINCT FROM p_torneo_id THEN RAISE EXCEPTION 'MANUAL_EFFECTS_MATCH_MISSING' USING ERRCODE='P0002'; END IF;
 SELECT * INTO t FROM public.torneos WHERE id=p_torneo_id FOR SHARE;
 IF NOT FOUND OR t.sede_id IS NULL OR p.sede_id IS DISTINCT FROM t.sede_id THEN RAISE EXCEPTION 'MANUAL_EFFECTS_SCOPE_MISMATCH' USING ERRCODE='42501'; END IF;
 PERFORM public.autorizar_operador_fecha_juego(p_actor_id,t.sede_id);
 SELECT * INTO d FROM public.partido_fecha_juego WHERE partido_id=p.id FOR SHARE;
 IF NOT FOUND OR d.vigente IS NOT TRUE OR d.revision IS DISTINCT FROM p_expected_revision
   OR d.torneo_id IS DISTINCT FROM t.id OR d.sede_id IS DISTINCT FROM t.sede_id
   OR d.equipo_a_id IS DISTINCT FROM p.equipo_a_id OR d.equipo_b_id IS DISTINCT FROM p.equipo_b_id
   OR d.ganador_equipo_id IS DISTINCT FROM p.ganador_equipo_id
   OR d.resultado_snapshot IS DISTINCT FROM p.resultado
   OR p.estado IS DISTINCT FROM 'finalizado'
   OR public.normalizar_resultado_manual_fecha(p.resultado) IS DISTINCT FROM public.normalizar_resultado_manual_fecha(p_expected_resultado) THEN
   RAISE EXCEPTION 'MANUAL_EFFECTS_SOURCE_CHANGED' USING ERRCODE='40001'; END IF;
 winner:=CASE WHEN (public.normalizar_resultado_manual_fecha(p.resultado)->>'goles_a')::integer=2 THEN p.equipo_a_id ELSE p.equipo_b_id END;
 IF winner IS NULL OR p.ganador_equipo_id IS DISTINCT FROM winner THEN RAISE EXCEPTION 'MANUAL_EFFECTS_WINNER_MISMATCH' USING ERRCODE='22023'; END IF;
 IF coalesce(btrim(p.grupo),'')<>'' THEN skipped:='fase_grupos';
 ELSIF p.partido_siguiente_id IS NULL THEN skipped:='no_destino'; END IF;
 IF skipped IS NOT NULL THEN RETURN jsonb_build_object('ok',true,'partido_id',p.id,'torneo_id',t.id,
   'advance',jsonb_build_object('status','skipped','reason',skipped,'partido_id',p.id),'scoreboard',NULL); END IF;
 IF p.partido_siguiente_id IS DISTINCT FROM p_destino_hint OR p.partido_siguiente_id=p.id THEN
   RAISE EXCEPTION 'MANUAL_EFFECTS_DESTINATION_CHANGED' USING ERRCODE='40001'; END IF;
 SELECT * INTO target FROM public.partidos WHERE id=p.partido_siguiente_id;
 IF NOT FOUND OR target.torneo_id IS DISTINCT FROM p.torneo_id OR target.sede_id IS DISTINCT FROM t.sede_id THEN
   RAISE EXCEPTION 'MANUAL_EFFECTS_DESTINATION_SCOPE' USING ERRCODE='42501'; END IF;
 slot:=upper(btrim(p.partido_siguiente_slot));
 IF (slot IN ('A','B')) IS NOT TRUE THEN RAISE EXCEPTION 'MANUAL_EFFECTS_SLOT_INVALID' USING ERRCODE='22023'; END IF;
 occupied:=CASE WHEN slot='A' THEN target.equipo_a_id ELSE target.equipo_b_id END;
 IF occupied IS NOT NULL AND occupied<>winner THEN RAISE EXCEPTION 'MANUAL_EFFECTS_SLOT_CONFLICT' USING ERRCODE='23514'; END IF;
 -- Never insert a new team into an already started, finalized or cancelled match.
 IF occupied IS NULL AND (target.estado IN ('pendiente','programado')) IS NOT TRUE THEN
   RAISE EXCEPTION 'MANUAL_EFFECTS_DESTINATION_PROTECTED' USING ERRCODE='23514'; END IF;
 next_a:=CASE WHEN slot='A' THEN winner ELSE target.equipo_a_id END;
 next_b:=CASE WHEN slot='B' THEN winner ELSE target.equipo_b_id END;
 IF next_a=next_b THEN RAISE EXCEPTION 'MANUAL_EFFECTS_SAME_TEAM' USING ERRCODE='23514'; END IF;
 IF jsonb_build_object('id',target.id,'torneo_id',target.torneo_id,'sede_id',target.sede_id,'cancha',target.cancha,
   'equipo_a_id',next_a,'equipo_b_id',next_b) IS DISTINCT FROM p_expected_context->'destination' THEN
   RAISE EXCEPTION 'MANUAL_EFFECTS_LAYOUT_CHANGED' USING ERRCODE='40001'; END IF;
 IF occupied IS NULL THEN
   UPDATE public.partidos SET equipo_a_id=next_a,equipo_b_id=next_b,
     estado=CASE WHEN next_a IS NOT NULL AND next_b IS NOT NULL THEN 'pendiente' ELSE estado END
   WHERE id=target.id AND torneo_id=t.id AND estado IN ('pendiente','programado')
     AND (CASE WHEN slot='A' THEN equipo_a_id IS NULL ELSE equipo_b_id IS NULL END);
   GET DIAGNOSTICS count_updated=ROW_COUNT;
   IF count_updated<>1 THEN RAISE EXCEPTION 'MANUAL_EFFECTS_SLOT_CHANGED' USING ERRCODE='40001'; END IF;
   advance_status:='advanced'; advance_reason:='ganador_avanzado';
 END IF;
 advance:=jsonb_build_object('status',advance_status,'reason',advance_reason,'partido_id',p.id,
   'destino_partido_id',target.id,'slot',slot,'ganador_equipo_id',winner);
 IF next_a IS NULL OR next_b IS NULL THEN skipped:='partido_incompleto';
 ELSIF target.estado NOT IN ('pendiente','programado') THEN skipped:='estado_no_apto'; END IF;
 IF skipped IS NOT NULL THEN RETURN jsonb_build_object('ok',true,'partido_id',p.id,'torneo_id',t.id,'advance',advance,
   'scoreboard',jsonb_build_object('status','skipped','reason',skipped,'partido_id',target.id)); END IF;
 -- Validate all persisted inputs used by the existing JS scoreboard builder, under locks.
 FOR row_id IN SELECT id FROM public.equipos WHERE id IN (next_a,next_b) ORDER BY id FOR SHARE LOOP NULL; END LOOP;
 SELECT * INTO ta FROM public.equipos WHERE id=next_a;
 SELECT * INTO tb FROM public.equipos WHERE id=next_b;
 IF ta.id IS NULL OR tb.id IS NULL OR ta.torneo_id IS DISTINCT FROM t.id OR tb.torneo_id IS DISTINCT FROM t.id
   OR (ta.sede_id IS NOT NULL AND ta.sede_id<>t.sede_id) OR (tb.sede_id IS NOT NULL AND tb.sede_id<>t.sede_id) THEN
   RAISE EXCEPTION 'MANUAL_EFFECTS_TEAM_SCOPE' USING ERRCODE='42501'; END IF;
 IF jsonb_build_object('id',t.id,'nombre',t.nombre,'sede_id',t.sede_id) IS DISTINCT FROM p_expected_context->'tournament'
   OR jsonb_build_object('id',ta.id,'nombre',ta.nombre,'jugadores',ta.jugadores) IS DISTINCT FROM p_expected_context->'team_a'
   OR jsonb_build_object('id',tb.id,'nombre',tb.nombre,'jugadores',tb.jugadores) IS DISTINCT FROM p_expected_context->'team_b' THEN
   RAISE EXCEPTION 'MANUAL_EFFECTS_TEMPLATE_INPUT_CHANGED' USING ERRCODE='40001'; END IF;
 IF jsonb_typeof(p_scoreboard_template) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'MANUAL_EFFECTS_TEMPLATE_MISSING' USING ERRCODE='22023'; END IF;
 template:=jsonb_populate_record(NULL::public.scoreboard_partidos,p_scoreboard_template);
 IF template.partido_torneo_id IS DISTINCT FROM target.id OR template.torneo_id IS DISTINCT FROM t.id
   OR template.sede_id IS DISTINCT FROM t.sede_id OR template.estado IS DISTINCT FROM 'pendiente'
   OR template.equipo_a_nombre IS NULL OR template.equipo_b_nombre IS NULL
   OR jsonb_typeof(template.equipo_a_jugadores) IS DISTINCT FROM 'array'
   OR jsonb_typeof(template.equipo_b_jugadores) IS DISTINCT FROM 'array' THEN
   RAISE EXCEPTION 'MANUAL_EFFECTS_TEMPLATE_INVALID' USING ERRCODE='22023'; END IF;
 IF EXISTS (SELECT 1 FROM public.scoreboard_partidos WHERE partido_torneo_id=target.id
   AND (estado IS NULL OR estado NOT IN ('pendiente','en_curso','terminado','finalizado'))) THEN
   RAISE EXCEPTION 'MANUAL_EFFECTS_SCOREBOARD_STATE_REVIEW' USING ERRCODE='23514'; END IF;
 SELECT count(*) INTO active_count FROM public.scoreboard_partidos WHERE partido_torneo_id=target.id
   AND estado NOT IN ('terminado','finalizado');
 IF active_count>1 THEN RAISE EXCEPTION 'MANUAL_EFFECTS_DUPLICATES_REQUIRE_REVIEW' USING ERRCODE='23505'; END IF;
 IF active_count=0 THEN
   INSERT INTO public.scoreboard_partidos(partido_torneo_id,torneo_id,sede_id,torneo_nombre,cancha,
     equipo_a_nombre,equipo_b_nombre,equipo_a_jugadores,equipo_b_jugadores,
     jersey_a1,jersey_a2,jersey_a3,jersey_a4,jersey_b1,jersey_b2,jersey_b3,jersey_b4,saque_actual,color_a,color_b,estado)
   VALUES(target.id,t.id,t.sede_id,template.torneo_nombre,template.cancha,
     template.equipo_a_nombre,template.equipo_b_nombre,template.equipo_a_jugadores,template.equipo_b_jugadores,
     template.jersey_a1,template.jersey_a2,template.jersey_a3,template.jersey_a4,template.jersey_b1,template.jersey_b2,template.jersey_b3,template.jersey_b4,
     'A',template.color_a,template.color_b,'pendiente')
   ON CONFLICT(partido_torneo_id) WHERE partido_torneo_id IS NOT NULL
     AND estado NOT IN ('terminado','finalizado') DO NOTHING
   RETURNING * INTO sb;
   IF FOUND THEN scoreboard_status:='created'; END IF;
 END IF;
 IF sb.id IS NULL THEN
   SELECT * INTO sb FROM public.scoreboard_partidos WHERE partido_torneo_id=target.id
     AND estado NOT IN ('terminado','finalizado') FOR UPDATE;
   IF NOT FOUND THEN RAISE EXCEPTION 'MANUAL_EFFECTS_SCOREBOARD_CHANGED' USING ERRCODE='40001'; END IF;
 END IF;
 IF sb.torneo_id IS DISTINCT FROM t.id OR sb.sede_id IS DISTINCT FROM t.sede_id
   OR sb.equipo_a_nombre IS DISTINCT FROM template.equipo_a_nombre OR sb.equipo_b_nombre IS DISTINCT FROM template.equipo_b_nombre
   OR sb.equipo_a_jugadores IS DISTINCT FROM template.equipo_a_jugadores OR sb.equipo_b_jugadores IS DISTINCT FROM template.equipo_b_jugadores THEN
   RAISE EXCEPTION 'MANUAL_EFFECTS_EXISTING_SCOREBOARD_CONFLICT' USING ERRCODE='23514'; END IF;
 RETURN jsonb_build_object('ok',true,'partido_id',p.id,'torneo_id',t.id,'advance',advance,
   'scoreboard',jsonb_build_object('status',scoreboard_status,'reason',CASE WHEN scoreboard_status='created' THEN 'scoreboard_creado' ELSE 'scoreboard_existente' END,
     'partido_id',target.id,'scoreboard_id',sb.id));
END $$;
REVOKE ALL ON FUNCTION public.aplicar_efectos_resultado_manual_durable(bigint,bigint,uuid,jsonb,bigint,bigint,jsonb,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.aplicar_efectos_resultado_manual_durable(bigint,bigint,uuid,jsonb,bigint,bigint,jsonb,jsonb) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
