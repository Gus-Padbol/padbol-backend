BEGIN;
CREATE TABLE IF NOT EXISTS public.torneo_fixture_planes (
 torneo_id bigint PRIMARY KEY REFERENCES public.torneos(id),
 origen text NOT NULL CHECK(origen IN('automatico','manual')),
 actor_id uuid NOT NULL,
 equipo_ids bigint[] NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.torneo_fixture_planes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.torneo_fixture_planes FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT ON public.torneo_fixture_planes TO service_role;
CREATE TABLE IF NOT EXISTS public.torneo_partidos_programacion (
 partido_id bigint PRIMARY KEY REFERENCES public.partidos(id),torneo_id bigint NOT NULL REFERENCES public.torneos(id),
 court_id bigint NOT NULL REFERENCES public.canchas(id),inicio timestamptz NOT NULL,
 duration_minutes integer NOT NULL CHECK(duration_minutes BETWEEN 1 AND 720),actor_id uuid NOT NULL,updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.torneo_partidos_programacion ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.torneo_partidos_programacion FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE ON public.torneo_partidos_programacion TO service_role;
CREATE OR REPLACE FUNCTION public.planificar_fixture_torneo(p_torneo_id bigint,p_actor_id uuid,p_equipo_ids bigint[],p_origen text,p_partidos jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE t public.torneos;r public.user_roles;ids bigint[];actual bigint[];n integer;rows jsonb;
BEGIN
 SELECT * INTO t FROM public.torneos WHERE id=p_torneo_id FOR UPDATE;
 SELECT * INTO r FROM public.user_roles WHERE user_id=p_actor_id;
 IF t.id IS NULL THEN RAISE EXCEPTION USING ERRCODE='P0002',MESSAGE='Tournament missing';END IF;
 IF (r.role='super_admin' OR r.role='admin_club' AND r.sede_id=t.sede_id) IS DISTINCT FROM true THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Scope denied';END IF;
 IF t.plan_nations IS NOT NULL OR t.estado NOT IN('abierto','inscripcion','inscripcion_abierta','proximo','planificacion') OR t.tipo_torneo NOT IN('knockout','round_robin') THEN RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='Planning not allowed';END IF;
 IF p_origen IS NULL OR p_origen NOT IN('automatico','manual') THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Origin required';END IF;
 PERFORM id FROM public.equipos WHERE torneo_id=t.id ORDER BY id FOR UPDATE;
 SELECT array_agg(id ORDER BY id) INTO actual FROM public.equipos WHERE torneo_id=t.id;
 SELECT array_agg(x ORDER BY x) INTO ids FROM unnest(p_equipo_ids) x;
 IF actual IS DISTINCT FROM ids OR cardinality(ids)<2 OR cardinality(ids)<>(SELECT count(DISTINCT x) FROM unnest(ids) x) OR EXISTS(SELECT 1 FROM equipos WHERE torneo_id=t.id AND coalesce(inscripcion_estado,'') NOT IN('confirmado','confirmada')) THEN RAISE EXCEPTION USING ERRCODE='40001',MESSAGE='Confirmed roster changed';END IF;
 IF EXISTS(SELECT 1 FROM partidos WHERE torneo_id=t.id) THEN RAISE EXCEPTION USING ERRCODE='23505',MESSAGE='Fixture already exists; preserve all results';END IF;
 IF jsonb_typeof(p_partidos) IS DISTINCT FROM 'array' OR jsonb_array_length(p_partidos)<1 THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Matches required';END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_partidos) x WHERE (x->>'torneo_id')::bigint IS DISTINCT FROM t.id OR (x->>'sede_id')::bigint IS DISTINCT FROM t.sede_id OR x->>'estado' IS DISTINCT FROM 'pendiente' OR x->>'equipo_a_id' IS NOT NULL AND ((x->>'equipo_a_id')::bigint=ANY(ids)) IS DISTINCT FROM true OR x->>'equipo_b_id' IS NOT NULL AND ((x->>'equipo_b_id')::bigint=ANY(ids)) IS DISTINCT FROM true OR x->>'equipo_a_id' IS NOT NULL AND x->>'equipo_a_id'=x->>'equipo_b_id') THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Foreign/self match';END IF;
 IF t.tipo_torneo='knockout' THEN
  IF cardinality(ids) NOT IN(4,8,16) OR jsonb_array_length(p_partidos)<>cardinality(ids)-1 THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Unsupported bracket size';END IF;
  IF (SELECT array_agg(v ORDER BY v) FROM (SELECT (x->>'equipo_a_id')::bigint v FROM jsonb_array_elements(p_partidos) x WHERE (x->>'bracket_round')::integer=1 UNION ALL SELECT (x->>'equipo_b_id')::bigint FROM jsonb_array_elements(p_partidos) x WHERE (x->>'bracket_round')::integer=1) first_round) IS DISTINCT FROM ids THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='First round must include every team once';END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_partidos) x WHERE (x->>'bracket_round')::integer>1 AND (x->>'equipo_a_id' IS NOT NULL OR x->>'equipo_b_id' IS NOT NULL)) THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Future opponents must follow results';END IF;
 ELSE
  IF p_origen='manual' OR jsonb_array_length(p_partidos)<>cardinality(ids)*(cardinality(ids)-1)/2 OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_partidos) x WHERE x->>'equipo_a_id' IS NULL OR x->>'equipo_b_id' IS NULL) OR (SELECT count(DISTINCT least(x->>'equipo_a_id',x->>'equipo_b_id')||':'||greatest(x->>'equipo_a_id',x->>'equipo_b_id')) FROM jsonb_array_elements(p_partidos) x)<>jsonb_array_length(p_partidos) THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='All unique round robin pairings required';END IF;
 END IF;
 INSERT INTO partidos(torneo_id,sede_id,equipo_a_id,equipo_b_id,estado,grupo,ronda,bracket_round,bracket_position)
 SELECT t.id,t.sede_id,m.equipo_a_id,m.equipo_b_id,'pendiente',m.grupo,m.ronda,m.bracket_round,m.bracket_position FROM jsonb_to_recordset(p_partidos) m(equipo_a_id bigint,equipo_b_id bigint,grupo text,ronda integer,bracket_round integer,bracket_position integer);
 IF t.tipo_torneo='knockout' THEN
  UPDATE partidos src SET partido_siguiente_id=dst.id,partido_siguiente_slot=CASE WHEN src.bracket_position%2=1 THEN 'A' ELSE 'B' END FROM partidos dst WHERE src.torneo_id=t.id AND dst.torneo_id=t.id AND dst.bracket_round=src.bracket_round+1 AND dst.bracket_position=(src.bracket_position+1)/2;
  GET DIAGNOSTICS n=ROW_COUNT;
  IF n<>jsonb_array_length(p_partidos)-1 THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Incomplete bracket progression';END IF;
 END IF;
 INSERT INTO torneo_fixture_planes(torneo_id,origen,actor_id,equipo_ids) VALUES(t.id,p_origen,p_actor_id,ids);
 SELECT jsonb_agg(to_jsonb(p) ORDER BY id) INTO rows FROM partidos p WHERE torneo_id=t.id;
 -- State deliberately remains open. Starting is a separate confirmed operation.
 RETURN jsonb_build_object('ok',true,'torneo_id',t.id,'partidos',rows,'total',jsonb_array_length(rows),'formato',t.tipo_torneo,'estado',t.estado,'origen',p_origen);
END $$;
REVOKE ALL ON FUNCTION public.planificar_fixture_torneo(bigint,uuid,bigint[],text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.planificar_fixture_torneo(bigint,uuid,bigint[],text,jsonb) TO service_role;
COMMIT;

BEGIN;
CREATE OR REPLACE FUNCTION public.iniciar_torneo_planificado(p_torneo_id bigint,p_actor_id uuid,p_roster jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE t public.torneos;r public.user_roles;actual jsonb;
BEGIN
 SELECT * INTO t FROM torneos WHERE id=p_torneo_id FOR UPDATE;
 SELECT * INTO r FROM user_roles WHERE user_id=p_actor_id;
 IF t.id IS NULL THEN RAISE EXCEPTION USING ERRCODE='P0002',MESSAGE='Tournament missing';END IF;
 IF (r.role='super_admin' OR r.role='admin_club' AND r.sede_id=t.sede_id) IS DISTINCT FROM true THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Scope denied';END IF;
 IF t.plan_nations IS NOT NULL OR t.estado NOT IN('abierto','inscripcion','inscripcion_abierta','proximo','planificacion') THEN RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='Explicit start not allowed';END IF;
 PERFORM id FROM equipos WHERE torneo_id=t.id ORDER BY id FOR UPDATE;
 SELECT jsonb_agg(jsonb_build_object('id',id,'jugadores',jugadores,'inscripcion_estado',inscripcion_estado) ORDER BY id) INTO actual FROM equipos WHERE torneo_id=t.id;
 IF actual IS DISTINCT FROM p_roster OR coalesce(jsonb_array_length(actual),0)<2 OR EXISTS(SELECT 1 FROM equipos WHERE torneo_id=t.id AND coalesce(inscripcion_estado,'') NOT IN('confirmado','confirmada')) THEN RAISE EXCEPTION USING ERRCODE='40001',MESSAGE='Roster changed';END IF;
 IF NOT EXISTS(SELECT 1 FROM partidos WHERE torneo_id=t.id) OR EXISTS(SELECT 1 FROM partidos WHERE torneo_id=t.id AND estado NOT IN('pendiente','programado')) THEN RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='Review pending fixture before start';END IF;
 UPDATE torneos SET estado='en_curso',updated_at=now() WHERE id=t.id;
 RETURN jsonb_build_object('ok',true,'torneo_id',t.id,'estado','en_curso');
END $$;
REVOKE ALL ON FUNCTION public.iniciar_torneo_planificado(bigint,uuid,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.iniciar_torneo_planificado(bigint,uuid,jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.programar_partido_torneo(p_torneo_id bigint,p_partido_id bigint,p_actor_id uuid,p_court_id bigint,p_inicio timestamptz,p_duration integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE t public.torneos;r public.user_roles;m public.partidos;c public.canchas;zone text;court_number integer;
BEGIN
 SELECT * INTO t FROM torneos WHERE id=p_torneo_id FOR UPDATE;
 SELECT * INTO r FROM user_roles WHERE user_id=p_actor_id;
 IF t.id IS NULL OR (r.role='super_admin' OR r.role='admin_club' AND r.sede_id=t.sede_id) IS DISTINCT FROM true THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Scope denied';END IF;
 IF t.plan_nations IS NOT NULL OR t.estado IN('finalizado','cancelado') THEN RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='Scheduling not allowed';END IF;
 SELECT * INTO m FROM partidos WHERE id=p_partido_id AND torneo_id=t.id FOR UPDATE;
 IF m.id IS NULL OR m.estado NOT IN('pendiente','programado') OR EXISTS(SELECT 1 FROM scoreboard_partidos WHERE partido_torneo_id=m.id AND estado NOT IN('pendiente')) THEN RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='Match already started or missing';END IF;
 SELECT * INTO c FROM canchas WHERE id=p_court_id AND sede_id=t.sede_id FOR UPDATE;
 IF c.id IS NULL OR lower(coalesce(c.estado,'')) IN('inactiva','inactivo','cerrada','mantenimiento') OR coalesce(c.deporte,'padbol')<>coalesce(t.deporte,'padbol') THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Court not eligible';END IF;
 court_number:=coalesce(c.orden,(SELECT count(*)::int FROM canchas WHERE sede_id=t.sede_id AND id<=c.id));
 SELECT coalesce(nullif(timezone,''),'America/Argentina/Buenos_Aires') INTO zone FROM sedes WHERE id=t.sede_id;
 IF p_inicio IS NULL OR p_duration IS NULL OR p_duration NOT BETWEEN 1 AND 720 OR (p_inicio AT TIME ZONE zone)::date<t.fecha_inicio::date OR (p_inicio AT TIME ZONE zone)::date>t.fecha_fin::date THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Schedule outside tournament dates';END IF;
 IF EXISTS(SELECT 1 FROM torneo_partidos_programacion s JOIN partidos p ON p.id=s.partido_id WHERE s.court_id=c.id AND s.partido_id<>m.id AND p.estado NOT IN('cancelado','finalizado') AND tstzrange(s.inicio,s.inicio+make_interval(mins=>s.duration_minutes),'[)') && tstzrange(p_inicio,p_inicio+make_interval(mins=>p_duration),'[)'))
 OR EXISTS(SELECT 1 FROM torneo_nations_programacion s JOIN partidos p ON p.id=s.partido_id WHERE s.court_id=c.id AND p.estado NOT IN('cancelado','finalizado') AND tstzrange(s.inicio,s.inicio+make_interval(mins=>s.duration_minutes),'[)') && tstzrange(p_inicio,p_inicio+make_interval(mins=>p_duration),'[)'))
 THEN RAISE EXCEPTION USING ERRCODE='23505',MESSAGE='Court time conflict';END IF;
 IF EXISTS(SELECT 1 FROM reservas booking WHERE (booking.sede_id=t.sede_id OR booking.sede_id IS NULL AND booking.sede=(SELECT nombre FROM sedes WHERE id=t.sede_id)) AND booking.cancha=court_number AND lower(coalesce(booking.estado,'')) NOT IN('cancelada','cancelado') AND booking.fecha ~ '^\d{4}-\d{2}-\d{2}$' AND booking.hora ~ '^\d{2}:\d{2}' AND ((booking.fecha||' '||substring(booking.hora,1,5))::timestamp AT TIME ZONE zone)<p_inicio+p_duration*interval '1 minute' AND p_inicio<((booking.fecha||' '||substring(booking.hora,1,5))::timestamp AT TIME ZONE zone)+coalesce(booking.duracion_minutos,90)*interval '1 minute') THEN RAISE EXCEPTION USING ERRCODE='23505',MESSAGE='Reservation conflict';END IF;
 IF EXISTS(SELECT 1 FROM clases a JOIN clases_horarios h ON h.clase_id=a.id CROSS JOIN LATERAL generate_series((p_inicio AT TIME ZONE zone)::date,((p_inicio+p_duration*interval '1 minute') AT TIME ZONE zone)::date,interval '1 day') d WHERE a.cancha_id=c.id AND a.activo=true AND h.dia_semana=extract(dow FROM d)::int AND ((d::date+h.hora_inicio) AT TIME ZONE zone)<p_inicio+p_duration*interval '1 minute' AND p_inicio<((d::date+h.hora_fin) AT TIME ZONE zone)) THEN RAISE EXCEPTION USING ERRCODE='23505',MESSAGE='Class conflict';END IF;
 IF EXISTS(SELECT 1 FROM torneo_partidos_programacion s JOIN partidos p ON p.id=s.partido_id WHERE s.torneo_id=t.id AND p.id<>m.id AND p.estado NOT IN('cancelado','suspendido') AND (m.equipo_a_id IN(p.equipo_a_id,p.equipo_b_id) OR m.equipo_b_id IN(p.equipo_a_id,p.equipo_b_id)) AND s.inicio<p_inicio+p_duration*interval '1 minute' AND p_inicio<s.inicio+s.duration_minutes*interval '1 minute') THEN RAISE EXCEPTION USING ERRCODE='23505',MESSAGE='Team conflict';END IF;
 IF EXISTS(SELECT 1 FROM partidos p JOIN torneo_partidos_programacion s ON s.partido_id=p.id WHERE p.id=m.partido_siguiente_id AND s.inicio<p_inicio+p_duration*interval '1 minute') OR EXISTS(SELECT 1 FROM partidos p JOIN torneo_partidos_programacion s ON s.partido_id=p.id WHERE p.partido_siguiente_id=m.id AND p_inicio<s.inicio+s.duration_minutes*interval '1 minute') THEN RAISE EXCEPTION USING ERRCODE='23505',MESSAGE='Bracket schedule order conflict';END IF;
 INSERT INTO torneo_partidos_programacion(partido_id,torneo_id,court_id,inicio,duration_minutes,actor_id) VALUES(m.id,t.id,c.id,p_inicio,p_duration,p_actor_id)
 ON CONFLICT(partido_id) DO UPDATE SET court_id=excluded.court_id,inicio=excluded.inicio,duration_minutes=excluded.duration_minutes,actor_id=excluded.actor_id,updated_at=now();
 UPDATE partidos SET fecha_hora=p_inicio AT TIME ZONE 'UTC',cancha_id=c.id,cancha=court_number::text WHERE id=m.id;
 UPDATE scoreboard_partidos SET cancha=court_number::text WHERE partido_torneo_id=m.id AND estado='pendiente';
 RETURN jsonb_build_object('ok',true,'torneo_id',t.id,'partido_id',m.id,'court_id',c.id,'fecha_hora',p_inicio,'cancha',court_number::text,'cancha_nombre',c.nombre,'duration_minutes',p_duration);
END $$;
REVOKE ALL ON FUNCTION public.programar_partido_torneo(bigint,bigint,uuid,bigint,timestamptz,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.programar_partido_torneo(bigint,bigint,uuid,bigint,timestamptz,integer) TO service_role;
COMMIT;

BEGIN;
-- Reciprocal protection: a later reservation/Nations schedule cannot take a planned normal match's court.
CREATE OR REPLACE FUNCTION public.proteger_reserva_fixture_general() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE venue bigint;c public.canchas;zone text;start_at timestamptz;
BEGIN
 IF lower(coalesce(NEW.estado,'')) IN('cancelada','cancelado') THEN RETURN NEW;END IF;
 venue:=NEW.sede_id;
 IF venue IS NULL THEN
  IF (SELECT count(*) FROM sedes WHERE nombre=NEW.sede)<>1 THEN
   IF EXISTS(SELECT 1 FROM torneo_partidos_programacion s JOIN torneos t ON t.id=s.torneo_id JOIN sedes v ON v.id=t.sede_id WHERE v.nombre=NEW.sede) THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Actual venue ID required';END IF;
   RETURN NEW;
  END IF;
  SELECT id INTO venue FROM sedes WHERE nombre=NEW.sede;
 END IF;
 IF NOT EXISTS(SELECT 1 FROM torneo_partidos_programacion s JOIN torneos t ON t.id=s.torneo_id WHERE t.sede_id=venue) THEN RETURN NEW;END IF;
 -- Same ordered locks as Nations/reservations. Only venues with planned normal matches participate.
 PERFORM id FROM canchas WHERE sede_id=venue ORDER BY id FOR UPDATE;
 SELECT * INTO c FROM canchas x WHERE x.sede_id=venue AND coalesce(x.orden,(SELECT count(*)::int FROM canchas y WHERE y.sede_id=venue AND y.id<=x.id))=NEW.cancha ORDER BY id LIMIT 1;
 SELECT coalesce(nullif(timezone,''),'America/Argentina/Buenos_Aires') INTO zone FROM sedes WHERE id=venue;
 IF c.id IS NULL OR NEW.fecha !~ '^\d{4}-\d{2}-\d{2}$' OR NEW.hora !~ '^\d{2}:\d{2}' THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Valid reservation schedule required';END IF;
 start_at:=(NEW.fecha||' '||substring(NEW.hora,1,5))::timestamp AT TIME ZONE zone;
 IF EXISTS(SELECT 1 FROM torneo_partidos_programacion s JOIN partidos p ON p.id=s.partido_id WHERE s.court_id=c.id AND p.estado NOT IN('cancelado','suspendido') AND s.inicio<start_at+coalesce(NEW.duracion_minutos,90)*interval '1 minute' AND start_at<s.inicio+s.duration_minutes*interval '1 minute') THEN RAISE EXCEPTION USING ERRCODE='23505',MESSAGE='Reservation conflicts with tournament fixture';END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.proteger_reserva_fixture_general() FROM PUBLIC,anon,authenticated;
DROP TRIGGER IF EXISTS proteger_reserva_fixture_general ON reservas;
CREATE TRIGGER proteger_reserva_fixture_general BEFORE INSERT OR UPDATE ON reservas FOR EACH ROW EXECUTE FUNCTION public.proteger_reserva_fixture_general();
CREATE OR REPLACE FUNCTION public.proteger_nations_fixture_general() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 PERFORM id FROM canchas WHERE id=NEW.court_id FOR UPDATE;
 IF EXISTS(SELECT 1 FROM torneo_partidos_programacion s JOIN partidos p ON p.id=s.partido_id WHERE s.court_id=NEW.court_id AND p.estado NOT IN('cancelado','suspendido') AND s.inicio<NEW.inicio+NEW.duration_minutes*interval '1 minute' AND NEW.inicio<s.inicio+s.duration_minutes*interval '1 minute') THEN RAISE EXCEPTION USING ERRCODE='23505',MESSAGE='Nations schedule conflicts with tournament fixture';END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.proteger_nations_fixture_general() FROM PUBLIC,anon,authenticated;
DROP TRIGGER IF EXISTS proteger_nations_fixture_general ON torneo_nations_programacion;
CREATE TRIGGER proteger_nations_fixture_general BEFORE INSERT OR UPDATE ON torneo_nations_programacion FOR EACH ROW EXECUTE FUNCTION public.proteger_nations_fixture_general();
COMMIT;

BEGIN;
CREATE OR REPLACE FUNCTION public.proteger_resultado_fixture_planificado() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF NEW.estado IN('en_curso','finalizado','terminado') AND EXISTS(SELECT 1 FROM torneo_fixture_planes f JOIN torneos t ON t.id=f.torneo_id WHERE t.id=NEW.torneo_id AND t.estado IN('abierto','inscripcion','inscripcion_abierta','proximo','planificacion')) THEN
  RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='Explicit tournament start required before scoring';
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.proteger_resultado_fixture_planificado() FROM PUBLIC,anon,authenticated;
DROP TRIGGER IF EXISTS proteger_resultado_fixture_planificado ON partidos;
CREATE TRIGGER proteger_resultado_fixture_planificado BEFORE UPDATE ON partidos FOR EACH ROW EXECUTE FUNCTION public.proteger_resultado_fixture_planificado();
DROP TRIGGER IF EXISTS proteger_marcador_fixture_planificado ON scoreboard_partidos;
CREATE TRIGGER proteger_marcador_fixture_planificado BEFORE INSERT OR UPDATE ON scoreboard_partidos FOR EACH ROW EXECUTE FUNCTION public.proteger_resultado_fixture_planificado();
COMMIT;
