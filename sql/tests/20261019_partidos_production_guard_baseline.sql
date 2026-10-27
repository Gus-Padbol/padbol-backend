-- Exact read-only production snapshot, 19 Oct 2026. Isolated testing only.
CREATE OR REPLACE FUNCTION public.avanzar_perdedor_nations()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
END $function$
;
DROP TRIGGER IF EXISTS avanzar_perdedor_nations ON public.partidos;
CREATE TRIGGER avanzar_perdedor_nations AFTER UPDATE OF estado, ganador_equipo_id ON public.partidos FOR EACH ROW EXECUTE FUNCTION avanzar_perdedor_nations();
CREATE OR REPLACE FUNCTION public.proteger_plan_nations()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE t public.torneos; sets jsonb; sa integer; sb integer; detail jsonb; a integer; b integer;
BEGIN
 IF TG_TABLE_NAME='torneos' THEN
  IF TG_OP='UPDATE' AND OLD.plan_nations IS NOT NULL AND OLD.nivel_torneo IS DISTINCT FROM NEW.nivel_torneo THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Event points level is frozen once Nations is configured'; END IF;
  IF TG_OP='UPDATE' AND OLD.plan_nations IS NOT NULL AND current_user NOT IN('service_role','postgres','supabase_admin') THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Use scoped Nations event API'; END IF;
  IF TG_OP='UPDATE' AND OLD.plan_nations IS DISTINCT FROM NEW.plan_nations OR TG_OP='INSERT' AND NEW.plan_nations IS NOT NULL THEN
   IF current_user NOT IN('service_role','postgres','supabase_admin') OR current_setting('padbol.nations_rpc',true) IS DISTINCT FROM '1' THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Use Nations event API'; END IF;
  END IF;
  IF TG_OP='UPDATE' AND OLD.plan_nations->>'status' IN('groups','knockout','finalized') AND (OLD.fecha_inicio IS DISTINCT FROM NEW.fecha_inicio OR OLD.horas_revelar_equipos IS DISTINCT FROM NEW.horas_revelar_equipos) THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Public reveal clock is frozen after the draw'; END IF;
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
END $function$
;
DROP TRIGGER IF EXISTS proteger_plan_nations_partido ON public.partidos;
CREATE TRIGGER proteger_plan_nations_partido BEFORE INSERT OR DELETE OR UPDATE ON public.partidos FOR EACH ROW EXECUTE FUNCTION proteger_plan_nations();
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
DROP TRIGGER IF EXISTS proteger_resultado_fixture_planificado ON public.partidos;
CREATE TRIGGER proteger_resultado_fixture_planificado BEFORE UPDATE ON public.partidos FOR EACH ROW EXECUTE FUNCTION proteger_resultado_fixture_planificado();
CREATE OR REPLACE FUNCTION public.proteger_resultado_seleccion()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE mode text;
BEGIN
 SELECT modalidad_plantel INTO mode FROM public.torneos WHERE id=NEW.torneo_id;
 IF mode='selecciones' OR (TG_OP='UPDATE' AND EXISTS(SELECT 1 FROM public.torneos WHERE id=OLD.torneo_id AND modalidad_plantel='selecciones')) THEN
  IF current_user NOT IN('service_role','postgres','supabase_admin') THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Use national result API'; END IF;
  IF EXISTS(SELECT 1 FROM public.equipos WHERE id IN(NEW.equipo_a_id,NEW.equipo_b_id) AND (torneo_id IS DISTINCT FROM NEW.torneo_id OR inscripcion_estado IS DISTINCT FROM 'confirmado' OR jsonb_array_length(jugadores)<4)) THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='National competition requires confirmed teams'; END IF;
  IF TG_OP='UPDATE' AND EXISTS(SELECT 1 FROM public.torneo_partido_participacion WHERE partido_id=OLD.id) AND (NEW.estado IS DISTINCT FROM OLD.estado OR NEW.resultado IS DISTINCT FROM OLD.resultado OR NEW.ganador_equipo_id IS DISTINCT FROM OLD.ganador_equipo_id OR NEW.torneo_id IS DISTINCT FROM OLD.torneo_id OR NEW.equipo_a_id IS DISTINCT FROM OLD.equipo_a_id OR NEW.equipo_b_id IS DISTINCT FROM OLD.equipo_b_id) THEN RAISE EXCEPTION USING ERRCODE='40001',MESSAGE='National result history is frozen'; END IF;
  IF TG_OP='UPDATE' AND (NEW.torneo_id IS DISTINCT FROM OLD.torneo_id OR NEW.equipo_a_id IS DISTINCT FROM OLD.equipo_a_id OR NEW.equipo_b_id IS DISTINCT FROM OLD.equipo_b_id) AND EXISTS(SELECT 1 FROM public.torneo_partido_alineaciones WHERE partido_id=OLD.id) THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Declared match context is frozen'; END IF;
  IF NEW.estado='finalizado' AND (TG_OP='INSERT' OR OLD.estado IS DISTINCT FROM NEW.estado OR OLD.resultado IS DISTINCT FROM NEW.resultado OR OLD.ganador_equipo_id IS DISTINCT FROM NEW.ganador_equipo_id) AND current_setting('padbol.national_final_rpc',true) IS DISTINCT FROM '1' THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Atomic national result evidence required'; END IF;
  IF NEW.estado='en_curso' AND (SELECT count(*) FROM public.torneo_partido_alineaciones WHERE partido_id=NEW.id AND equipo_id IN(NEW.equipo_a_id,NEW.equipo_b_id))<>2 THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Both lineups required before play'; END IF;
 END IF;
 RETURN NEW;
END $function$
;
DROP TRIGGER IF EXISTS proteger_selecciones_resultado ON public.partidos;
CREATE TRIGGER proteger_selecciones_resultado BEFORE INSERT OR UPDATE ON public.partidos FOR EACH ROW EXECUTE FUNCTION proteger_resultado_seleccion();
CREATE OR REPLACE FUNCTION public.sync_linked_scoreboard_final_result()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE t public.torneos;sa integer;sb integer;winner bigint;
BEGIN
 IF NEW.estado IS DISTINCT FROM 'finalizado' THEN RETURN NEW;END IF;
 -- The scoreboard path may already contain exactly this terminal result. No second write.
 IF NOT EXISTS(SELECT 1 FROM public.scoreboard_partidos s WHERE s.partido_torneo_id=NEW.id AND s.torneo_id=NEW.torneo_id) THEN RETURN NEW;END IF;
 SELECT * INTO t FROM public.torneos WHERE id=NEW.torneo_id;
 IF t.deporte IS DISTINCT FROM 'padbol' THEN RETURN NEW;END IF;
 IF jsonb_typeof(NEW.resultado->'goles_a') IS DISTINCT FROM 'number' OR jsonb_typeof(NEW.resultado->'goles_b') IS DISTINCT FROM 'number' THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Linked Padbol scoreboard requires authoritative final sets';END IF;
 sa:=(NEW.resultado->>'goles_a')::integer;sb:=(NEW.resultado->>'goles_b')::integer;
 IF (NEW.resultado->>'goles_a')::numeric IS DISTINCT FROM sa::numeric OR (NEW.resultado->>'goles_b')::numeric IS DISTINCT FROM sb::numeric THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Final sets must be whole numbers';END IF;
 IF NOT((sa=2 AND sb IN(0,1))OR(sb=2 AND sa IN(0,1))) OR NEW.equipo_a_id IS NULL OR NEW.equipo_b_id IS NULL THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Linked Padbol scoreboard requires a completed best-of-three result';END IF;
 winner:=CASE WHEN sa>sb THEN NEW.equipo_a_id ELSE NEW.equipo_b_id END;
 IF NEW.ganador_equipo_id IS DISTINCT FROM winner THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Linked scoreboard winner differs from authoritative result';END IF;
 -- Updating scoreboard does not write partidos; ordinary score sync sees an identical result
 -- and is idempotent. Actual set games are copied only when supplied by the result.
 UPDATE public.scoreboard_partidos s SET estado='terminado',sets_a=sa,sets_b=sb,
  historial_sets=NEW.resultado->'historial_sets',sync_torneo_status='synced',synced_to_torneo_at=clock_timestamp()
 WHERE s.partido_torneo_id=NEW.id AND s.torneo_id=NEW.torneo_id
  AND(s.estado NOT IN('terminado','finalizado') OR s.sets_a IS DISTINCT FROM sa OR s.sets_b IS DISTINCT FROM sb OR s.historial_sets IS DISTINCT FROM NEW.resultado->'historial_sets' OR s.sync_torneo_status IS DISTINCT FROM 'synced');
 RETURN NEW;
END $function$
;
DROP TRIGGER IF EXISTS sync_linked_scoreboard_final_result ON public.partidos;
CREATE TRIGGER sync_linked_scoreboard_final_result AFTER UPDATE OF estado, resultado, ganador_equipo_id ON public.partidos FOR EACH ROW EXECUTE FUNCTION sync_linked_scoreboard_final_result();
