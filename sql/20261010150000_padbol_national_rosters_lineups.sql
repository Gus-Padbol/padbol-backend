BEGIN;
ALTER TABLE public.torneos ADD COLUMN IF NOT EXISTS modalidad_plantel text NOT NULL DEFAULT 'dobles';
ALTER TABLE public.equipos ADD COLUMN IF NOT EXISTS plantel_revision bigint NOT NULL DEFAULT 0;
ALTER TABLE public.equipos ADD COLUMN IF NOT EXISTS modalidad_plantel text NOT NULL DEFAULT 'dobles';
ALTER TABLE public.equipos ADD COLUMN IF NOT EXISTS participantes_ranking uuid[];
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='torneos_modalidad_plantel_check' AND conrelid='public.torneos'::regclass) THEN
  ALTER TABLE public.torneos ADD CONSTRAINT torneos_modalidad_plantel_check CHECK (modalidad_plantel IN ('dobles','selecciones') AND (modalidad_plantel <> 'selecciones' OR (deporte='padbol' AND coalesce(formato_equipo,'dobles')='dobles'))) NOT VALID;
 END IF;
END $$;
CREATE TABLE IF NOT EXISTS public.torneo_partido_alineaciones (
 partido_id bigint NOT NULL REFERENCES public.partidos(id),
 equipo_id bigint NOT NULL REFERENCES public.equipos(id),
 torneo_id bigint NOT NULL REFERENCES public.torneos(id),
 iniciales uuid[] NOT NULL CHECK(cardinality(iniciales)=2),
 suplentes uuid[] NOT NULL CHECK(cardinality(suplentes)=2),
 revision bigint NOT NULL CHECK(revision>0),
 actor_id uuid NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(partido_id,equipo_id)
);
CREATE INDEX IF NOT EXISTS torneo_partido_alineaciones_torneo_idx ON public.torneo_partido_alineaciones(torneo_id);
ALTER TABLE public.torneo_partido_alineaciones ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.torneo_partido_alineaciones FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE ON public.torneo_partido_alineaciones TO service_role;
CREATE OR REPLACE FUNCTION public.guardar_alineacion_seleccion(p_torneo_id bigint,p_partido_id bigint,p_equipo_id bigint,p_actor_id uuid,p_admin boolean,p_iniciales uuid[],p_suplentes uuid[],p_revision bigint)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE t public.torneos; m public.partidos; e public.equipos; a public.torneo_partido_alineaciones; ids uuid[]; members uuid[]; marker_exists boolean:=false;
BEGIN
 SELECT * INTO t FROM public.torneos WHERE id=p_torneo_id FOR UPDATE;
 SELECT * INTO m FROM public.partidos WHERE id=p_partido_id FOR UPDATE;
 SELECT * INTO e FROM public.equipos WHERE id=p_equipo_id FOR UPDATE;
 IF t.id IS NULL OR m.id IS NULL OR e.id IS NULL OR t.modalidad_plantel<>'selecciones' OR t.deporte<>'padbol'
  OR m.torneo_id<>t.id OR e.torneo_id<>t.id OR (p_equipo_id IS DISTINCT FROM m.equipo_a_id AND p_equipo_id IS DISTINCT FROM m.equipo_b_id)
  OR coalesce(p_admin,false)=false AND e.creador_id IS DISTINCT FROM p_actor_id
  OR coalesce(m.estado,'') NOT IN('pendiente','programado') OR coalesce(t.estado,'') NOT IN('planificacion','proximo','inscripcion','abierto','inscripcion_abierta','en_curso') OR e.inscripcion_estado IS DISTINCT FROM 'confirmado' OR p_actor_id IS NULL THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Invalid lineup context'; END IF;
 IF to_regclass('public.scoreboard_partidos') IS NOT NULL THEN EXECUTE 'SELECT EXISTS(SELECT 1 FROM public.scoreboard_partidos WHERE partido_torneo_id=$1)' INTO marker_exists USING m.id; END IF;
 IF marker_exists THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Scoreboard already freezes declared lineup'; END IF;
 IF p_revision IS NULL OR p_revision<0 OR p_iniciales IS NULL OR p_suplentes IS NULL OR cardinality(p_iniciales)<>2 OR cardinality(p_suplentes)<>2 THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Exactly four players required'; END IF;
 ids:=p_iniciales||p_suplentes;
 IF cardinality(ids)<>4 OR (SELECT count(DISTINCT x) FROM unnest(ids) x)<>4 THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Duplicate lineup players'; END IF;
 IF jsonb_typeof(e.jugadores) IS DISTINCT FROM 'array' OR jsonb_array_length(e.jugadores)<4 OR jsonb_array_length(e.jugadores)>8 THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Invalid roster size'; END IF;
 SELECT array_agg(coalesce(j->>'user_id',j->>'id')::uuid) INTO members FROM jsonb_array_elements(e.jugadores) j WHERE coalesce(j->>'estado','confirmado') IN('confirmado','aceptado');
 IF NOT ids <@ coalesce(members,'{}'::uuid[]) OR cardinality(members)<>(SELECT count(DISTINCT x) FROM unnest(members) x) THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Players outside roster'; END IF;
 SELECT * INTO a FROM public.torneo_partido_alineaciones WHERE partido_id=m.id AND equipo_id=e.id FOR UPDATE;
 IF coalesce(a.revision,0)<>p_revision THEN RAISE EXCEPTION USING ERRCODE='40001',MESSAGE='Lineup revision changed'; END IF;
 INSERT INTO public.torneo_partido_alineaciones(partido_id,equipo_id,torneo_id,iniciales,suplentes,revision,actor_id)
 VALUES(m.id,e.id,t.id,p_iniciales,p_suplentes,p_revision+1,p_actor_id)
 ON CONFLICT(partido_id,equipo_id) DO UPDATE SET iniciales=EXCLUDED.iniciales,suplentes=EXCLUDED.suplentes,revision=EXCLUDED.revision,actor_id=EXCLUDED.actor_id,updated_at=now()
 RETURNING * INTO a;
 RETURN to_jsonb(a);
END $$;
CREATE OR REPLACE FUNCTION public.guardar_plantel_seleccion(p_torneo_id bigint,p_equipo_id bigint,p_actor_id uuid,p_admin boolean,p_accion text,p_nombre text,p_cupo integer,p_abierto boolean,p_user_ids uuid[],p_revision bigint)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE t public.torneos; e public.equipos; players jsonb; applicant jsonb; requests jsonb; accepted uuid[]; selected uuid; result_status text:='saved';
BEGIN
 SELECT * INTO t FROM public.torneos WHERE id=p_torneo_id FOR UPDATE;
 IF t.id IS NULL OR t.modalidad_plantel<>'selecciones' OR t.deporte<>'padbol' OR p_actor_id IS NULL
  OR coalesce(t.estado,'') NOT IN('planificacion','proximo','inscripcion','abierto','inscripcion_abierta') OR p_accion IS NULL OR p_accion NOT IN('crear','solicitar','plantel','confirmar') THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Invalid roster context'; END IF;
 SELECT jsonb_build_object('id',user_id,'user_id',user_id,'nombre',concat_ws(' ',nombre,apellido),'email',email,'estado','confirmado') INTO applicant FROM public.jugadores_perfil WHERE user_id=p_actor_id;
 IF p_accion IN('crear','solicitar') AND applicant IS NULL THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Registered player required'; END IF;
 IF p_accion='crear' THEN
  IF p_cupo IS NULL OR p_cupo NOT BETWEEN 4 AND 8 OR p_nombre IS NULL OR length(btrim(p_nombre)) NOT BETWEEN 1 AND 120 THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Invalid team'; END IF;
  IF EXISTS(SELECT 1 FROM public.equipos x CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(x.jugadores)='array' THEN x.jugadores ELSE '[]'::jsonb END) j WHERE x.torneo_id=t.id AND coalesce(j->>'user_id',j->>'id')=p_actor_id::text) THEN RAISE EXCEPTION USING ERRCODE='23505',MESSAGE='Already on tournament roster'; END IF;
  INSERT INTO public.equipos(torneo_id,sede_id,nombre,creador_id,jugadores,solicitudes,cupo_maximo,equipo_abierto,tipo_equipo,plantel_revision)
  VALUES(t.id,t.sede_id,btrim(p_nombre),p_actor_id,jsonb_build_array(applicant),'[]',p_cupo,coalesce(p_abierto,false),'dobles',1) RETURNING * INTO e;
 ELSE
  SELECT * INTO e FROM public.equipos WHERE id=p_equipo_id FOR UPDATE;
  IF e.id IS NULL OR e.torneo_id<>t.id THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Team outside tournament'; END IF;
  IF EXISTS(SELECT 1 FROM public.torneo_partido_alineaciones WHERE equipo_id=e.id) OR EXISTS(SELECT 1 FROM public.partidos WHERE torneo_id=t.id AND (equipo_a_id=e.id OR equipo_b_id=e.id) AND estado NOT IN('pendiente','programado')) THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Roster already used by match'; END IF;
  IF p_accion='confirmar' THEN
   IF (coalesce(p_admin,false)=false AND e.creador_id IS DISTINCT FROM p_actor_id) OR p_revision IS NULL OR p_revision<>e.plantel_revision THEN RAISE EXCEPTION USING ERRCODE='40001',MESSAGE='Cannot confirm current roster'; END IF;
   IF jsonb_typeof(e.jugadores) IS DISTINCT FROM 'array' OR jsonb_array_length(e.jugadores) NOT BETWEEN 4 AND least(8,e.cupo_maximo) OR (SELECT count(DISTINCT coalesce(j->>'user_id',j->>'id')) FROM jsonb_array_elements(e.jugadores) j)<>jsonb_array_length(e.jugadores) THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Four confirmed players required'; END IF;
   IF (t.costo_inscripcion IS NULL AND t.inscripcion_monto IS NULL) OR coalesce(t.costo_inscripcion,0)<>0 OR coalesce(t.inscripcion_monto,0)<>0 THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Paid enrollment not supported by roster endpoint'; END IF;
   IF e.inscripcion_estado='confirmado' THEN result_status:='idempotent'; ELSE UPDATE public.equipos SET inscripcion_estado='confirmado',plantel_revision=plantel_revision+1 WHERE id=e.id RETURNING * INTO e; END IF;
  ELSIF p_accion='solicitar' THEN
   IF e.equipo_abierto IS DISTINCT FROM true OR jsonb_array_length(e.jugadores)>=e.cupo_maximo THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Team not accepting requests'; END IF;
   IF EXISTS(SELECT 1 FROM public.equipos x CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(x.jugadores)='array' THEN x.jugadores ELSE '[]'::jsonb END) j WHERE x.torneo_id=t.id AND coalesce(j->>'user_id',j->>'id')=p_actor_id::text) THEN RAISE EXCEPTION USING ERRCODE='23505',MESSAGE='Already on tournament roster'; END IF;
   IF EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(e.solicitudes,'[]'::jsonb)) j WHERE coalesce(j->>'user_id',j->>'id')=p_actor_id::text) THEN result_status:='idempotent';
   ELSE UPDATE public.equipos SET solicitudes=coalesce(solicitudes,'[]'::jsonb)||jsonb_build_array(applicant),plantel_revision=plantel_revision+1 WHERE id=e.id RETURNING * INTO e; END IF;
  ELSE
   IF coalesce(p_admin,false)=false AND e.creador_id IS DISTINCT FROM p_actor_id THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Not captain'; END IF;
   IF p_revision IS NULL OR p_revision<>e.plantel_revision THEN RAISE EXCEPTION USING ERRCODE='40001',MESSAGE='Roster revision changed'; END IF;
   IF p_user_ids IS NULL OR array_position(p_user_ids,NULL) IS NOT NULL OR cardinality(p_user_ids) NOT BETWEEN 1 AND least(8,e.cupo_maximo) OR (SELECT count(DISTINCT x) FROM unnest(p_user_ids) x)<>cardinality(p_user_ids) OR NOT e.creador_id=ANY(p_user_ids) THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Invalid roster members'; END IF;
   FOREACH selected IN ARRAY p_user_ids LOOP
    IF coalesce(p_admin,false)=false AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(e.jugadores,'[]'::jsonb)||coalesce(e.solicitudes,'[]'::jsonb)) j WHERE coalesce(j->>'user_id',j->>'id')=selected::text) THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Player did not request membership'; END IF;
    IF EXISTS(SELECT 1 FROM public.equipos x CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(x.jugadores)='array' THEN x.jugadores ELSE '[]'::jsonb END) j WHERE x.torneo_id=t.id AND x.id<>e.id AND coalesce(j->>'user_id',j->>'id')=selected::text) THEN RAISE EXCEPTION USING ERRCODE='23505',MESSAGE='Player on another roster'; END IF;
   END LOOP;
   SELECT jsonb_agg(jsonb_build_object('id',p.user_id,'user_id',p.user_id,'nombre',concat_ws(' ',p.nombre,p.apellido),'email',p.email,'estado','confirmado') ORDER BY a.position) INTO players FROM unnest(p_user_ids) WITH ORDINALITY a(user_id,position) JOIN public.jugadores_perfil p ON p.user_id=a.user_id;
   IF jsonb_array_length(players) IS DISTINCT FROM cardinality(p_user_ids) THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Unknown player'; END IF;
   SELECT coalesce(jsonb_agg(j),'[]') INTO requests FROM jsonb_array_elements(coalesce(e.solicitudes,'[]'::jsonb)) j WHERE NOT coalesce(j->>'user_id',j->>'id')::uuid=ANY(p_user_ids);
   UPDATE public.equipos SET jugadores=players,solicitudes=requests,inscripcion_estado='pendiente',plantel_revision=plantel_revision+1 WHERE id=e.id RETURNING * INTO e;
  END IF;
 END IF;
 RETURN jsonb_build_object('status',result_status,'equipo',to_jsonb(e));
END $$;
REVOKE ALL ON FUNCTION public.guardar_alineacion_seleccion(bigint,bigint,bigint,uuid,boolean,uuid[],uuid[],bigint),public.guardar_plantel_seleccion(bigint,bigint,uuid,boolean,text,text,integer,boolean,uuid[],bigint) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.guardar_alineacion_seleccion(bigint,bigint,bigint,uuid,boolean,uuid[],uuid[],bigint),public.guardar_plantel_seleccion(bigint,bigint,uuid,boolean,text,text,integer,boolean,uuid[],bigint) TO service_role;

-- Four declared convocados per side are historical evidence, not measured playing time.
CREATE TABLE IF NOT EXISTS public.torneo_partido_participacion (
 partido_id bigint PRIMARY KEY REFERENCES public.partidos(id), torneo_id bigint NOT NULL REFERENCES public.torneos(id),
 equipo_a_id bigint NOT NULL REFERENCES public.equipos(id), equipo_b_id bigint NOT NULL REFERENCES public.equipos(id),
 convocados_a uuid[] NOT NULL CHECK(cardinality(convocados_a)=4), convocados_b uuid[] NOT NULL CHECK(cardinality(convocados_b)=4),
 alineacion_revision_a bigint NOT NULL, alineacion_revision_b bigint NOT NULL,
 procedencia text NOT NULL CHECK(procedencia='alineacion_convocada'), resultado_snapshot jsonb NOT NULL,
 fuente text NOT NULL CHECK(fuente IN('manual_admin','scoreboard')), actor_id uuid, registrado_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.torneo_partido_participacion ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.torneo_partido_participacion FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT ON public.torneo_partido_participacion TO service_role;
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
    SELECT array_agg(coalesce(j->>'user_id',j->>'id')::uuid) INTO ids FROM jsonb_array_elements(NEW.jugadores) j;
    IF array_position(ids,NULL) IS NOT NULL OR cardinality(ids)<>(SELECT count(DISTINCT x) FROM unnest(ids) x) OR (SELECT count(DISTINCT user_id) FROM public.jugadores_perfil WHERE user_id=ANY(ids))<>cardinality(ids) THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Registered unique players required'; END IF;
    IF EXISTS(SELECT 1 FROM public.equipos x CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(x.jugadores)='array' THEN x.jugadores ELSE '[]'::jsonb END) j WHERE x.torneo_id=NEW.torneo_id AND x.id IS DISTINCT FROM NEW.id AND coalesce(j->>'user_id',j->>'id')=ANY(SELECT v::text FROM unnest(ids) v)) THEN RAISE EXCEPTION USING ERRCODE='23505',MESSAGE='Player belongs to another national roster'; END IF;
    IF NOT NEW.creador_id=ANY(ids) OR (NEW.inscripcion_estado='confirmado' AND cardinality(ids)<4) THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Four players required for competition'; END IF;
   END IF;
   IF TG_OP='UPDATE' AND (OLD.jugadores IS DISTINCT FROM NEW.jugadores OR OLD.creador_id IS DISTINCT FROM NEW.creador_id OR OLD.torneo_id IS DISTINCT FROM NEW.torneo_id) AND EXISTS(SELECT 1 FROM public.torneo_partido_alineaciones WHERE equipo_id=OLD.id) THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Roster referenced by declared lineup'; END IF;
  END IF;
 ELSIF TG_TABLE_NAME='torneo_partido_alineaciones' THEN
  SELECT * INTO m FROM public.partidos WHERE id=NEW.partido_id;
  SELECT * INTO t FROM public.torneos WHERE id=NEW.torneo_id;
  SELECT * INTO e FROM public.equipos WHERE id=NEW.equipo_id;
  ids:=NEW.iniciales||NEW.suplentes;
  IF t.modalidad_plantel IS DISTINCT FROM 'selecciones' OR m.torneo_id IS DISTINCT FROM t.id OR e.torneo_id IS DISTINCT FROM t.id OR (e.id IS DISTINCT FROM m.equipo_a_id AND e.id IS DISTINCT FROM m.equipo_b_id)
   OR coalesce(t.estado,'') NOT IN('planificacion','proximo','inscripcion','abierto','inscripcion_abierta','en_curso') OR coalesce(m.estado,'') NOT IN('pendiente','programado') OR e.inscripcion_estado IS DISTINCT FROM 'confirmado'
   OR cardinality(ids)<>4 OR array_position(ids,NULL) IS NOT NULL OR (SELECT count(DISTINCT x) FROM unnest(ids) x)<>4 THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Invalid four-player lineup'; END IF;
  SELECT array_agg(coalesce(j->>'user_id',j->>'id')::uuid) INTO members FROM jsonb_array_elements(e.jugadores) j WHERE coalesce(j->>'estado','confirmado') IN('confirmado','aceptado');
  IF to_regclass('public.scoreboard_partidos') IS NOT NULL THEN EXECUTE 'SELECT EXISTS(SELECT 1 FROM public.scoreboard_partidos WHERE partido_torneo_id=$1)' INTO marker_exists USING m.id; END IF;
  IF marker_exists OR NOT ids <@ coalesce(members,'{}'::uuid[]) OR EXISTS(SELECT 1 FROM public.torneo_partido_participacion WHERE partido_id=m.id) THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Lineup is not editable'; END IF;
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS proteger_selecciones_torneos ON public.torneos;
CREATE TRIGGER proteger_selecciones_torneos BEFORE INSERT OR UPDATE OR DELETE ON public.torneos FOR EACH ROW EXECUTE FUNCTION public.proteger_planteles_selecciones();
DROP TRIGGER IF EXISTS proteger_selecciones_equipos ON public.equipos;
CREATE TRIGGER proteger_selecciones_equipos BEFORE INSERT OR UPDATE OR DELETE ON public.equipos FOR EACH ROW EXECUTE FUNCTION public.proteger_planteles_selecciones();
DROP TRIGGER IF EXISTS proteger_selecciones_alineaciones ON public.torneo_partido_alineaciones;
CREATE TRIGGER proteger_selecciones_alineaciones BEFORE INSERT OR UPDATE ON public.torneo_partido_alineaciones FOR EACH ROW EXECUTE FUNCTION public.proteger_planteles_selecciones();
CREATE OR REPLACE FUNCTION public.finalizar_partido_seleccion(p_partido_id bigint,p_resultado jsonb,p_actor_id uuid,p_fuente text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE m public.partidos; t public.torneos; a public.torneo_partido_alineaciones; b public.torneo_partido_alineaciones; winner bigint; sa integer; sb integer;
BEGIN
 SELECT * INTO m FROM public.partidos WHERE id=p_partido_id;
 SELECT * INTO t FROM public.torneos WHERE id=m.torneo_id FOR UPDATE;
 SELECT * INTO m FROM public.partidos WHERE id=p_partido_id FOR UPDATE;
 IF m.torneo_id IS DISTINCT FROM t.id THEN RAISE EXCEPTION USING ERRCODE='40001',MESSAGE='Match context changed'; END IF;
 IF m.id IS NULL OR t.modalidad_plantel IS DISTINCT FROM 'selecciones' OR coalesce(t.estado,'') NOT IN('planificacion','proximo','inscripcion','abierto','inscripcion_abierta','en_curso','finalizado') OR p_fuente NOT IN('manual_admin','scoreboard') OR p_fuente IS NULL OR (p_fuente='manual_admin' AND p_actor_id IS NULL) THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Invalid national result context'; END IF;
 SELECT * INTO a FROM public.torneo_partido_alineaciones WHERE partido_id=m.id AND equipo_id=m.equipo_a_id FOR UPDATE;
 SELECT * INTO b FROM public.torneo_partido_alineaciones WHERE partido_id=m.id AND equipo_id=m.equipo_b_id FOR UPDATE;
 IF a.partido_id IS NULL OR b.partido_id IS NULL THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Both four-player lineups required'; END IF;
 IF jsonb_typeof(p_resultado->'goles_a') IS DISTINCT FROM 'number' OR jsonb_typeof(p_resultado->'goles_b') IS DISTINCT FROM 'number' THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Invalid sets'; END IF;
 sa:=(p_resultado->>'goles_a')::integer; sb:=(p_resultado->>'goles_b')::integer;
 IF NOT ((sa=2 AND sb IN(0,1)) OR (sb=2 AND sa IN(0,1))) THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Winner required'; END IF;
 winner:=CASE WHEN sa>sb THEN m.equipo_a_id ELSE m.equipo_b_id END;
 IF m.estado='finalizado' THEN
  IF m.resultado=p_resultado AND m.ganador_equipo_id=winner AND EXISTS(SELECT 1 FROM public.torneo_partido_participacion WHERE partido_id=m.id) THEN RETURN jsonb_build_object('ok',true,'status','idempotent','partido_id',m.id,'torneo_id',m.torneo_id,'ganador_equipo_id',winner); END IF;
  RAISE EXCEPTION USING ERRCODE='40001',MESSAGE='Final result is already frozen';
 END IF;
 IF t.estado='finalizado' OR coalesce(m.estado,'') NOT IN('pendiente','programado','en_curso') THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Match not playable'; END IF;
 PERFORM set_config('padbol.national_final_rpc','1',true);
 UPDATE public.partidos SET estado='finalizado',resultado=p_resultado,ganador_equipo_id=winner WHERE id=m.id;
 INSERT INTO public.torneo_partido_participacion(partido_id,torneo_id,equipo_a_id,equipo_b_id,convocados_a,convocados_b,alineacion_revision_a,alineacion_revision_b,procedencia,resultado_snapshot,fuente,actor_id)
 VALUES(m.id,m.torneo_id,m.equipo_a_id,m.equipo_b_id,a.iniciales||a.suplentes,b.iniciales||b.suplentes,a.revision,b.revision,'alineacion_convocada',p_resultado,p_fuente,p_actor_id);
 RETURN jsonb_build_object('ok',true,'status','finalized','partido_id',m.id,'torneo_id',m.torneo_id,'ganador_equipo_id',winner);
END $$;
REVOKE ALL ON FUNCTION public.finalizar_partido_seleccion(bigint,jsonb,uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.finalizar_partido_seleccion(bigint,jsonb,uuid,text) TO service_role;
CREATE OR REPLACE FUNCTION public.proteger_resultado_seleccion() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
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
END $$;
DROP TRIGGER IF EXISTS proteger_selecciones_resultado ON public.partidos;
CREATE TRIGGER proteger_selecciones_resultado BEFORE INSERT OR UPDATE ON public.partidos FOR EACH ROW EXECUTE FUNCTION public.proteger_resultado_seleccion();

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
 SELECT jsonb_agg(j||jsonb_build_object('numero',i.ordinality,'jersey',i.ordinality) ORDER BY i.ordinality) INTO NEW.equipo_a_jugadores FROM unnest(a.iniciales||a.suplentes) WITH ORDINALITY i(user_id,ordinality) JOIN LATERAL jsonb_array_elements(ea.jugadores) j ON coalesce(j->>'user_id',j->>'id')=i.user_id::text;
 SELECT jsonb_agg(j||jsonb_build_object('numero',i.ordinality,'jersey',i.ordinality) ORDER BY i.ordinality) INTO NEW.equipo_b_jugadores FROM unnest(b.iniciales||b.suplentes) WITH ORDINALITY i(user_id,ordinality) JOIN LATERAL jsonb_array_elements(eb.jugadores) j ON coalesce(j->>'user_id',j->>'id')=i.user_id::text;
 IF jsonb_array_length(NEW.equipo_a_jugadores) IS DISTINCT FROM 4 OR jsonb_array_length(NEW.equipo_b_jugadores) IS DISTINCT FROM 4 THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Roster no longer confirms declared players'; END IF;
 RETURN NEW;
END $$;
DO $$ BEGIN IF to_regclass('public.scoreboard_partidos') IS NOT NULL THEN
 DROP TRIGGER IF EXISTS proteger_selecciones_marcador ON public.scoreboard_partidos;
 CREATE TRIGGER proteger_selecciones_marcador BEFORE INSERT OR UPDATE ON public.scoreboard_partidos FOR EACH ROW EXECUTE FUNCTION public.proteger_marcador_seleccion();
END IF; END $$;
-- Optional legacy manual-date ledger only accepts two per side; never write false
-- eight-player participation through that ledger for the new mode.
CREATE OR REPLACE FUNCTION public.proteger_fecha_legacy_seleccion() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM public.torneos WHERE id=NEW.torneo_id AND modalidad_plantel='selecciones') THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='National match participation uses persisted declared lineup, not legacy doubles ledger'; END IF;
 RETURN NEW;
END $$;
DO $$ BEGIN IF to_regclass('public.partido_fecha_juego') IS NOT NULL THEN
 DROP TRIGGER IF EXISTS proteger_selecciones_fecha_legacy ON public.partido_fecha_juego;
 CREATE TRIGGER proteger_selecciones_fecha_legacy BEFORE INSERT OR UPDATE ON public.partido_fecha_juego FOR EACH ROW EXECUTE FUNCTION public.proteger_fecha_legacy_seleccion();
END IF; END $$;

-- Preserve the existing server-computed team point formula, snapshot only declared participants.
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
   IF EXISTS(SELECT 1 FROM unnest(coalesce(eligible,'{}'::uuid[])) x WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(e.jugadores) j WHERE coalesce(j->>'user_id',j->>'id')=x::text)) THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Participant outside frozen roster'; END IF;
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
REVOKE ALL ON FUNCTION public.finalizar_torneo_seleccion(bigint,uuid,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.finalizar_torneo_seleccion(bigint,uuid,jsonb) TO service_role;

COMMIT;
