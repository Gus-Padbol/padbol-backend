-- Additive only; no backfill, no registration, no outbound/provider changes.
BEGIN;
ALTER TABLE public.torneos ADD COLUMN IF NOT EXISTS plan_nations jsonb;
CREATE TABLE IF NOT EXISTS public.torneo_nations_planes (
 torneo_id bigint PRIMARY KEY REFERENCES public.torneos(id),
 plan jsonb NOT NULL CHECK(jsonb_typeof(plan)='object'),
 updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.torneo_nations_planes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.torneo_nations_planes FROM anon,authenticated;
GRANT SELECT,INSERT,UPDATE ON public.torneo_nations_planes TO service_role;
-- No data backfill: a prior public full plan must be reviewed rather than silently copied.
DO $$ BEGIN IF EXISTS(SELECT 1 FROM public.torneos WHERE plan_nations ? 'requests' OR plan_nations ? 'groups') THEN RAISE EXCEPTION 'Existing full public Nations plan requires a reviewed migration'; END IF; END $$;
CREATE TABLE IF NOT EXISTS public.torneo_nations_programacion (
 partido_id bigint PRIMARY KEY REFERENCES public.partidos(id),
 torneo_id bigint NOT NULL REFERENCES public.torneos(id),
 court_id bigint NOT NULL REFERENCES public.canchas(id),
 inicio timestamptz NOT NULL,
 duration_minutes integer NOT NULL CHECK(duration_minutes BETWEEN 1 AND 720),
 timezone text NOT NULL,
 actor_id uuid NOT NULL,
 revision bigint NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.torneo_nations_programacion ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.torneo_nations_programacion FROM anon,authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON public.torneo_nations_programacion TO service_role;
CREATE INDEX IF NOT EXISTS nations_schedule_court_time ON public.torneo_nations_programacion(court_id,inicio);
CREATE OR REPLACE FUNCTION public.leer_estado_nations(p_torneo_id bigint) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT jsonb_build_object('torneo',to_jsonb(t)||jsonb_build_object('plan_nations',coalesce(p.plan,t.plan_nations)),
 'teams',coalesce((SELECT jsonb_agg(to_jsonb(e) ORDER BY e.id) FROM public.equipos e WHERE e.torneo_id=t.id),'[]'::jsonb),
 'matches',coalesce((SELECT jsonb_agg(to_jsonb(m) ORDER BY m.id) FROM public.partidos m WHERE m.torneo_id=t.id),'[]'::jsonb),
 'schedule',coalesce((SELECT jsonb_agg(jsonb_build_object('partido_id',s.partido_id,'inicio',s.inicio,'court_id',s.court_id,'duration_minutes',s.duration_minutes) ORDER BY s.partido_id) FROM public.torneo_nations_programacion s WHERE s.torneo_id=t.id),'[]'::jsonb),
 'courts',coalesce((SELECT jsonb_agg(jsonb_build_object('id',c.id,'nombre',c.nombre,'sede_id',c.sede_id,'deporte',c.deporte,'estado',c.estado) ORDER BY c.id) FROM public.canchas c WHERE c.sede_id=t.sede_id),'[]'::jsonb))
 FROM public.torneos t LEFT JOIN public.torneo_nations_planes p ON p.torneo_id=t.id WHERE t.id=p_torneo_id AND (t.plan_nations IS NULL OR p.plan IS NOT NULL)
$$;
REVOKE ALL ON FUNCTION public.leer_estado_nations(bigint) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.leer_estado_nations(bigint) TO service_role;
CREATE OR REPLACE FUNCTION public.nations_source_snapshot(p_torneo_id bigint) RETURNS jsonb LANGUAGE sql STABLE SET search_path=public,pg_temp AS $$
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'equipo_a_id',equipo_a_id,'equipo_b_id',equipo_b_id,'grupo',grupo,'bracket_round',bracket_round,'bracket_position',bracket_position,'estado',estado,'resultado',resultado,'ganador_equipo_id',ganador_equipo_id,'partido_siguiente_id',partido_siguiente_id,'partido_siguiente_slot',partido_siguiente_slot) ORDER BY id),'[]'::jsonb) FROM public.partidos WHERE torneo_id=p_torneo_id
$$;
REVOKE ALL ON FUNCTION public.nations_source_snapshot(bigint) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.nations_source_snapshot(bigint) TO service_role;
CREATE OR REPLACE FUNCTION public.proteger_plan_nations() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE t public.torneos; sets jsonb; sa integer; sb integer; detail jsonb; a integer; b integer;
BEGIN
 IF TG_TABLE_NAME='torneos' THEN
  IF TG_OP='UPDATE' AND OLD.plan_nations IS NOT NULL AND current_user NOT IN('service_role','postgres','supabase_admin') THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Use scoped Nations event API'; END IF;
  IF TG_OP='UPDATE' AND OLD.plan_nations IS DISTINCT FROM NEW.plan_nations OR TG_OP='INSERT' AND NEW.plan_nations IS NOT NULL THEN
   IF current_user NOT IN('service_role','postgres','supabase_admin') OR current_setting('padbol.nations_rpc',true) IS DISTINCT FROM '1' THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Use Nations event API'; END IF;
  END IF;
  IF TG_OP='UPDATE' AND OLD.plan_nations->>'status' IN('groups','knockout','finalized') AND NEW.estado NOT IN('en_curso','cancelado','suspendido','finalizado') THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Nations registration is frozen after the draw'; END IF;
  IF TG_OP='UPDATE' AND OLD.plan_nations IS NOT NULL AND (OLD.tipo_torneo IS DISTINCT FROM NEW.tipo_torneo OR OLD.modalidad_plantel IS DISTINCT FROM NEW.modalidad_plantel OR OLD.deporte IS DISTINCT FROM NEW.deporte OR OLD.sede_id IS DISTINCT FROM NEW.sede_id OR (NEW.estado='finalizado' AND OLD.estado IS DISTINCT FROM NEW.estado)) AND current_setting('padbol.nations_rpc',true) IS DISTINCT FROM '1' THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Nations structure is event-managed'; END IF;
 ELSE
  SELECT * INTO t FROM public.torneos WHERE id=CASE WHEN TG_OP='DELETE' THEN OLD.torneo_id ELSE NEW.torneo_id END FOR UPDATE;
  IF t.plan_nations IS NOT NULL THEN
   IF current_user NOT IN('service_role','postgres','supabase_admin') THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Use Nations event API'; END IF;
   IF TG_OP<>'DELETE' AND NEW.estado='finalizado' THEN
    sets:=NEW.resultado->'historial_sets';
    IF jsonb_typeof(sets) IS DISTINCT FROM 'array' OR jsonb_array_length(sets) NOT IN(2,3) THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Nations requires completed set game details'; END IF;
    sa:=0;sb:=0;FOR detail IN SELECT * FROM jsonb_array_elements(sets) LOOP
     a:=(detail->>'a')::int;b:=(detail->>'b')::int;
     IF a IS NULL OR b IS NULL OR a<0 OR b<0 OR a=b OR sa=2 OR sb=2 THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Invalid Nations set details'; END IF;
     IF a>b THEN sa:=sa+1; ELSE sb:=sb+1; END IF;
    END LOOP;
    IF greatest(sa,sb)<>2 OR (NEW.resultado->>'goles_a')::int IS DISTINCT FROM sa OR (NEW.resultado->>'goles_b')::int IS DISTINCT FROM sb OR NEW.ganador_equipo_id IS DISTINCT FROM (CASE WHEN sa>sb THEN NEW.equipo_a_id ELSE NEW.equipo_b_id END) THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Nations score contradicts set details'; END IF;
   END IF;
   IF (TG_OP IN('INSERT','DELETE') OR TG_OP='UPDATE' AND (NEW.torneo_id IS DISTINCT FROM OLD.torneo_id OR NEW.grupo IS DISTINCT FROM OLD.grupo OR NEW.bracket_round IS DISTINCT FROM OLD.bracket_round OR NEW.bracket_position IS DISTINCT FROM OLD.bracket_position OR NEW.partido_siguiente_id IS DISTINCT FROM OLD.partido_siguiente_id OR NEW.partido_siguiente_slot IS DISTINCT FROM OLD.partido_siguiente_slot OR NEW.fecha_hora IS DISTINCT FROM OLD.fecha_hora OR NEW.cancha_id IS DISTINCT FROM OLD.cancha_id)) AND current_setting('padbol.nations_rpc',true) IS DISTINCT FROM '1' THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Use atomic Nations draw or scheduling'; END IF;
  END IF;
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS proteger_plan_nations_torneo ON public.torneos;
CREATE TRIGGER proteger_plan_nations_torneo BEFORE INSERT OR UPDATE ON public.torneos FOR EACH ROW EXECUTE FUNCTION public.proteger_plan_nations();
DROP TRIGGER IF EXISTS proteger_plan_nations_partido ON public.partidos;
CREATE TRIGGER proteger_plan_nations_partido BEFORE INSERT OR UPDATE OR DELETE ON public.partidos FOR EACH ROW EXECUTE FUNCTION public.proteger_plan_nations();
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
  IF jsonb_array_length(p_payload->'qualified')<>8 OR jsonb_array_length(p_payload->'matches')<>7 OR (SELECT count(DISTINCT (q->>'equipo_id')::bigint) FROM jsonb_array_elements(p_payload->'qualified') q)<>8 THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Eight approved qualifiers required'; END IF;
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
  IF plan->'groups' IS NULL OR jsonb_typeof(p_payload->'schedule') IS DISTINCT FROM 'array' OR jsonb_array_length(p_payload->'schedule') NOT BETWEEN 1 AND 37 THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Draw required for scheduling'; END IF;
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
 ELSIF p_action='finalizar' THEN
  IF plan->'classification_source' IS DISTINCT FROM (SELECT coalesce(jsonb_agg(x ORDER BY (x->>'id')::bigint),'[]'::jsonb) FROM jsonb_array_elements(public.nations_source_snapshot(t.id)) x WHERE x->>'grupo' IS NOT NULL AND x->'bracket_round'='null'::jsonb) THEN RAISE EXCEPTION USING ERRCODE='40001',MESSAGE='Approved classification source changed'; END IF;
  IF (SELECT count(*) FROM public.partidos WHERE torneo_id=t.id)<>37 OR p_payload->'source' IS DISTINCT FROM public.nations_source_snapshot(t.id) OR jsonb_array_length(p_payload->'placements')<>15 THEN RAISE EXCEPTION USING ERRCODE='40001',MESSAGE='Final results changed or event incomplete'; END IF;
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
CREATE OR REPLACE FUNCTION public.proteger_marcador_nations() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE t public.torneos; m public.partidos; s public.torneo_nations_programacion; c public.canchas; court_number integer;
BEGIN
 IF NEW.torneo_id IS NULL OR NEW.partido_torneo_id IS NULL THEN RETURN NEW; END IF;
 SELECT * INTO t FROM public.torneos WHERE id=NEW.torneo_id FOR UPDATE;
 IF t.plan_nations IS NULL THEN RETURN NEW; END IF;
 SELECT * INTO m FROM public.partidos WHERE id=NEW.partido_torneo_id FOR UPDATE;
 SELECT * INTO s FROM public.torneo_nations_programacion WHERE partido_id=m.id AND torneo_id=t.id;
 SELECT * INTO c FROM public.canchas WHERE id=s.court_id;
 court_number:=coalesce(c.orden,(SELECT count(*)::int FROM public.canchas WHERE sede_id=t.sede_id AND id<=c.id));
 IF s.partido_id IS NULL OR m.torneo_id IS DISTINCT FROM t.id OR m.sede_id IS DISTINCT FROM t.sede_id OR c.sede_id IS DISTINCT FROM t.sede_id OR m.cancha_id IS DISTINCT FROM s.court_id OR m.cancha IS DISTINCT FROM court_number::text OR NEW.cancha IS DISTINCT FROM court_number::text THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Nations scoreboard requires confirmed real court schedule'; END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS proteger_marcador_nations ON public.scoreboard_partidos;
CREATE TRIGGER proteger_marcador_nations BEFORE INSERT OR UPDATE ON public.scoreboard_partidos FOR EACH ROW EXECUTE FUNCTION public.proteger_marcador_nations();
REVOKE ALL ON FUNCTION public.guardar_plan_nations(bigint,uuid,text,bigint,uuid,text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.guardar_plan_nations(bigint,uuid,text,bigint,uuid,text,jsonb) TO service_role;
CREATE OR REPLACE FUNCTION public.exportar_acta_nations(p_torneo_id bigint,p_actor_id uuid,p_revision bigint DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE t public.torneos; result jsonb;
BEGIN
 SELECT * INTO t FROM public.torneos WHERE id=p_torneo_id;
 SELECT p.plan INTO t.plan_nations FROM public.torneo_nations_planes p WHERE p.torneo_id=t.id;
 IF t.plan_nations IS NULL OR NOT EXISTS(SELECT 1 FROM public.user_roles u WHERE u.user_id=p_actor_id AND (u.role='super_admin' OR u.role='admin_club' AND u.sede_id=t.sede_id)) THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Nations admin scope required'; END IF;
 IF p_revision IS NOT NULL AND p_revision IS DISTINCT FROM (t.plan_nations->>'revision')::bigint THEN RAISE EXCEPTION USING ERRCODE='40001',MESSAGE='Export revision changed'; END IF;
 SELECT jsonb_build_object('ok',true,'torneo_id',t.id,'revision',(t.plan_nations->>'revision')::bigint,'type','event_review_draft','official_fipa_points',NULL,'official_fipa_status','external_review_required','generated_at',now(),'config',t.plan_nations->'config','rules_approved',t.plan_nations->'rules_approved','placements',coalesce(t.plan_nations->'placements','[]'::jsonb),
 'internal_points',coalesce((SELECT jsonb_agg(jsonb_build_object('equipo_id',equipo_id,'posicion',posicion,'puntos',puntos) ORDER BY posicion) FROM public.tabla_puntos WHERE torneo_id=t.id),'[]'::jsonb),
 'matches',coalesce((SELECT jsonb_agg(jsonb_build_object('id',id,'equipo_a_id',equipo_a_id,'equipo_b_id',equipo_b_id,'grupo',grupo,'bracket_round',bracket_round,'bracket_position',bracket_position,'estado',estado,'ganador_equipo_id',ganador_equipo_id,'resultado',jsonb_build_object('goles_a',resultado->'goles_a','goles_b',resultado->'goles_b','historial_sets',resultado->'historial_sets')) ORDER BY id) FROM public.partidos WHERE torneo_id=t.id),'[]'::jsonb),
 'declared_participants',coalesce((SELECT jsonb_agg(jsonb_build_object('partido_id',partido_id,'equipo_a_id',equipo_a_id,'equipo_b_id',equipo_b_id,'convocados_a',convocados_a,'convocados_b',convocados_b,'resultado_snapshot',jsonb_build_object('goles_a',resultado_snapshot->'goles_a','goles_b',resultado_snapshot->'goles_b','historial_sets',resultado_snapshot->'historial_sets')) ORDER BY partido_id) FROM public.torneo_partido_participacion WHERE torneo_id=t.id),'[]'::jsonb)) INTO result;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.exportar_acta_nations(bigint,uuid,bigint) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.exportar_acta_nations(bigint,uuid,bigint) TO service_role;
CREATE OR REPLACE FUNCTION public.proteger_clase_nations() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE c public.clases; h public.clases_horarios; s public.torneo_nations_programacion; day date; begin_at timestamptz; end_at timestamptz;
BEGIN
 IF TG_TABLE_NAME='clases' THEN c:=NEW; ELSE SELECT * INTO c FROM public.clases WHERE id=NEW.clase_id; END IF;
 IF c.activo IS DISTINCT FROM true OR c.cancha_id IS NULL THEN RETURN NEW; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.torneos WHERE sede_id=c.sede_id AND plan_nations IS NOT NULL) THEN RETURN NEW; END IF;
 PERFORM id FROM public.canchas WHERE sede_id=c.sede_id ORDER BY id FOR UPDATE;
 FOR h IN SELECT * FROM public.clases_horarios WHERE clase_id=c.id AND TG_TABLE_NAME='clases' UNION ALL SELECT * FROM jsonb_populate_record(NULL::public.clases_horarios,to_jsonb(NEW)) WHERE TG_TABLE_NAME='clases_horarios' LOOP
  FOR s IN SELECT q.* FROM public.torneo_nations_programacion q JOIN public.partidos m ON m.id=q.partido_id WHERE q.court_id=c.cancha_id AND m.estado NOT IN('cancelado','suspendido') LOOP
   FOR day IN SELECT d::date FROM generate_series((s.inicio AT TIME ZONE s.timezone)::date,((s.inicio+s.duration_minutes*interval '1 minute') AT TIME ZONE s.timezone)::date,interval '1 day') d LOOP
    IF extract(dow FROM day)::int=h.dia_semana THEN
     begin_at:=(day+h.hora_inicio) AT TIME ZONE s.timezone;end_at:=(day+h.hora_fin) AT TIME ZONE s.timezone;
     IF begin_at<s.inicio+s.duration_minutes*interval '1 minute' AND s.inicio<end_at THEN RAISE EXCEPTION USING ERRCODE='23P01',MESSAGE='Class conflicts with Nations schedule'; END IF;
    END IF;
   END LOOP;
  END LOOP;
 END LOOP;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS proteger_clase_nations ON public.clases;
CREATE TRIGGER proteger_clase_nations BEFORE INSERT OR UPDATE ON public.clases FOR EACH ROW EXECUTE FUNCTION public.proteger_clase_nations();
DROP TRIGGER IF EXISTS proteger_horario_clase_nations ON public.clases_horarios;
CREATE TRIGGER proteger_horario_clase_nations BEFORE INSERT OR UPDATE ON public.clases_horarios FOR EACH ROW EXECUTE FUNCTION public.proteger_clase_nations();
-- Only reservations sharing a Nations-managed venue acquire the same court locks.
CREATE OR REPLACE FUNCTION public.proteger_reserva_nations() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE c public.canchas; start_at timestamptz; zone text; venue_id bigint;
BEGIN
 IF lower(coalesce(NEW.estado,'')) IN('cancelada','cancelado') THEN RETURN NEW; END IF;
 venue_id:=NEW.sede_id;IF venue_id IS NULL THEN
  IF (SELECT count(*) FROM public.sedes WHERE nombre=NEW.sede)>1 AND EXISTS(SELECT 1 FROM public.torneos t JOIN public.sedes x ON x.id=t.sede_id WHERE x.nombre=NEW.sede AND t.plan_nations IS NOT NULL) THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Ambiguous venue requires its actual identifier'; END IF;
  SELECT id INTO venue_id FROM public.sedes WHERE nombre=NEW.sede ORDER BY id LIMIT 1; END IF;
 IF EXISTS(SELECT 1 FROM public.torneos WHERE sede_id=venue_id AND plan_nations IS NOT NULL) THEN
  PERFORM id FROM public.canchas WHERE sede_id=venue_id ORDER BY id FOR UPDATE;
  SELECT * INTO c FROM public.canchas x WHERE x.sede_id=venue_id AND coalesce(x.orden,(SELECT count(*)::int FROM public.canchas y WHERE y.sede_id=venue_id AND y.id<=x.id))=NEW.cancha ORDER BY id LIMIT 1;
  IF c.id IS NULL OR NEW.fecha !~ '^\d{4}-\d{2}-\d{2}$' OR NEW.hora !~ '^\d{2}:\d{2}' THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Valid venue reservation schedule required'; END IF;
  FOR zone IN SELECT DISTINCT timezone FROM public.torneo_nations_programacion WHERE court_id=c.id LOOP
   start_at:=(NEW.fecha||' '||substring(NEW.hora,1,5))::timestamp AT TIME ZONE zone;
   IF EXISTS(SELECT 1 FROM public.torneo_nations_programacion s JOIN public.partidos m ON m.id=s.partido_id WHERE s.court_id=c.id AND m.estado NOT IN('cancelado','suspendido') AND s.inicio<start_at+coalesce(NEW.duracion_minutos,90)*interval '1 minute' AND start_at<s.inicio+s.duration_minutes*interval '1 minute') THEN RAISE EXCEPTION USING ERRCODE='23P01',MESSAGE='Reservation conflicts with Nations match'; END IF;
  END LOOP;
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS proteger_reserva_nations ON public.reservas;
CREATE TRIGGER proteger_reserva_nations BEFORE INSERT OR UPDATE ON public.reservas FOR EACH ROW EXECUTE FUNCTION public.proteger_reserva_nations();

-- Restrictive policies preserve every legacy read, but never expose national roster contacts.
CREATE OR REPLACE FUNCTION public.puede_leer_nations(p_torneo_id bigint,p_equipo_id bigint DEFAULT NULL,p_partido_id bigint DEFAULT NULL) RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE t public.torneos; actor uuid:=auth.uid();
BEGIN
 SELECT * INTO t FROM public.torneos WHERE id=p_torneo_id;
 IF NOT FOUND THEN RETURN false; END IF;
 IF t.plan_nations IS NULL THEN RETURN true; END IF;
 IF actor IS NULL THEN RETURN false; END IF;
 IF EXISTS(SELECT 1 FROM public.user_roles u WHERE u.user_id=actor AND (u.role='super_admin' OR u.role='admin_club' AND u.sede_id=t.sede_id)) THEN RETURN true; END IF;
 IF p_equipo_id IS NOT NULL THEN RETURN EXISTS(SELECT 1 FROM public.equipos e WHERE e.id=p_equipo_id AND e.torneo_id=t.id AND e.creador_id=actor); END IF;
 IF p_partido_id IS NOT NULL THEN RETURN EXISTS(SELECT 1 FROM public.partidos m JOIN public.equipos e ON e.id IN(m.equipo_a_id,m.equipo_b_id) WHERE m.id=p_partido_id AND m.torneo_id=t.id AND (e.creador_id=actor OR EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(e.jugadores,'[]'::jsonb)) j WHERE coalesce(j->>'user_id',j->>'id')=actor::text))); END IF;
 RETURN false;
END $$;
REVOKE ALL ON FUNCTION public.puede_leer_nations(bigint,bigint,bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.puede_leer_nations(bigint,bigint,bigint) TO anon,authenticated,service_role;
DROP POLICY IF EXISTS nations_equipos_read_guard ON public.equipos;
CREATE POLICY nations_equipos_read_guard ON public.equipos AS RESTRICTIVE FOR SELECT TO anon,authenticated USING(public.puede_leer_nations(torneo_id,id,NULL));
DROP POLICY IF EXISTS nations_partidos_read_guard ON public.partidos;
CREATE POLICY nations_partidos_read_guard ON public.partidos AS RESTRICTIVE FOR SELECT TO anon,authenticated USING(public.puede_leer_nations(torneo_id,NULL,id));
DROP POLICY IF EXISTS nations_puntos_read_guard ON public.tabla_puntos;
CREATE POLICY nations_puntos_read_guard ON public.tabla_puntos AS RESTRICTIVE FOR SELECT TO anon,authenticated USING(public.puede_leer_nations(torneo_id,equipo_id,NULL));
DROP POLICY IF EXISTS nations_scoreboard_read_guard ON public.scoreboard_partidos;
CREATE POLICY nations_scoreboard_read_guard ON public.scoreboard_partidos AS RESTRICTIVE FOR SELECT TO anon,authenticated USING(partido_torneo_id IS NULL OR EXISTS(SELECT 1 FROM public.partidos m WHERE m.id=partido_torneo_id AND public.puede_leer_nations(m.torneo_id,NULL,m.id)));
-- games inherits the sports-match audience; a public child policy must not bypass its parent.
CREATE OR REPLACE FUNCTION public.puede_leer_games_nations(p_partido_id bigint) RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE m public.partidos;
BEGIN
 IF p_partido_id IS NULL THEN RETURN true; END IF;
 SELECT * INTO m FROM public.partidos WHERE id=p_partido_id;
 IF NOT FOUND THEN RETURN false; END IF;
 RETURN public.puede_leer_nations(m.torneo_id,NULL,m.id);
END $$;
REVOKE ALL ON FUNCTION public.puede_leer_games_nations(bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.puede_leer_games_nations(bigint) TO anon,authenticated,service_role;
DROP POLICY IF EXISTS nations_games_read_guard ON public.games;
CREATE POLICY nations_games_read_guard ON public.games AS RESTRICTIVE FOR SELECT TO anon,authenticated USING(public.puede_leer_games_nations(partido_id));
-- A child's tournament claim is not authoritative: derive its event from its actual team FK.
CREATE OR REPLACE FUNCTION public.puede_leer_equipo_nations(p_equipo_id bigint) RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE e public.equipos;
BEGIN
 IF p_equipo_id IS NULL THEN RETURN true; END IF;
 SELECT * INTO e FROM public.equipos WHERE id=p_equipo_id;
 IF NOT FOUND THEN RETURN false; END IF;
 RETURN public.puede_leer_nations(e.torneo_id,e.id,NULL);
END $$;
REVOKE ALL ON FUNCTION public.puede_leer_equipo_nations(bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.puede_leer_equipo_nations(bigint) TO anon,authenticated,service_role;
DROP POLICY IF EXISTS nations_ranking_jugadores_read_guard ON public.ranking_jugadores;
CREATE POLICY nations_ranking_jugadores_read_guard ON public.ranking_jugadores AS RESTRICTIVE FOR SELECT TO anon,authenticated USING(public.puede_leer_equipo_nations(equipo_id));
DROP POLICY IF EXISTS nations_clasificaciones_read_guard ON public.clasificaciones;
CREATE POLICY nations_clasificaciones_read_guard ON public.clasificaciones AS RESTRICTIVE FOR SELECT TO anon,authenticated USING(public.puede_leer_equipo_nations(equipo_id));
COMMIT;
