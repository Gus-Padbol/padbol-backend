BEGIN;
-- Follow-up after full published HTTP rehearsal exposed the live match-structure guard.
CREATE OR REPLACE FUNCTION public.preparar_marcador_torneo_ahora(p_torneo_id bigint,p_partido_id bigint,p_actor_id uuid,p_court_id bigint)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE t public.torneos;m public.partidos;c public.canchas;r public.user_roles;court_number integer;zone text;at_now timestamptz:=clock_timestamp();
BEGIN
 SELECT * INTO t FROM torneos WHERE id=p_torneo_id FOR UPDATE;
 SELECT * INTO r FROM user_roles WHERE user_id=p_actor_id;
 IF t.id IS NULL OR (r.role='super_admin' OR r.role='admin_club' AND r.sede_id=t.sede_id) IS DISTINCT FROM true THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Scope denied';END IF;
 IF t.estado NOT IN('en_curso','activo') THEN RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='Explicit tournament start required';END IF;
 SELECT * INTO m FROM partidos WHERE id=p_partido_id AND torneo_id=t.id FOR UPDATE;
 IF m.id IS NULL OR m.estado NOT IN('pendiente','programado') OR m.equipo_a_id IS NULL OR m.equipo_b_id IS NULL OR m.equipo_a_id=m.equipo_b_id THEN RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='Match not ready';END IF;
 SELECT * INTO c FROM canchas WHERE id=p_court_id AND sede_id=t.sede_id FOR UPDATE;
 IF c.id IS NULL OR lower(coalesce(c.estado,'')) IN('inactiva','inactivo','cerrada','mantenimiento') OR coalesce(c.deporte,'padbol')<>coalesce(t.deporte,'padbol') THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Court not eligible';END IF;
 court_number:=coalesce(c.orden,(SELECT count(*)::int FROM canchas WHERE sede_id=t.sede_id AND id<=c.id));
 SELECT coalesce(nullif(timezone,''),'America/Argentina/Buenos_Aires') INTO zone FROM sedes WHERE id=t.sede_id;
 IF EXISTS(SELECT 1 FROM scoreboard_partidos s WHERE s.sede_id=t.sede_id AND s.cancha=court_number::text AND s.partido_torneo_id IS DISTINCT FROM m.id AND lower(coalesce(s.estado,'')) NOT IN('terminado','finalizado','cancelado')) THEN RAISE EXCEPTION USING ERRCODE='23505',MESSAGE='Court screen occupied';END IF;
 IF EXISTS(SELECT 1 FROM scoreboard_partidos s JOIN partidos p ON p.id=s.partido_torneo_id WHERE p.id<>m.id AND (m.equipo_a_id IN(p.equipo_a_id,p.equipo_b_id) OR m.equipo_b_id IN(p.equipo_a_id,p.equipo_b_id)) AND lower(coalesce(s.estado,'')) NOT IN('terminado','finalizado','cancelado')) THEN RAISE EXCEPTION USING ERRCODE='23505',MESSAGE='Team already using a scoreboard';END IF;
 IF EXISTS(SELECT 1 FROM reservas b WHERE (b.sede_id=t.sede_id OR b.sede_id IS NULL AND b.sede=(SELECT nombre FROM sedes WHERE id=t.sede_id)) AND b.cancha=court_number AND lower(coalesce(b.estado,'')) NOT IN('cancelada','cancelado') AND b.fecha ~ '^\d{4}-\d{2}-\d{2}$' AND b.hora ~ '^\d{2}:\d{2}' AND ((b.fecha||' '||substring(b.hora,1,5))::timestamp AT TIME ZONE zone)<=at_now AND at_now<((b.fecha||' '||substring(b.hora,1,5))::timestamp AT TIME ZONE zone)+coalesce(b.duracion_minutos,90)*interval '1 minute') THEN RAISE EXCEPTION USING ERRCODE='23505',MESSAGE='Court has active reservation';END IF;
 IF EXISTS(SELECT 1 FROM clases a JOIN clases_horarios h ON h.clase_id=a.id WHERE a.cancha_id=c.id AND a.activo=true AND h.dia_semana=extract(dow FROM at_now AT TIME ZONE zone)::int AND (at_now AT TIME ZONE zone)::time>=h.hora_inicio AND (at_now AT TIME ZONE zone)::time<h.hora_fin) THEN RAISE EXCEPTION USING ERRCODE='23505',MESSAGE='Court has active class';END IF;
 IF EXISTS(SELECT 1 FROM torneo_partidos_programacion s JOIN partidos p ON p.id=s.partido_id WHERE s.court_id=c.id AND p.id<>m.id AND p.estado NOT IN('cancelado','finalizado') AND s.inicio<=at_now AND at_now<s.inicio+s.duration_minutes*interval '1 minute') OR EXISTS(SELECT 1 FROM torneo_nations_programacion s JOIN partidos p ON p.id=s.partido_id WHERE s.court_id=c.id AND p.id<>m.id AND p.estado NOT IN('cancelado','finalizado') AND s.inicio<=at_now AND at_now<s.inicio+s.duration_minutes*interval '1 minute') THEN RAISE EXCEPTION USING ERRCODE='23505',MESSAGE='Court reserved by another match';END IF;
 IF EXISTS(SELECT 1 FROM scoreboard_partidos WHERE partido_torneo_id=m.id AND lower(coalesce(estado,'')) NOT IN('terminado','finalizado','cancelado') AND (cancha IS NOT NULL AND cancha IS DISTINCT FROM court_number::text OR cancha IS NULL AND estado<>'pendiente')) THEN RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='Existing scoreboard court cannot change';END IF;
 -- The production Nations structure guard permits court assignment only inside its authorized API transaction.
 IF t.plan_nations IS NOT NULL THEN PERFORM set_config('padbol.nations_rpc','1',true);END IF;
 UPDATE partidos SET cancha_id=c.id,cancha=court_number::text WHERE id=m.id;
 -- Progression may have already created a pending linked marker before a court was chosen.
 UPDATE scoreboard_partidos SET cancha=court_number::text WHERE partido_torneo_id=m.id AND estado='pendiente' AND cancha IS NULL;
 RETURN jsonb_build_object('ok',true,'partido_id',m.id,'court_id',c.id,'cancha',court_number::text);
END $$;
REVOKE ALL ON FUNCTION public.preparar_marcador_torneo_ahora(bigint,bigint,uuid,bigint) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.preparar_marcador_torneo_ahora(bigint,bigint,uuid,bigint) TO service_role;
COMMIT;
