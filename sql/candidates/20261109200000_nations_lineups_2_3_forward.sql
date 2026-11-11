-- Forward-only candidate: Nations lineups with 2 starters and 0..2 real substitutes.
-- Preserves auth/CAS/idempotency/RLS/grants; compatible with 4-player lineups.
-- NOT APPLIED to production.
BEGIN;
DO $$
DECLARE f oid; sig text; owner oid; owner_expected oid; service_oid oid; secdef boolean; acl aclitem[]; pub_exec boolean;
BEGIN
 FOREACH sig IN ARRAY ARRAY[
  'public.guardar_alineacion_participantes(bigint,bigint,bigint,uuid,boolean,uuid[],uuid[],bigint)',
  'public.guardar_alineacion_seleccion(bigint,bigint,bigint,uuid,boolean,uuid[],uuid[],bigint)'
 ] LOOP
  f := to_regprocedure(sig);
  IF f IS NULL THEN RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='ACL_PRECONDITION_MISSING_FUNCTION: '||sig; END IF;
  SELECT p.proowner,p.prosecdef,coalesce(p.proacl,acldefault('f',p.proowner)) INTO owner,secdef,acl FROM pg_proc p WHERE p.oid=f;
  SELECT oid INTO owner_expected FROM pg_roles WHERE rolname=current_user;
  SELECT oid INTO service_oid FROM pg_roles WHERE rolname='service_role';
  IF service_oid IS NULL THEN RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='ACL_PRECONDITION_SERVICE_ROLE_MISSING'; END IF;
  IF owner IS DISTINCT FROM owner_expected THEN RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='ACL_PRECONDITION_OWNER_MISMATCH: '||sig; END IF;
  IF EXISTS(SELECT 1 FROM aclexplode(acl) a WHERE a.privilege_type='EXECUTE' AND a.grantee NOT IN (0,owner,service_oid)) THEN RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='ACL_PRECONDITION_EXTRA_GRANTEE: '||sig; END IF;
  IF NOT secdef THEN RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='ACL_PRECONDITION_NOT_SECURITY_DEFINER: '||sig; END IF;
  SELECT EXISTS(SELECT 1 FROM aclexplode(acl) a WHERE a.grantee=0 AND a.privilege_type='EXECUTE') INTO pub_exec;
  IF pub_exec OR has_function_privilege('anon',f,'EXECUTE') OR has_function_privilege('authenticated',f,'EXECUTE') THEN RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='ACL_PRECONDITION_PUBLIC_OR_CLIENT_EXECUTE: '||sig; END IF;
  IF NOT has_function_privilege('service_role',f,'EXECUTE') THEN RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='ACL_PRECONDITION_SERVICE_ROLE_REQUIRED: '||sig; END IF;
 END LOOP;
END $$;
ALTER TABLE public.torneo_partido_alineaciones DROP CONSTRAINT IF EXISTS torneo_partido_alineaciones_suplentes_check;
ALTER TABLE public.torneo_partido_alineaciones ADD CONSTRAINT torneo_partido_alineaciones_suplentes_check CHECK (cardinality(suplentes) BETWEEN 0 AND 2);
ALTER TABLE public.torneo_partido_participacion DROP CONSTRAINT IF EXISTS torneo_partido_participacion_convocados_a_check;
ALTER TABLE public.torneo_partido_participacion DROP CONSTRAINT IF EXISTS torneo_partido_participacion_convocados_b_check;
ALTER TABLE public.torneo_partido_participacion ADD CONSTRAINT torneo_partido_participacion_convocados_a_check CHECK (cardinality(convocados_a) BETWEEN 2 AND 4);
ALTER TABLE public.torneo_partido_participacion ADD CONSTRAINT torneo_partido_participacion_convocados_b_check CHECK (cardinality(convocados_b) BETWEEN 2 AND 4);

CREATE OR REPLACE FUNCTION public.proteger_planteles_selecciones() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE t public.torneos; e public.equipos; m public.partidos; row_mode text; ids uuid[]; members uuid[]; marker_exists boolean:=false;
BEGIN
 IF TG_TABLE_NAME='torneos' THEN
  IF TG_OP='DELETE' THEN row_mode:=OLD.modalidad_plantel; ELSE row_mode:=NEW.modalidad_plantel; END IF;
  IF row_mode='selecciones' OR (TG_OP='UPDATE' AND OLD.modalidad_plantel='selecciones') THEN
   IF current_user NOT IN('service_role','postgres','supabase_admin') THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Use authenticated national-team API'; END IF;
   IF TG_OP<>'DELETE' AND NEW.estado='en_curso' AND EXISTS(SELECT 1 FROM public.equipos ready_team WHERE ready_team.torneo_id=NEW.id AND EXISTS(SELECT 1 FROM jsonb_array_elements(ready_team.jugadores) j WHERE j ? 'participante_id') AND (SELECT count(*) FROM jsonb_array_elements(ready_team.jugadores)j WHERE j->>'tipo_identidad'<>'plaza_pendiente' AND trim(coalesce(j->>'nombre',''))<>'' AND coalesce(j->>'estado','confirmado') IN('confirmado','aceptado'))<2) THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Complete two sporting participants before competition';END IF;
   IF TG_OP<>'DELETE' AND NEW.estado='en_curso' AND EXISTS(SELECT 1 FROM public.equipos WHERE torneo_id=NEW.id AND (inscripcion_estado IS DISTINCT FROM 'confirmado' OR jsonb_array_length(jugadores)<2)) THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='All national teams require at least two confirmed players'; END IF;
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
    IF NEW.creador_id IS NULL OR NEW.cupo_maximo IS NULL OR NEW.cupo_maximo NOT BETWEEN 2 AND 8 OR jsonb_typeof(NEW.jugadores) IS DISTINCT FROM 'array' OR jsonb_array_length(NEW.jugadores) NOT BETWEEN 1 AND NEW.cupo_maximo THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Invalid national roster'; END IF;
    IF EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.jugadores)j WHERE j ? 'participante_id') THEN
     ids:=public.referencias_plantel_general(t.id,NEW.jugadores);
     IF EXISTS(SELECT 1 FROM equipos x CROSS JOIN LATERAL jsonb_array_elements(x.jugadores)j WHERE x.torneo_id=t.id AND x.id IS DISTINCT FROM NEW.id AND coalesce(j->>'user_id',j->>'id',j->>'participante_id')=ANY(SELECT v::text FROM unnest(ids)v)) THEN RAISE EXCEPTION USING ERRCODE='23505',MESSAGE='Sporting participant belongs to another selection';END IF;
    ELSE
    SELECT array_agg(coalesce(j->>'user_id',j->>'id')::uuid) INTO ids FROM jsonb_array_elements(NEW.jugadores) j;
    IF array_position(ids,NULL) IS NOT NULL OR cardinality(ids)<>(SELECT count(DISTINCT x) FROM unnest(ids) x) OR (SELECT count(DISTINCT user_id) FROM public.jugadores_perfil WHERE user_id=ANY(ids))<>cardinality(ids) THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Registered unique players required'; END IF;
    IF EXISTS(SELECT 1 FROM public.equipos x CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(x.jugadores)='array' THEN x.jugadores ELSE '[]'::jsonb END) j WHERE x.torneo_id=NEW.torneo_id AND x.id IS DISTINCT FROM NEW.id AND coalesce(j->>'user_id',j->>'id')=ANY(SELECT v::text FROM unnest(ids) v)) THEN RAISE EXCEPTION USING ERRCODE='23505',MESSAGE='Player belongs to another national roster'; END IF;
    IF NOT NEW.creador_id=ANY(ids) OR (NEW.inscripcion_estado='confirmado' AND cardinality(ids)<2) THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='At least two players required for competition'; END IF;
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
   OR cardinality(ids) NOT BETWEEN 2 AND 4 OR array_position(ids,NULL) IS NOT NULL OR (SELECT count(DISTINCT x) FROM unnest(ids) x)<>cardinality(ids) THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Invalid two-to-four-player lineup'; END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(e.jugadores)j WHERE j ? 'participante_id') THEN PERFORM public.referencias_plantel_general(t.id,e.jugadores);END IF;
  SELECT array_agg(coalesce(j->>'user_id',j->>'id',j->>'participante_id')::uuid) INTO members FROM jsonb_array_elements(coalesce(e.jugadores,'[]'::jsonb)) j WHERE j->>'tipo_identidad' IS DISTINCT FROM 'plaza_pendiente' AND trim(coalesce(j->>'nombre',''))<>'' AND coalesce(j->>'estado','confirmado') IN('confirmado','aceptado');
  IF to_regclass('public.scoreboard_partidos') IS NOT NULL THEN EXECUTE 'SELECT EXISTS(SELECT 1 FROM public.scoreboard_partidos WHERE partido_torneo_id=$1 AND (cronometro_inicio IS NOT NULL OR lower(coalesce(estado,'''')) IN(''en_curso'',''terminado'',''finalizado'')))' INTO marker_exists USING m.id; END IF;
  IF marker_exists OR NOT ids <@ coalesce(members,'{}'::uuid[]) OR EXISTS(SELECT 1 FROM public.torneo_partido_participacion WHERE partido_id=m.id) THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Lineup is not editable'; END IF;
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.guardar_alineacion_participantes(p_torneo_id bigint,p_partido_id bigint,p_equipo_id bigint,p_actor_id uuid,p_admin boolean,p_iniciales uuid[],p_suplentes uuid[],p_revision bigint)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE t public.torneos;m public.partidos;e public.equipos;r public.user_roles;a public.torneo_partido_alineaciones;ids uuid[];members uuid[];
BEGIN
 SELECT * INTO t FROM torneos WHERE id=p_torneo_id FOR UPDATE;
 SELECT * INTO m FROM partidos WHERE id=p_partido_id FOR UPDATE;
 SELECT * INTO e FROM equipos WHERE id=p_equipo_id FOR UPDATE;
 SELECT * INTO r FROM user_roles WHERE user_id=p_actor_id;
 IF t.id IS NULL OR m.id IS NULL OR e.id IS NULL OR t.modalidad_plantel IS DISTINCT FROM 'selecciones' OR t.deporte IS DISTINCT FROM 'padbol' OR m.torneo_id IS DISTINCT FROM t.id OR e.torneo_id IS DISTINCT FROM t.id OR (e.id IS DISTINCT FROM m.equipo_a_id AND e.id IS DISTINCT FROM m.equipo_b_id) THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Invalid generic selection context';END IF;
 IF (e.creador_id=p_actor_id OR r.role='super_admin' OR r.role='admin_club' AND r.sede_id=t.sede_id) IS DISTINCT FROM true THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Lineup scope denied';END IF;
 IF m.estado NOT IN('pendiente','programado') OR t.estado NOT IN('planificacion','proximo','inscripcion','abierto','inscripcion_abierta','en_curso') OR coalesce(e.inscripcion_estado,'') NOT IN('confirmado','confirmada') OR EXISTS(SELECT 1 FROM scoreboard_partidos WHERE partido_torneo_id=m.id AND (cronometro_inicio IS NOT NULL OR lower(coalesce(estado,'')) IN('en_curso','terminado','finalizado'))) THEN RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='Lineup frozen or tournament not writable';END IF;
 IF p_revision IS NULL OR p_revision<0 OR p_iniciales IS NULL OR p_suplentes IS NULL OR cardinality(p_iniciales)<>2 OR cardinality(p_suplentes)>2 OR (SELECT count(DISTINCT x) FROM unnest(p_iniciales||p_suplentes)x) NOT BETWEEN 2 AND 4 THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Two starters and up to two substitutes required';END IF;
 IF jsonb_typeof(e.jugadores) IS DISTINCT FROM 'array' OR jsonb_array_length(e.jugadores) NOT BETWEEN 2 AND 8 OR (SELECT count(*) FROM jsonb_array_elements(e.jugadores)j WHERE j->>'tipo_identidad' IS DISTINCT FROM 'plaza_pendiente' AND trim(coalesce(j->>'nombre',''))<>'' AND coalesce(j->>'estado','confirmado') IN('confirmado','aceptado'))<2 THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Complete two to eight sporting players first';END IF;
 PERFORM public.referencias_plantel_general(t.id,e.jugadores);
 -- Only persisted participant identities in this exact event can be used as guest references.
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(e.jugadores)j WHERE j->>'tipo_identidad' IS DISTINCT FROM 'plaza_pendiente' AND j->>'user_id' IS NULL AND j->>'id' IS NULL AND NOT EXISTS(SELECT 1 FROM torneo_participantes p WHERE p.id::text=j->>'participante_id' AND p.torneo_id=t.id AND p.sede_id=t.sede_id AND p.tipo_identidad<>'plaza_pendiente')) THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Unknown sporting participant';END IF;
 SELECT array_agg(coalesce(j->>'user_id',j->>'id',j->>'participante_id')::uuid) INTO members FROM jsonb_array_elements(e.jugadores)j WHERE j->>'tipo_identidad' IS DISTINCT FROM 'plaza_pendiente' AND trim(coalesce(j->>'nombre',''))<>'' AND coalesce(j->>'estado','confirmado') IN('confirmado','aceptado');
 ids:=p_iniciales||p_suplentes;
 IF NOT ids<@members OR cardinality(members)<>(SELECT count(DISTINCT x) FROM unnest(members)x) THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Lineup outside confirmed roster';END IF;
 SELECT * INTO a FROM torneo_partido_alineaciones WHERE partido_id=m.id AND equipo_id=e.id FOR UPDATE;
 IF coalesce(a.revision,0)<>p_revision THEN RAISE EXCEPTION USING ERRCODE='40001',MESSAGE='Lineup revision changed';END IF;
 INSERT INTO torneo_partido_alineaciones(partido_id,equipo_id,torneo_id,iniciales,suplentes,revision,actor_id) VALUES(m.id,e.id,t.id,p_iniciales,p_suplentes,p_revision+1,p_actor_id)
 ON CONFLICT(partido_id,equipo_id) DO UPDATE SET iniciales=excluded.iniciales,suplentes=excluded.suplentes,revision=excluded.revision,actor_id=excluded.actor_id,updated_at=now()
 RETURNING * INTO a;
 RETURN to_jsonb(a);
END $$;
CREATE OR REPLACE FUNCTION public.guardar_alineacion_seleccion(p_torneo_id bigint,p_partido_id bigint,p_equipo_id bigint,p_actor_id uuid,p_admin boolean,p_iniciales uuid[],p_suplentes uuid[],p_revision bigint)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE t public.torneos; m public.partidos; e public.equipos; a public.torneo_partido_alineaciones; ids uuid[]; members uuid[]; marker_exists boolean:=false;
BEGIN
 SELECT * INTO t FROM public.torneos WHERE id=p_torneo_id FOR UPDATE;
 SELECT * INTO m FROM public.partidos WHERE id=p_partido_id FOR UPDATE;
 SELECT * INTO e FROM public.equipos WHERE id=p_equipo_id FOR UPDATE;
 IF t.id IS NULL OR m.id IS NULL OR e.id IS NULL OR t.modalidad_plantel<>'selecciones' OR t.deporte<>'padbol'
  OR m.torneo_id<>t.id OR e.torneo_id<>t.id OR (p_equipo_id IS DISTINCT FROM m.equipo_a_id AND p_equipo_id IS DISTINCT FROM m.equipo_b_id)
  OR (e.creador_id IS DISTINCT FROM p_actor_id AND NOT (coalesce(p_admin,false) AND EXISTS(SELECT 1 FROM user_roles ur WHERE ur.user_id=p_actor_id AND (ur.role='super_admin' OR (ur.role='admin_club' AND ur.sede_id=t.sede_id)))))
  OR coalesce(m.estado,'') NOT IN('pendiente','programado') OR coalesce(t.estado,'') NOT IN('planificacion','proximo','inscripcion','abierto','inscripcion_abierta','en_curso') OR e.inscripcion_estado IS DISTINCT FROM 'confirmado' OR p_actor_id IS NULL THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Invalid lineup context'; END IF;
 IF to_regclass('public.scoreboard_partidos') IS NOT NULL THEN EXECUTE 'SELECT EXISTS(SELECT 1 FROM public.scoreboard_partidos WHERE partido_torneo_id=$1 AND (cronometro_inicio IS NOT NULL OR lower(coalesce(estado,'''')) IN(''en_curso'',''terminado'',''finalizado'')))' INTO marker_exists USING m.id; END IF;
 IF marker_exists THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Scoreboard already freezes declared lineup'; END IF;
 IF p_revision IS NULL OR p_revision<0 OR p_iniciales IS NULL OR p_suplentes IS NULL OR cardinality(p_iniciales)<>2 OR cardinality(p_suplentes)>2 THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Two starters and up to two substitutes required'; END IF;
 ids:=p_iniciales||p_suplentes;
 IF cardinality(ids) NOT BETWEEN 2 AND 4 OR (SELECT count(DISTINCT x) FROM unnest(ids) x)<>cardinality(ids) THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Duplicate or invalid lineup players'; END IF;
 IF jsonb_typeof(e.jugadores) IS DISTINCT FROM 'array' OR jsonb_array_length(e.jugadores)<2 OR jsonb_array_length(e.jugadores)>8 THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Invalid roster size'; END IF;
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
CREATE OR REPLACE FUNCTION public.proteger_marcador_seleccion() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE t public.torneos; m public.partidos; a public.torneo_partido_alineaciones; b public.torneo_partido_alineaciones; ea public.equipos; eb public.equipos;
BEGIN
 IF NEW.torneo_id IS NULL OR NEW.partido_torneo_id IS NULL THEN RETURN NEW; END IF;
 SELECT * INTO t FROM public.torneos WHERE id=NEW.torneo_id FOR UPDATE;
 IF t.modalidad_plantel IS DISTINCT FROM 'selecciones' THEN RETURN NEW; END IF;
 IF current_user NOT IN('service_role','postgres','supabase_admin') THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Use authorized tournament scoreboard API'; END IF;
 SELECT * INTO m FROM public.partidos WHERE id=NEW.partido_torneo_id FOR UPDATE;
 IF m.torneo_id IS DISTINCT FROM t.id OR coalesce(t.estado,'') NOT IN('planificacion','proximo','inscripcion','abierto','inscripcion_abierta','en_curso') THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Invalid scoreboard tournament'; END IF;
 SELECT * INTO ea FROM public.equipos WHERE id=m.equipo_a_id;
 SELECT * INTO eb FROM public.equipos WHERE id=m.equipo_b_id;
 IF NEW.cronometro_inicio IS NULL AND lower(coalesce(NEW.estado,'')) NOT IN('en_curso','terminado','finalizado') THEN
  SELECT jsonb_agg(j||jsonb_build_object('numero',i.ordinality,'jersey',i.ordinality) ORDER BY i.ordinality) INTO NEW.equipo_a_jugadores FROM jsonb_array_elements(coalesce(ea.jugadores,'[]'::jsonb)) WITH ORDINALITY i(j,ordinality) WHERE j->>'tipo_identidad' IS DISTINCT FROM 'plaza_pendiente' AND trim(coalesce(j->>'nombre',''))<>'' AND coalesce(j->>'estado','confirmado') IN('confirmado','aceptado');
  SELECT jsonb_agg(j||jsonb_build_object('numero',i.ordinality,'jersey',i.ordinality) ORDER BY i.ordinality) INTO NEW.equipo_b_jugadores FROM jsonb_array_elements(coalesce(eb.jugadores,'[]'::jsonb)) WITH ORDINALITY i(j,ordinality) WHERE j->>'tipo_identidad' IS DISTINCT FROM 'plaza_pendiente' AND trim(coalesce(j->>'nombre',''))<>'' AND coalesce(j->>'estado','confirmado') IN('confirmado','aceptado');
  IF coalesce(jsonb_array_length(NEW.equipo_a_jugadores),0) NOT BETWEEN 2 AND 4 OR coalesce(jsonb_array_length(NEW.equipo_b_jugadores),0) NOT BETWEEN 2 AND 4 THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Prepare scoreboard from two to four confirmed players'; END IF;
  RETURN NEW;
 END IF;
 SELECT * INTO a FROM public.torneo_partido_alineaciones WHERE partido_id=m.id AND equipo_id=m.equipo_a_id;
 SELECT * INTO b FROM public.torneo_partido_alineaciones WHERE partido_id=m.id AND equipo_id=m.equipo_b_id;
 IF a.partido_id IS NULL OR b.partido_id IS NULL THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Declare both lineups before starting scoreboard'; END IF;
 SELECT jsonb_agg(j||jsonb_build_object('numero',i.ordinality,'jersey',i.ordinality) ORDER BY i.ordinality) INTO NEW.equipo_a_jugadores FROM unnest(a.iniciales||a.suplentes) WITH ORDINALITY i(user_id,ordinality) JOIN LATERAL jsonb_array_elements(ea.jugadores) j ON coalesce(j->>'user_id',j->>'id',j->>'participante_id')=i.user_id::text;
 SELECT jsonb_agg(j||jsonb_build_object('numero',i.ordinality,'jersey',i.ordinality) ORDER BY i.ordinality) INTO NEW.equipo_b_jugadores FROM unnest(b.iniciales||b.suplentes) WITH ORDINALITY i(user_id,ordinality) JOIN LATERAL jsonb_array_elements(eb.jugadores) j ON coalesce(j->>'user_id',j->>'id',j->>'participante_id')=i.user_id::text;
 IF coalesce(jsonb_array_length(NEW.equipo_a_jugadores),0) NOT BETWEEN 2 AND 4 OR coalesce(jsonb_array_length(NEW.equipo_b_jugadores),0) NOT BETWEEN 2 AND 4 THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Roster no longer confirms declared players'; END IF;
 RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.proteger_resultado_seleccion() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE mode text;
BEGIN
 SELECT modalidad_plantel INTO mode FROM public.torneos WHERE id=NEW.torneo_id;
 IF mode='selecciones' OR (TG_OP='UPDATE' AND EXISTS(SELECT 1 FROM public.torneos WHERE id=OLD.torneo_id AND modalidad_plantel='selecciones')) THEN
  IF current_user NOT IN('service_role','postgres','supabase_admin') THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Use national result API'; END IF;
  IF EXISTS(SELECT 1 FROM public.equipos WHERE id IN(NEW.equipo_a_id,NEW.equipo_b_id) AND (torneo_id IS DISTINCT FROM NEW.torneo_id OR inscripcion_estado IS DISTINCT FROM 'confirmado' OR jsonb_array_length(jugadores)<2)) THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='National competition requires confirmed teams'; END IF;
  IF TG_OP='UPDATE' AND EXISTS(SELECT 1 FROM public.torneo_partido_participacion WHERE partido_id=OLD.id) AND (NEW.estado IS DISTINCT FROM OLD.estado OR NEW.resultado IS DISTINCT FROM OLD.resultado OR NEW.ganador_equipo_id IS DISTINCT FROM OLD.ganador_equipo_id OR NEW.torneo_id IS DISTINCT FROM OLD.torneo_id OR NEW.equipo_a_id IS DISTINCT FROM OLD.equipo_a_id OR NEW.equipo_b_id IS DISTINCT FROM OLD.equipo_b_id) THEN RAISE EXCEPTION USING ERRCODE='40001',MESSAGE='National result history is frozen'; END IF;
  IF TG_OP='UPDATE' AND (NEW.torneo_id IS DISTINCT FROM OLD.torneo_id OR NEW.equipo_a_id IS DISTINCT FROM OLD.equipo_a_id OR NEW.equipo_b_id IS DISTINCT FROM OLD.equipo_b_id) AND EXISTS(SELECT 1 FROM public.torneo_partido_alineaciones WHERE partido_id=OLD.id) THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Declared match context is frozen'; END IF;
  IF NEW.estado='finalizado' AND (TG_OP='INSERT' OR OLD.estado IS DISTINCT FROM NEW.estado OR OLD.resultado IS DISTINCT FROM NEW.resultado OR OLD.ganador_equipo_id IS DISTINCT FROM NEW.ganador_equipo_id) AND current_setting('padbol.national_final_rpc',true) IS DISTINCT FROM '1' THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Atomic national result evidence required'; END IF;
  IF NEW.estado='en_curso' AND (SELECT count(*) FROM public.torneo_partido_alineaciones WHERE partido_id=NEW.id AND equipo_id IN(NEW.equipo_a_id,NEW.equipo_b_id))<>2 THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Both lineups required before play'; END IF;
 END IF;
 RETURN NEW;
END $$;
COMMIT;
