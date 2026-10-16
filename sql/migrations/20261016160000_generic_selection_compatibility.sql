-- Normal selections may use persisted sporting participants without an account.
-- Nations and legacy auth-user references retain their previous validation path.
BEGIN;
CREATE OR REPLACE FUNCTION public.referencias_plantel_general(p_torneo_id bigint,p_jugadores jsonb)
RETURNS uuid[] LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE refs uuid[];t public.torneos;
BEGIN
 SELECT * INTO t FROM torneos WHERE id=p_torneo_id;
 IF t.id IS NULL OR t.plan_nations IS NOT NULL OR jsonb_typeof(p_jugadores) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Generic sporting roster context required';END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_jugadores) j WHERE j->>'participante_id' IS NULL OR NOT EXISTS(SELECT 1 FROM torneo_participantes p WHERE p.id::text=j->>'participante_id' AND p.torneo_id=t.id AND p.sede_id=t.sede_id AND p.tipo_identidad=j->>'tipo_identidad' AND coalesce(p.nombre,'')=coalesce(j->>'nombre',''))) THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Only exact persisted sporting participants may form a generic selection';END IF;
 SELECT array_agg(coalesce(j->>'user_id',j->>'id',j->>'participante_id')::uuid) INTO refs FROM jsonb_array_elements(p_jugadores)j;
 IF array_position(refs,NULL) IS NOT NULL OR cardinality(refs)<>(SELECT count(DISTINCT x) FROM unnest(refs)x) THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Unique sporting references required';END IF;
 RETURN refs;
END $$;
REVOKE ALL ON FUNCTION public.referencias_plantel_general(bigint,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.referencias_plantel_general(bigint,jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.proteger_planteles_selecciones() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE t public.torneos; e public.equipos; m public.partidos; row_mode text; ids uuid[]; members uuid[]; marker_exists boolean:=false;
BEGIN
 IF TG_TABLE_NAME='torneos' THEN
  IF TG_OP='DELETE' THEN row_mode:=OLD.modalidad_plantel; ELSE row_mode:=NEW.modalidad_plantel; END IF;
  IF row_mode='selecciones' OR (TG_OP='UPDATE' AND OLD.modalidad_plantel='selecciones') THEN
   IF current_user NOT IN('service_role','postgres','supabase_admin') THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Use authenticated national-team API'; END IF;
   IF TG_OP<>'DELETE' AND NEW.estado='en_curso' AND EXISTS(SELECT 1 FROM public.equipos WHERE torneo_id=NEW.id AND (inscripcion_estado IS DISTINCT FROM 'confirmado' OR jsonb_array_length(jugadores)<4)) THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='All national teams require four confirmed players'; END IF;
   IF TG_OP='UPDATE' AND OLD.estado='finalizado' AND OLD.estado IS DISTINCT FROM NEW.estado THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Closed national tournament is frozen'; END IF;
   IF TG_OP<>'DELETE' AND NEW.estado='finalizado' AND (TG_OP='INSERT' OR OLD.estado IS DISTINCT FROM NEW.estado) AND current_setting('padbol.national_close_rpc',true) IS DISTINCT FROM '1' THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Use atomic national tournament closure'; END IF;
   IF TG_OP='UPDATE' AND OLD.modalidad_plantel IS DISTINCT FROM NEW.modalidad_plantel AND EXISTS(SELECT 1 FROM public.equipos WHERE torneo_id=OLD.id) THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Roster mode already in use'; END IF;
  END IF;
 ELSIF TG_TABLE_NAME='equipos' THEN
  SELECT * INTO t FROM public.torneos WHERE id=CASE WHEN TG_OP='DELETE' THEN OLD.torneo_id ELSE NEW.torneo_id END;
  IF t.modalidad_plantel='selecciones' OR (TG_OP='UPDATE' AND EXISTS(SELECT 1 FROM public.torneos WHERE id=OLD.torneo_id AND modalidad_plantel='selecciones')) THEN
   IF current_user NOT IN('service_role','postgres','supabase_admin') THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Use authenticated national-team API'; END IF;
   IF TG_OP='UPDATE' AND NEW.torneo_id IS DISTINCT FROM OLD.torneo_id THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='National roster cannot change tournament'; END IF;
   IF TG_OP<>'DELETE' THEN
    NEW.modalidad_plantel:='selecciones';
    IF (TG_OP='INSERT' AND NEW.participantes_ranking IS NOT NULL OR TG_OP='UPDATE' AND OLD.participantes_ranking IS DISTINCT FROM NEW.participantes_ranking) AND current_setting('padbol.national_close_rpc',true) IS DISTINCT FROM '1' THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Ranking participants are closure-owned'; END IF;
    IF NEW.creador_id IS NULL OR NEW.cupo_maximo IS NULL OR NEW.cupo_maximo NOT BETWEEN 4 AND 8 OR jsonb_typeof(NEW.jugadores) IS DISTINCT FROM 'array' OR jsonb_array_length(NEW.jugadores) NOT BETWEEN 1 AND NEW.cupo_maximo THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Invalid national roster'; END IF;
    IF t.plan_nations IS NULL AND EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.jugadores)j WHERE j ? 'participante_id') THEN
     ids:=public.referencias_plantel_general(t.id,NEW.jugadores);
     IF EXISTS(SELECT 1 FROM equipos x CROSS JOIN LATERAL jsonb_array_elements(x.jugadores)j WHERE x.torneo_id=t.id AND x.id IS DISTINCT FROM NEW.id AND coalesce(j->>'user_id',j->>'id',j->>'participante_id')=ANY(SELECT v::text FROM unnest(ids)v)) THEN RAISE EXCEPTION USING ERRCODE='23505',MESSAGE='Sporting participant belongs to another selection';END IF;
    ELSE
    SELECT array_agg(coalesce(j->>'user_id',j->>'id')::uuid) INTO ids FROM jsonb_array_elements(NEW.jugadores) j;
    IF array_position(ids,NULL) IS NOT NULL OR cardinality(ids)<>(SELECT count(DISTINCT x) FROM unnest(ids) x) OR (SELECT count(DISTINCT user_id) FROM public.jugadores_perfil WHERE user_id=ANY(ids))<>cardinality(ids) THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Registered unique players required'; END IF;
    IF EXISTS(SELECT 1 FROM public.equipos x CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(x.jugadores)='array' THEN x.jugadores ELSE '[]'::jsonb END) j WHERE x.torneo_id=NEW.torneo_id AND x.id IS DISTINCT FROM NEW.id AND coalesce(j->>'user_id',j->>'id')=ANY(SELECT v::text FROM unnest(ids) v)) THEN RAISE EXCEPTION USING ERRCODE='23505',MESSAGE='Player belongs to another national roster'; END IF;
    IF NOT NEW.creador_id=ANY(ids) OR (NEW.inscripcion_estado='confirmado' AND cardinality(ids)<4) THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Four players required for competition'; END IF;
    END IF;
   END IF;
   IF TG_OP='UPDATE' AND (OLD.jugadores IS DISTINCT FROM NEW.jugadores OR OLD.creador_id IS DISTINCT FROM NEW.creador_id OR OLD.torneo_id IS DISTINCT FROM NEW.torneo_id) AND EXISTS(SELECT 1 FROM public.torneo_partido_alineaciones WHERE equipo_id=OLD.id) THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Roster referenced by declared lineup'; END IF;
  ELSE
   -- These new metadata fields are derived from the actual tournament, not client-controlled.
   IF TG_OP<>'DELETE' THEN NEW.modalidad_plantel:='dobles'; NEW.participantes_ranking:=NULL; END IF;
  END IF;
 ELSIF TG_TABLE_NAME='torneo_partido_alineaciones' THEN
  SELECT * INTO m FROM public.partidos WHERE id=NEW.partido_id;
  SELECT * INTO t FROM public.torneos WHERE id=NEW.torneo_id;
  SELECT * INTO e FROM public.equipos WHERE id=NEW.equipo_id;
  ids:=NEW.iniciales||NEW.suplentes;
  IF t.modalidad_plantel IS DISTINCT FROM 'selecciones' OR m.torneo_id IS DISTINCT FROM t.id OR e.torneo_id IS DISTINCT FROM t.id OR (e.id IS DISTINCT FROM m.equipo_a_id AND e.id IS DISTINCT FROM m.equipo_b_id)
   OR coalesce(t.estado,'') NOT IN('planificacion','proximo','inscripcion','abierto','inscripcion_abierta','en_curso') OR coalesce(m.estado,'') NOT IN('pendiente','programado') OR e.inscripcion_estado IS DISTINCT FROM 'confirmado'
   OR cardinality(ids)<>4 OR array_position(ids,NULL) IS NOT NULL OR (SELECT count(DISTINCT x) FROM unnest(ids) x)<>4 THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Invalid four-player lineup'; END IF;
  IF t.plan_nations IS NULL AND EXISTS(SELECT 1 FROM jsonb_array_elements(e.jugadores)j WHERE j ? 'participante_id') THEN PERFORM public.referencias_plantel_general(t.id,e.jugadores);END IF;
  SELECT array_agg((CASE WHEN t.plan_nations IS NULL THEN coalesce(j->>'user_id',j->>'id',j->>'participante_id') ELSE coalesce(j->>'user_id',j->>'id') END)::uuid) INTO members FROM jsonb_array_elements(e.jugadores) j WHERE coalesce(j->>'estado','confirmado') IN('confirmado','aceptado');
  IF to_regclass('public.scoreboard_partidos') IS NOT NULL THEN EXECUTE 'SELECT EXISTS(SELECT 1 FROM public.scoreboard_partidos WHERE partido_torneo_id=$1)' INTO marker_exists USING m.id; END IF;
  IF marker_exists OR NOT ids <@ coalesce(members,'{}'::uuid[]) OR EXISTS(SELECT 1 FROM public.torneo_partido_participacion WHERE partido_id=m.id) THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Lineup is not editable'; END IF;
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION public.proteger_marcador_seleccion() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE t public.torneos; m public.partidos; a public.torneo_partido_alineaciones; b public.torneo_partido_alineaciones; ea public.equipos; eb public.equipos;
BEGIN
 IF NEW.torneo_id IS NULL OR NEW.partido_torneo_id IS NULL THEN RETURN NEW; END IF;
 SELECT * INTO t FROM public.torneos WHERE id=NEW.torneo_id FOR UPDATE;
 IF t.modalidad_plantel IS DISTINCT FROM 'selecciones' THEN RETURN NEW; END IF;
 IF current_user NOT IN('service_role','postgres','supabase_admin') THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Use authorized tournament scoreboard API'; END IF;
 SELECT * INTO m FROM public.partidos WHERE id=NEW.partido_torneo_id FOR UPDATE;
 IF m.torneo_id IS DISTINCT FROM t.id OR coalesce(t.estado,'') NOT IN('planificacion','proximo','inscripcion','abierto','inscripcion_abierta','en_curso') THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Invalid scoreboard tournament'; END IF;
 SELECT * INTO a FROM public.torneo_partido_alineaciones WHERE partido_id=m.id AND equipo_id=m.equipo_a_id;
 SELECT * INTO b FROM public.torneo_partido_alineaciones WHERE partido_id=m.id AND equipo_id=m.equipo_b_id;
 IF a.partido_id IS NULL OR b.partido_id IS NULL THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Declare both four-player lineups before scoreboard'; END IF;
 SELECT * INTO ea FROM public.equipos WHERE id=m.equipo_a_id;
 SELECT * INTO eb FROM public.equipos WHERE id=m.equipo_b_id;
 SELECT jsonb_agg(j||jsonb_build_object('numero',i.ordinality,'jersey',i.ordinality) ORDER BY i.ordinality) INTO NEW.equipo_a_jugadores FROM unnest(a.iniciales||a.suplentes) WITH ORDINALITY i(user_id,ordinality) JOIN LATERAL jsonb_array_elements(ea.jugadores) j ON (CASE WHEN t.plan_nations IS NULL THEN coalesce(j->>'user_id',j->>'id',j->>'participante_id') ELSE coalesce(j->>'user_id',j->>'id') END)=i.user_id::text;
 SELECT jsonb_agg(j||jsonb_build_object('numero',i.ordinality,'jersey',i.ordinality) ORDER BY i.ordinality) INTO NEW.equipo_b_jugadores FROM unnest(b.iniciales||b.suplentes) WITH ORDINALITY i(user_id,ordinality) JOIN LATERAL jsonb_array_elements(eb.jugadores) j ON (CASE WHEN t.plan_nations IS NULL THEN coalesce(j->>'user_id',j->>'id',j->>'participante_id') ELSE coalesce(j->>'user_id',j->>'id') END)=i.user_id::text;
 IF jsonb_array_length(NEW.equipo_a_jugadores) IS DISTINCT FROM 4 OR jsonb_array_length(NEW.equipo_b_jugadores) IS DISTINCT FROM 4 THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Roster no longer confirms declared players'; END IF;
 RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION public.finalizar_torneo_seleccion(p_torneo_id bigint,p_actor_id uuid,p_puntos jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE t public.torneos; e public.equipos; point jsonb; eligible uuid[]; n integer; result_teams jsonb; result_status text:='finalized';
BEGIN
 SELECT * INTO t FROM public.torneos WHERE id=p_torneo_id FOR UPDATE;
 IF t.id IS NULL OR t.modalidad_plantel IS DISTINCT FROM 'selecciones' OR p_actor_id IS NULL OR coalesce(t.estado,'') NOT IN('planificacion','proximo','inscripcion','abierto','inscripcion_abierta','en_curso','finalizado') THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Invalid national closure context'; END IF;
 PERFORM id FROM public.partidos WHERE torneo_id=t.id ORDER BY id FOR UPDATE;
 PERFORM id FROM public.equipos WHERE torneo_id=t.id ORDER BY id FOR UPDATE;
 SELECT count(*) INTO n FROM public.equipos WHERE torneo_id=t.id;
 IF n<2 OR jsonb_typeof(p_puntos) IS DISTINCT FROM 'array' OR jsonb_array_length(p_puntos)<>n
 OR (SELECT count(DISTINCT (p->>'equipo_id')::bigint) FROM jsonb_array_elements(p_puntos) p)<>n
 OR (SELECT count(DISTINCT (p->>'posicion')::int) FROM jsonb_array_elements(p_puntos) p)<>n
 OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_puntos) p WHERE (p->>'torneo_id')::bigint IS DISTINCT FROM t.id OR (p->>'equipo_id') IS NULL OR (p->>'posicion') IS NULL OR (p->>'puntos') IS NULL OR (p->>'posicion')::int NOT BETWEEN 1 AND n OR (p->>'puntos')::int<0 OR NOT EXISTS(SELECT 1 FROM public.equipos WHERE id=(p->>'equipo_id')::bigint AND torneo_id=t.id)) THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Invalid team points snapshot'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.partidos WHERE torneo_id=t.id) OR EXISTS(
  SELECT 1 FROM public.partidos m LEFT JOIN public.torneo_partido_participacion h ON h.partido_id=m.id
  WHERE m.torneo_id=t.id AND (m.estado IS DISTINCT FROM 'finalizado' OR h.partido_id IS NULL OR h.torneo_id IS DISTINCT FROM t.id OR h.equipo_a_id IS DISTINCT FROM m.equipo_a_id OR h.equipo_b_id IS DISTINCT FROM m.equipo_b_id OR h.resultado_snapshot IS DISTINCT FROM m.resultado)
 ) THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Every result requires its declared participants'; END IF;
 IF t.estado='finalizado' THEN
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_puntos) p LEFT JOIN public.tabla_puntos q ON q.torneo_id=t.id AND q.equipo_id=(p->>'equipo_id')::bigint WHERE q.id IS NULL OR q.posicion IS DISTINCT FROM (p->>'posicion')::int OR q.puntos IS DISTINCT FROM (p->>'puntos')::int) THEN RAISE EXCEPTION USING ERRCODE='40001',MESSAGE='Closed point snapshot differs'; END IF;
  result_status:='idempotent';
 ELSE
  PERFORM set_config('padbol.national_close_rpc','1',true);
  FOR e IN SELECT * FROM public.equipos WHERE torneo_id=t.id ORDER BY id LOOP
   SELECT array_agg(DISTINCT player ORDER BY player) INTO eligible FROM (
    SELECT unnest(convocados_a) AS player FROM public.torneo_partido_participacion WHERE torneo_id=t.id AND equipo_a_id=e.id
    UNION ALL SELECT unnest(convocados_b) FROM public.torneo_partido_participacion WHERE torneo_id=t.id AND equipo_b_id=e.id
   ) participants;
   IF EXISTS(SELECT 1 FROM unnest(coalesce(eligible,'{}'::uuid[])) x WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(e.jugadores) j WHERE (CASE WHEN t.plan_nations IS NULL THEN coalesce(j->>'user_id',j->>'id',j->>'participante_id') ELSE coalesce(j->>'user_id',j->>'id') END)=x::text)) THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Participant outside frozen roster'; END IF;
   -- Sporting guest references remain in participation evidence, never as auth/ranking identities.
   IF t.plan_nations IS NULL THEN
    SELECT array_agg(x ORDER BY x) INTO eligible FROM unnest(coalesce(eligible,'{}'::uuid[]))x WHERE EXISTS(SELECT 1 FROM jsonb_array_elements(e.jugadores)j WHERE coalesce(j->>'user_id',j->>'id')=x::text) AND EXISTS(SELECT 1 FROM auth.users u WHERE u.id=x);
   END IF;
   SELECT p INTO point FROM jsonb_array_elements(p_puntos) p WHERE (p->>'equipo_id')::bigint=e.id;
   UPDATE public.equipos SET participantes_ranking=coalesce(eligible,'{}'::uuid[]),puntos_ranking=(point->>'puntos')::int WHERE id=e.id;
   INSERT INTO public.tabla_puntos(torneo_id,equipo_id,posicion,puntos) VALUES(t.id,e.id,(point->>'posicion')::int,(point->>'puntos')::int) ON CONFLICT(torneo_id,equipo_id) DO UPDATE SET posicion=EXCLUDED.posicion,puntos=EXCLUDED.puntos;
  END LOOP;
  PERFORM set_config('padbol.national_close_rpc','1',true);
  UPDATE public.torneos SET estado='finalizado',fecha_fin=(now() AT TIME ZONE 'UTC')::date,updated_at=now() WHERE id=t.id RETURNING * INTO t;
 END IF;
 SELECT jsonb_agg(to_jsonb(x) ORDER BY x.id) INTO result_teams FROM public.equipos x WHERE torneo_id=t.id;
 RETURN jsonb_build_object('ok',true,'status',result_status,'torneo_id',t.id,'torneo',to_jsonb(t),'equipos',result_teams);
END $$;
COMMIT;
