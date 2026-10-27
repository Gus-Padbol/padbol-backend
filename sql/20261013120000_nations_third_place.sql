-- Optional third-place match. Existing configured events retain 37 matches. No data backfill.
BEGIN;
CREATE OR REPLACE FUNCTION public.guardar_plan_nations(p_torneo_id bigint,p_actor_id uuid,p_action text,p_revision bigint,p_request_id uuid,p_request_digest text,p_payload jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE t public.torneos; plan jsonb; previous jsonb; row jsonb; match public.partidos; court public.canchas; new_id bigint; round_no integer; pos integer; target bigint; ids bigint[]; start_at timestamptz; minutes integer; new_revision bigint; court_number integer; actor_role public.user_roles; source jsonb; closure jsonb; base_points numeric; percent numeric;
BEGIN
 SELECT * INTO t FROM public.torneos WHERE id=p_torneo_id FOR UPDATE;
 IF t.id IS NULL OR t.modalidad_plantel IS DISTINCT FROM 'selecciones' OR t.deporte IS DISTINCT FROM 'padbol' OR t.tipo_torneo IS DISTINCT FROM 'grupos_knockout' OR p_actor_id IS NULL OR p_request_id IS NULL OR p_revision IS NULL OR p_revision<0 OR p_request_digest IS NULL OR p_request_digest !~ '^[a-f0-9]{64}$' THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Invalid Nations event context'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.user_roles u WHERE u.user_id=p_actor_id AND (u.role='super_admin' OR u.role='admin_club' AND u.sede_id=t.sede_id)) THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Nations admin scope required'; END IF;
 SELECT p.plan INTO plan FROM public.torneo_nations_planes p WHERE p.torneo_id=t.id FOR UPDATE;
 IF t.plan_nations IS NOT NULL AND plan IS NULL THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Private event plan missing'; END IF;
 plan:=coalesce(plan,'{"revision":0,"requests":[]}'::jsonb);
 SELECT r INTO previous FROM jsonb_array_elements(coalesce(plan->'requests','[]'::jsonb)) r WHERE r->>'id'=p_request_id::text;
 IF previous IS NOT NULL THEN
  IF previous->>'digest' IS DISTINCT FROM p_request_digest OR previous->>'actor_id' IS DISTINCT FROM p_actor_id::text THEN RAISE EXCEPTION USING ERRCODE='40001',MESSAGE='Request identity reused with different content'; END IF;
  RETURN jsonb_build_object('ok',true,'status','idempotent','torneo_id',t.id,'revision',(plan->>'revision')::bigint);
 END IF;
 IF (plan->>'revision')::bigint IS DISTINCT FROM p_revision THEN RAISE EXCEPTION USING ERRCODE='40001',MESSAGE='Nations revision changed'; END IF;
 IF coalesce(t.estado,'') NOT IN('planificacion','proximo','inscripcion','abierto','inscripcion_abierta','en_curso') THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Event is frozen'; END IF;
 PERFORM id FROM public.partidos WHERE torneo_id=t.id ORDER BY id FOR UPDATE;
 PERFORM id FROM public.equipos WHERE torneo_id=t.id ORDER BY id FOR UPDATE;
 PERFORM set_config('padbol.nations_rpc','1',true);
 new_revision:=p_revision+1;
 IF p_action='config' THEN
  IF t.sede_id IS NULL OR NOT EXISTS(SELECT 1 FROM public.sedes WHERE id=t.sede_id) OR EXISTS(SELECT 1 FROM public.partidos WHERE torneo_id=t.id) OR p_payload->'config'->>'format' IS DISTINCT FROM 'nations_3x5' OR p_payload->'config'->'rules'->>'placement_policy' IS DISTINCT FROM 'group_seed' OR NOT EXISTS(SELECT 1 FROM pg_timezone_names WHERE name=p_payload->'config'->>'timezone') THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Invalid unfrozen config'; END IF;
  IF jsonb_typeof(p_payload->'config'->'country_by_team') IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_each_text(p_payload->'config'->'country_by_team'))<>(SELECT count(*) FROM public.equipos WHERE torneo_id=t.id) OR EXISTS(SELECT 1 FROM public.equipos WHERE torneo_id=t.id AND p_payload->'config'->'country_by_team'->>id::text IS NULL) OR EXISTS(SELECT 1 FROM jsonb_each_text(p_payload->'config'->'country_by_team') WHERE value !~ '^[A-Z]{2}$') OR (SELECT count(DISTINCT value) FROM jsonb_each_text(p_payload->'config'->'country_by_team'))<>(SELECT count(*) FROM public.equipos WHERE torneo_id=t.id) THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='One unique country per team required'; END IF;
  IF p_payload->'config'->'points_policy_snapshot'->>'model' IS DISTINCT FROM 'percentage_of_base' OR p_payload->'config'->'points_policy_snapshot'->>'version' IS DISTINCT FROM '1' OR p_payload->'config'->'points_policy_snapshot'->>'policy_version' IS NULL OR p_payload->'config'->'points_policy_snapshot'->>'policy_version' !~ '^[a-f0-9]{64}$' OR jsonb_typeof(p_payload->'config'->'points_policy_snapshot'->'config'->'niveles') IS DISTINCT FROM 'object' OR jsonb_typeof(p_payload->'config'->'points_policy_snapshot'->'config'->'posiciones') IS DISTINCT FROM 'object' THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Validated points policy snapshot required'; END IF;
  IF p_payload->'config'->'rules' ? 'third_place_match' AND jsonb_typeof(p_payload->'config'->'rules'->'third_place_match') IS DISTINCT FROM 'boolean' THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Third place option must be boolean'; END IF;
  plan:=plan||jsonb_build_object('config',p_payload->'config','status','configured','rules_approved',NULL);
 ELSIF p_action='aprobar-reglas' THEN
  IF plan->'config' IS NULL OR EXISTS(SELECT 1 FROM public.partidos WHERE torneo_id=t.id) THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Configure rules before approving'; END IF;
  plan:=plan||jsonb_build_object('rules_approved',jsonb_build_object('actor_id',p_actor_id,'approved_at',now(),'version',new_revision,'rules',plan->'config'->'rules','points_policy_version',plan->'config'->'points_policy_snapshot'->>'policy_version'),'status','rules_approved');
 ELSIF p_action='sorteo' THEN
  IF plan->'rules_approved' IS NULL OR plan->'rules_approved'='null'::jsonb OR EXISTS(SELECT 1 FROM public.partidos WHERE torneo_id=t.id) OR jsonb_typeof(p_payload->'groups') IS DISTINCT FROM 'array' OR jsonb_array_length(p_payload->'groups')<>3 OR jsonb_typeof(p_payload->'matches') IS DISTINCT FROM 'array' OR jsonb_array_length(p_payload->'matches')<>30 OR (SELECT count(*) FROM jsonb_each_text(plan->'config'->'country_by_team'))<>15 OR EXISTS(SELECT 1 FROM public.equipos WHERE torneo_id=t.id AND plan->'config'->'country_by_team'->>id::text IS NULL) THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Invalid approved draw'; END IF;
  IF (SELECT count(*) FROM public.equipos WHERE torneo_id=t.id)<>15 OR EXISTS(SELECT 1 FROM public.equipos WHERE torneo_id=t.id AND (inscripcion_estado IS DISTINCT FROM 'confirmado' OR jsonb_array_length(jugadores) NOT BETWEEN 4 AND 8)) THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Fifteen ready selections required'; END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_payload->'groups') g WHERE jsonb_array_length(g->'team_ids')<>5 OR g->>'label' NOT IN('A','B','C')) OR (SELECT count(DISTINCT g->>'label') FROM jsonb_array_elements(p_payload->'groups') g)<>3 OR (SELECT count(DISTINCT v::text) FROM jsonb_array_elements(p_payload->'groups') g CROSS JOIN LATERAL jsonb_array_elements(g->'team_ids') v)<>15 OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_payload->'groups') g CROSS JOIN LATERAL jsonb_array_elements(g->'team_ids') v WHERE NOT EXISTS(SELECT 1 FROM public.equipos WHERE torneo_id=t.id AND id=v::text::bigint)) THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Draw must include all teams once'; END IF;
  FOR row IN SELECT * FROM jsonb_array_elements(p_payload->'matches') LOOP
   IF (row->>'equipo_a_id')::bigint=(row->>'equipo_b_id')::bigint OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p_payload->'groups') g WHERE g->>'label'=row->>'grupo' AND g->'team_ids' @> jsonb_build_array((row->>'equipo_a_id')::bigint,(row->>'equipo_b_id')::bigint)) THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Match outside its group'; END IF;
   INSERT INTO public.partidos(torneo_id,sede_id,equipo_a_id,equipo_b_id,estado,grupo,ronda) VALUES(t.id,t.sede_id,(row->>'equipo_a_id')::bigint,(row->>'equipo_b_id')::bigint,'pendiente',row->>'grupo',1);
  END LOOP;
  IF EXISTS(SELECT 1 FROM public.partidos WHERE torneo_id=t.id GROUP BY grupo,least(equipo_a_id,equipo_b_id),greatest(equipo_a_id,equipo_b_id) HAVING count(*)>1) OR EXISTS(SELECT 1 FROM public.partidos WHERE torneo_id=t.id GROUP BY grupo HAVING count(*)<>10) THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Duplicate or incomplete round robin'; END IF;
  plan:=plan||jsonb_build_object('groups',p_payload->'groups','status','groups');
  UPDATE public.torneos SET estado='en_curso' WHERE id=t.id;
 ELSIF p_action='desempates' THEN
  IF p_payload->'source' IS DISTINCT FROM public.nations_source_snapshot(t.id) OR jsonb_typeof(p_payload->'tie_resolutions') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION USING ERRCODE='40001',MESSAGE='Tie source changed'; END IF;
  plan:=plan||jsonb_build_object('tie_resolutions',p_payload->'tie_resolutions','tie_approval_actor',p_actor_id,'tie_approval_at',now());
 ELSIF p_action='avanzar' THEN
  IF EXISTS(SELECT 1 FROM public.partidos WHERE torneo_id=t.id AND bracket_round IS NOT NULL) OR (SELECT count(*) FROM public.partidos WHERE torneo_id=t.id)<>30 OR EXISTS(SELECT 1 FROM public.partidos WHERE torneo_id=t.id AND estado IS DISTINCT FROM 'finalizado') OR p_payload->'source' IS DISTINCT FROM public.nations_source_snapshot(t.id) THEN RAISE EXCEPTION USING ERRCODE='40001',MESSAGE='Group results changed or bracket already exists'; END IF;
  IF jsonb_array_length(p_payload->'qualified')<>8 OR jsonb_array_length(p_payload->'matches')<>(CASE WHEN plan->'config'->'rules'->'third_place_match'='true'::jsonb THEN 8 ELSE 7 END) OR (SELECT count(DISTINCT (q->>'equipo_id')::bigint) FROM jsonb_array_elements(p_payload->'qualified') q)<>8 THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Eight approved qualifiers required'; END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_payload->'matches') x WHERE x->>'bracket_round' IS NULL OR x->>'bracket_position' IS NULL OR NOT ((x->>'bracket_round')::int=1 AND (x->>'bracket_position')::int BETWEEN 1 AND 4 OR (x->>'bracket_round')::int=2 AND (x->>'bracket_position')::int BETWEEN 1 AND 2 OR (x->>'bracket_round')::int=3 AND (x->>'bracket_position')::int BETWEEN 1 AND CASE WHEN plan->'config'->'rules'->'third_place_match'='true'::jsonb THEN 2 ELSE 1 END) OR (x->>'bracket_round')::int>1 AND (x->>'equipo_a_id' IS NOT NULL OR x->>'equipo_b_id' IS NOT NULL)) OR (SELECT count(DISTINCT (x->>'bracket_round',x->>'bracket_position')) FROM jsonb_array_elements(p_payload->'matches') x)<>jsonb_array_length(p_payload->'matches') THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Invalid approved bracket topology'; END IF;
  FOR row IN SELECT * FROM jsonb_array_elements(p_payload->'matches') LOOP
   INSERT INTO public.partidos(torneo_id,sede_id,equipo_a_id,equipo_b_id,estado,ronda,bracket_round,bracket_position) VALUES(t.id,t.sede_id,(row->>'equipo_a_id')::bigint,(row->>'equipo_b_id')::bigint,'pendiente',(row->>'ronda')::int,(row->>'bracket_round')::int,(row->>'bracket_position')::int);
  END LOOP;
  FOR round_no IN 1..2 LOOP
   FOR match IN SELECT * FROM public.partidos WHERE torneo_id=t.id AND bracket_round=round_no ORDER BY bracket_position LOOP
    SELECT id INTO target FROM public.partidos WHERE torneo_id=t.id AND bracket_round=round_no+1 AND bracket_position=(match.bracket_position+1)/2;
    IF target IS NULL THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Bracket link missing'; END IF;
    UPDATE public.partidos SET partido_siguiente_id=target,partido_siguiente_slot=CASE WHEN match.bracket_position%2=1 THEN 'A' ELSE 'B' END WHERE id=match.id;
   END LOOP;
  END LOOP;
  plan:=plan||jsonb_build_object('standings',p_payload->'standings','thirds',p_payload->'thirds','qualified',p_payload->'qualified','tie_resolutions',p_payload->'tie_resolutions','classification_source',p_payload->'source','classification_approved_by',p_actor_id,'status','knockout');
 ELSIF p_action='programacion' THEN
  IF plan->'groups' IS NULL OR jsonb_typeof(p_payload->'schedule') IS DISTINCT FROM 'array' OR jsonb_array_length(p_payload->'schedule') NOT BETWEEN 1 AND (CASE WHEN plan->'config'->'rules'->'third_place_match'='true'::jsonb THEN 38 ELSE 37 END) THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Draw required for scheduling'; END IF;
  -- Lock every venue court in ID order: competing events/reservations must share these locks.
  PERFORM id FROM public.canchas WHERE sede_id=t.sede_id ORDER BY id FOR UPDATE;
  IF (SELECT count(DISTINCT (x->>'partido_id')::bigint) FROM jsonb_array_elements(p_payload->'schedule') x)<>jsonb_array_length(p_payload->'schedule') THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Duplicate scheduling match'; END IF;
  DELETE FROM public.torneo_nations_programacion WHERE torneo_id=t.id AND partido_id IN(SELECT (x->>'partido_id')::bigint FROM jsonb_array_elements(p_payload->'schedule') x);
  FOR row IN SELECT * FROM jsonb_array_elements(p_payload->'schedule') LOOP
   SELECT * INTO match FROM public.partidos WHERE id=(row->>'partido_id')::bigint AND torneo_id=t.id;
   SELECT * INTO court FROM public.canchas WHERE id=(row->>'court_id')::bigint;
   start_at:=(row->>'fecha_hora')::timestamptz;minutes:=(row->>'duration_minutes')::int;
   court_number:=coalesce(court.orden,(SELECT count(*)::int FROM public.canchas WHERE sede_id=t.sede_id AND id<=court.id));
   IF match.id IS NULL OR match.estado NOT IN('pendiente','programado') OR court.id IS NULL OR court.sede_id IS DISTINCT FROM t.sede_id OR court.deporte IS DISTINCT FROM 'padbol' OR lower(coalesce(court.estado,'')) IN('inactiva','inactivo','cerrada','mantenimiento') OR minutes NOT BETWEEN 1 AND 720 OR start_at IS NULL OR EXISTS(SELECT 1 FROM public.scoreboard_partidos WHERE partido_torneo_id=match.id) THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Invalid court, duration or frozen match'; END IF;
   IF EXISTS(SELECT 1 FROM public.torneo_nations_programacion s JOIN public.partidos m ON m.id=s.partido_id WHERE s.partido_id<>match.id AND m.estado NOT IN('cancelado','suspendido') AND (s.court_id=court.id OR match.equipo_a_id IS NOT NULL AND match.equipo_a_id IN(m.equipo_a_id,m.equipo_b_id) AND m.torneo_id=t.id OR match.equipo_b_id IS NOT NULL AND match.equipo_b_id IN(m.equipo_a_id,m.equipo_b_id) AND m.torneo_id=t.id) AND s.inicio<start_at+(minutes+CASE WHEN s.court_id=court.id THEN 0 ELSE coalesce((plan->'config'->'rules'->>'minimum_rest_minutes')::int,0) END)*interval '1 minute' AND start_at<s.inicio+(s.duration_minutes+CASE WHEN s.court_id=court.id THEN 0 ELSE coalesce((plan->'config'->'rules'->>'minimum_rest_minutes')::int,0) END)*interval '1 minute') THEN RAISE EXCEPTION USING ERRCODE='23P01',MESSAGE='Court or team schedule overlaps'; END IF;
   IF EXISTS(SELECT 1 FROM public.reservas r WHERE (r.sede_id=t.sede_id OR r.sede_id IS NULL AND r.sede=(SELECT nombre FROM public.sedes WHERE id=t.sede_id)) AND r.cancha=court_number AND lower(coalesce(r.estado,'')) NOT IN('cancelada','cancelado') AND r.fecha ~ '^\d{4}-\d{2}-\d{2}$' AND r.hora ~ '^\d{2}:\d{2}' AND ((r.fecha||' '||substring(r.hora,1,5))::timestamp AT TIME ZONE (plan->'config'->>'timezone'))<start_at+minutes*interval '1 minute' AND start_at<((r.fecha||' '||substring(r.hora,1,5))::timestamp AT TIME ZONE (plan->'config'->>'timezone'))+coalesce(r.duracion_minutos,90)*interval '1 minute') THEN RAISE EXCEPTION USING ERRCODE='23P01',MESSAGE='Reservation overlaps'; END IF;
   IF EXISTS(SELECT 1 FROM public.clases c JOIN public.clases_horarios h ON h.clase_id=c.id CROSS JOIN LATERAL generate_series((start_at AT TIME ZONE (plan->'config'->>'timezone'))::date,( (start_at+minutes*interval '1 minute') AT TIME ZONE (plan->'config'->>'timezone'))::date,interval '1 day') d WHERE c.cancha_id=court.id AND c.activo=true AND h.dia_semana=extract(dow FROM d)::int AND ((d::date+h.hora_inicio) AT TIME ZONE (plan->'config'->>'timezone'))<start_at+minutes*interval '1 minute' AND start_at<((d::date+h.hora_fin) AT TIME ZONE (plan->'config'->>'timezone'))) THEN RAISE EXCEPTION USING ERRCODE='23P01',MESSAGE='Class schedule overlaps'; END IF;
   INSERT INTO public.torneo_nations_programacion(partido_id,torneo_id,court_id,inicio,duration_minutes,timezone,actor_id,revision) VALUES(match.id,t.id,court.id,start_at,minutes,plan->'config'->>'timezone',p_actor_id,new_revision) ON CONFLICT(partido_id) DO UPDATE SET court_id=EXCLUDED.court_id,inicio=EXCLUDED.inicio,duration_minutes=EXCLUDED.duration_minutes,actor_id=EXCLUDED.actor_id,revision=EXCLUDED.revision,updated_at=now();
   UPDATE public.partidos SET fecha_hora=start_at AT TIME ZONE 'UTC',cancha_id=court.id,cancha=court_number::text,estado='programado' WHERE id=match.id;
  END LOOP;
  IF EXISTS(SELECT 1 FROM public.partidos p JOIN public.torneo_nations_programacion b ON b.partido_id=p.partido_siguiente_id LEFT JOIN public.torneo_nations_programacion a ON a.partido_id=p.id WHERE p.torneo_id=t.id AND a.partido_id IS NULL) THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Schedule predecessor before its next round'; END IF;
  IF EXISTS(SELECT 1 FROM public.partidos p JOIN public.torneo_nations_programacion a ON a.partido_id=p.id JOIN public.torneo_nations_programacion b ON b.partido_id=p.partido_siguiente_id WHERE p.torneo_id=t.id AND b.inicio<a.inicio+(a.duration_minutes+coalesce((plan->'config'->'rules'->>'minimum_rest_minutes')::int,0))*interval '1 minute') THEN RAISE EXCEPTION USING ERRCODE='23P01',MESSAGE='Next round starts before predecessor ends'; END IF;
  IF plan->'config'->'rules'->'third_place_match'='true'::jsonb AND EXISTS(SELECT 1 FROM public.partidos bronze JOIN public.torneo_nations_programacion b ON b.partido_id=bronze.id JOIN public.partidos semi ON semi.torneo_id=bronze.torneo_id AND semi.bracket_round=2 LEFT JOIN public.torneo_nations_programacion a ON a.partido_id=semi.id WHERE bronze.torneo_id=t.id AND bronze.bracket_round=3 AND bronze.bracket_position=2 AND (a.partido_id IS NULL OR b.inicio<a.inicio+(a.duration_minutes+coalesce((plan->'config'->'rules'->>'minimum_rest_minutes')::int,0))*interval '1 minute')) THEN RAISE EXCEPTION USING ERRCODE='23P01',MESSAGE='Third place requires both scheduled semifinals and rest'; END IF;
 ELSIF p_action='finalizar' THEN
  IF plan->'classification_source' IS DISTINCT FROM (SELECT coalesce(jsonb_agg(x ORDER BY (x->>'id')::bigint),'[]'::jsonb) FROM jsonb_array_elements(public.nations_source_snapshot(t.id)) x WHERE x->>'grupo' IS NOT NULL AND x->'bracket_round'='null'::jsonb) THEN RAISE EXCEPTION USING ERRCODE='40001',MESSAGE='Approved classification source changed'; END IF;
  IF (SELECT count(*) FROM public.partidos WHERE torneo_id=t.id)<>(CASE WHEN plan->'config'->'rules'->'third_place_match'='true'::jsonb THEN 38 ELSE 37 END) OR EXISTS(SELECT 1 FROM public.partidos WHERE torneo_id=t.id AND estado IS DISTINCT FROM 'finalizado') OR p_payload->'source' IS DISTINCT FROM public.nations_source_snapshot(t.id) OR jsonb_array_length(p_payload->'placements')<>15 THEN RAISE EXCEPTION USING ERRCODE='40001',MESSAGE='Final results changed or event incomplete'; END IF;
  base_points:=(plan->'config'->'points_policy_snapshot'->'config'->'niveles'->>t.nivel_torneo)::numeric;
  IF base_points IS NULL THEN SELECT (x->>'puntos')::numeric INTO base_points FROM jsonb_array_elements(plan->'config'->'points_policy_snapshot'->'config'->'tipos_custom') x WHERE x->>'id'=t.nivel_torneo; END IF;
  IF base_points IS NULL OR base_points<0 OR base_points>2147483647 THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Approved points level is invalid'; END IF;
  FOR row IN SELECT * FROM jsonb_array_elements(p_payload->'puntos') LOOP
   percent:=coalesce((plan->'config'->'points_policy_snapshot'->'config'->'posiciones'->>(row->>'posicion'))::numeric,(plan->'config'->'points_policy_snapshot'->'config'->'posiciones'->>'10')::numeric);
   IF percent IS NULL OR percent NOT BETWEEN 0 AND 100 OR (row->>'puntos')::numeric IS DISTINCT FROM round(base_points*percent/100) THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Points differ from approved policy'; END IF;
  END LOOP;
  SELECT public.finalizar_torneo_seleccion(t.id,p_actor_id,p_payload->'puntos') INTO closure;
  IF closure->>'ok' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Internal ledger closure unconfirmed'; END IF;
  plan:=plan||jsonb_build_object('placements',p_payload->'placements','tie_resolutions',p_payload->'tie_resolutions','closure_source',p_payload->'source','status','finalized');
 ELSE RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Unknown Nations action';
 END IF;
 plan:=plan||jsonb_build_object('revision',new_revision,'requests',coalesce(plan->'requests','[]'::jsonb)||jsonb_build_array(jsonb_build_object('id',p_request_id,'digest',p_request_digest,'actor_id',p_actor_id,'action',p_action,'revision',new_revision,'at',now())));
 INSERT INTO public.torneo_nations_planes(torneo_id,plan) VALUES(t.id,plan) ON CONFLICT(torneo_id) DO UPDATE SET plan=EXCLUDED.plan,updated_at=now();
 UPDATE public.torneos SET plan_nations=jsonb_build_object('enabled',true,'format','nations_3x5','revision',new_revision,'status',plan->>'status','config',jsonb_strip_nulls(jsonb_build_object('format','nations_3x5','timezone',plan->'config'->>'timezone','reveal_at',plan->'config'->>'reveal_at'))),updated_at=now() WHERE id=t.id;
 RETURN jsonb_build_object('ok',true,'status','saved','torneo_id',t.id,'revision',new_revision);
END $$;

-- Semifinal results and their losing-team advancement are one transaction.
-- The existing BEFORE guard enforces the actor/storage restrictions and tournament lock.
CREATE OR REPLACE FUNCTION public.avanzar_perdedor_nations() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE plan jsonb; bronze public.partidos; loser bigint; existing bigint;
BEGIN
 IF NEW.bracket_round IS DISTINCT FROM 2 OR NEW.estado IS DISTINCT FROM 'finalizado' THEN RETURN NEW; END IF;
 SELECT p.plan INTO plan FROM public.torneo_nations_planes p WHERE p.torneo_id=NEW.torneo_id;
 IF plan->'config'->'rules'->'third_place_match' IS DISTINCT FROM 'true'::jsonb THEN RETURN NEW; END IF;
 IF NEW.bracket_position NOT IN(1,2) OR NEW.ganador_equipo_id IS NULL OR NEW.equipo_a_id IS NULL OR NEW.equipo_b_id IS NULL OR NEW.ganador_equipo_id NOT IN(NEW.equipo_a_id,NEW.equipo_b_id) THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Invalid semifinal loser'; END IF;
 loser:=CASE WHEN NEW.ganador_equipo_id=NEW.equipo_a_id THEN NEW.equipo_b_id ELSE NEW.equipo_a_id END;
 SELECT * INTO bronze FROM public.partidos WHERE torneo_id=NEW.torneo_id AND bracket_round=3 AND bracket_position=2 FOR UPDATE;
 IF bronze.id IS NULL THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Third place match missing'; END IF;
 existing:=CASE WHEN NEW.bracket_position=1 THEN bronze.equipo_a_id ELSE bronze.equipo_b_id END;
 IF existing=loser THEN RETURN NEW; END IF;
 IF existing IS NOT NULL OR bronze.estado NOT IN('pendiente','programado') OR EXISTS(SELECT 1 FROM public.scoreboard_partidos WHERE partido_torneo_id=bronze.id) THEN RAISE EXCEPTION USING ERRCODE='40001',MESSAGE='Third place slot changed or frozen'; END IF;
 UPDATE public.partidos SET equipo_a_id=CASE WHEN NEW.bracket_position=1 THEN loser ELSE equipo_a_id END,equipo_b_id=CASE WHEN NEW.bracket_position=2 THEN loser ELSE equipo_b_id END WHERE id=bronze.id;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.avanzar_perdedor_nations() FROM PUBLIC,anon,authenticated;
DROP TRIGGER IF EXISTS avanzar_perdedor_nations ON public.partidos;
CREATE TRIGGER avanzar_perdedor_nations AFTER UPDATE OF estado,ganador_equipo_id ON public.partidos FOR EACH ROW EXECUTE FUNCTION public.avanzar_perdedor_nations();

COMMIT;
