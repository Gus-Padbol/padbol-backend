-- Read-only production function snapshot, 19 Oct 2026. Isolated test fixture only.
CREATE OR REPLACE FUNCTION public.proteger_marcador_nations()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
END $function$
;
CREATE OR REPLACE FUNCTION public.proteger_marcador_seleccion()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
 SELECT jsonb_agg(j||jsonb_build_object('numero',i.ordinality,'jersey',i.ordinality) ORDER BY i.ordinality) INTO NEW.equipo_a_jugadores FROM unnest(a.iniciales||a.suplentes) WITH ORDINALITY i(user_id,ordinality) JOIN LATERAL jsonb_array_elements(ea.jugadores) j ON coalesce(j->>'user_id',j->>'id',j->>'participante_id')=i.user_id::text;
 SELECT jsonb_agg(j||jsonb_build_object('numero',i.ordinality,'jersey',i.ordinality) ORDER BY i.ordinality) INTO NEW.equipo_b_jugadores FROM unnest(b.iniciales||b.suplentes) WITH ORDINALITY i(user_id,ordinality) JOIN LATERAL jsonb_array_elements(eb.jugadores) j ON coalesce(j->>'user_id',j->>'id',j->>'participante_id')=i.user_id::text;
 IF jsonb_array_length(NEW.equipo_a_jugadores) IS DISTINCT FROM 4 OR jsonb_array_length(NEW.equipo_b_jugadores) IS DISTINCT FROM 4 THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Roster no longer confirms declared players'; END IF;
 RETURN NEW;
END $function$
;
CREATE OR REPLACE FUNCTION public.proteger_resultado_fixture_planificado()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
BEGIN
 IF NEW.estado IN('en_curso','finalizado','terminado') AND EXISTS(SELECT 1 FROM torneo_fixture_planes f JOIN torneos t ON t.id=f.torneo_id WHERE t.id=NEW.torneo_id AND t.estado IN('abierto','inscripcion','inscripcion_abierta','proximo','planificacion')) THEN
  RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='Explicit tournament start required before scoring';
 END IF;
 RETURN NEW;
END $function$
;
DROP TRIGGER IF EXISTS proteger_marcador_nations ON scoreboard_partidos;
CREATE TRIGGER proteger_marcador_nations BEFORE INSERT OR UPDATE ON scoreboard_partidos FOR EACH ROW EXECUTE FUNCTION proteger_marcador_nations();
DROP TRIGGER IF EXISTS proteger_marcador_seleccion ON scoreboard_partidos;
CREATE TRIGGER proteger_marcador_seleccion BEFORE INSERT OR UPDATE ON scoreboard_partidos FOR EACH ROW EXECUTE FUNCTION proteger_marcador_seleccion();
