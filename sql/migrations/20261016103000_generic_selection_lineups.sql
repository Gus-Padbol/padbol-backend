BEGIN;
CREATE OR REPLACE FUNCTION public.guardar_alineacion_participantes(p_torneo_id bigint,p_partido_id bigint,p_equipo_id bigint,p_actor_id uuid,p_admin boolean,p_iniciales uuid[],p_suplentes uuid[],p_revision bigint)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE t public.torneos;m public.partidos;e public.equipos;r public.user_roles;a public.torneo_partido_alineaciones;ids uuid[];members uuid[];
BEGIN
 SELECT * INTO t FROM torneos WHERE id=p_torneo_id FOR UPDATE;
 SELECT * INTO m FROM partidos WHERE id=p_partido_id FOR UPDATE;
 SELECT * INTO e FROM equipos WHERE id=p_equipo_id FOR UPDATE;
 SELECT * INTO r FROM user_roles WHERE user_id=p_actor_id;
 IF t.id IS NULL OR m.id IS NULL OR e.id IS NULL OR t.plan_nations IS NOT NULL OR t.modalidad_plantel IS DISTINCT FROM 'selecciones' OR t.deporte IS DISTINCT FROM 'padbol' OR m.torneo_id IS DISTINCT FROM t.id OR e.torneo_id IS DISTINCT FROM t.id OR (e.id IS DISTINCT FROM m.equipo_a_id AND e.id IS DISTINCT FROM m.equipo_b_id) THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Invalid generic selection context';END IF;
 IF (e.creador_id=p_actor_id OR r.role='super_admin' OR r.role='admin_club' AND r.sede_id=t.sede_id) IS DISTINCT FROM true THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Lineup scope denied';END IF;
 IF m.estado NOT IN('pendiente','programado') OR t.estado NOT IN('planificacion','proximo','inscripcion','abierto','inscripcion_abierta','en_curso') OR coalesce(e.inscripcion_estado,'') NOT IN('confirmado','confirmada') OR EXISTS(SELECT 1 FROM scoreboard_partidos WHERE partido_torneo_id=m.id) THEN RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='Lineup frozen or tournament not writable';END IF;
 IF p_revision IS NULL OR p_revision<0 OR p_iniciales IS NULL OR p_suplentes IS NULL OR cardinality(p_iniciales)<>2 OR cardinality(p_suplentes)<>2 OR (SELECT count(DISTINCT x) FROM unnest(p_iniciales||p_suplentes)x)<>4 THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Exactly four distinct players required';END IF;
 IF jsonb_typeof(e.jugadores) IS DISTINCT FROM 'array' OR jsonb_array_length(e.jugadores) NOT BETWEEN 4 AND 8 OR (SELECT count(*) FROM jsonb_array_elements(e.jugadores)j WHERE j->>'tipo_identidad' IS DISTINCT FROM 'plaza_pendiente' AND trim(coalesce(j->>'nombre',''))<>'' AND coalesce(j->>'estado','confirmado') IN('confirmado','aceptado'))<4 THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Complete four to eight sporting players first';END IF;
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
REVOKE ALL ON FUNCTION public.guardar_alineacion_participantes(bigint,bigint,bigint,uuid,boolean,uuid[],uuid[],bigint) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.guardar_alineacion_participantes(bigint,bigint,bigint,uuid,boolean,uuid[],uuid[],bigint) TO service_role;
COMMIT;
