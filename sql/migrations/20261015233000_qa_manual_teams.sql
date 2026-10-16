BEGIN;
CREATE TABLE IF NOT EXISTS public.torneo_qa_inscripcion_requests (
 torneo_id bigint NOT NULL REFERENCES public.torneos(id) ON DELETE CASCADE,
 request_id uuid NOT NULL, actor_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
 payload jsonb NOT NULL, equipo_id bigint NOT NULL REFERENCES public.equipos(id) ON DELETE CASCADE,
 PRIMARY KEY(torneo_id,request_id)
);
ALTER TABLE public.torneo_qa_inscripcion_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.torneo_qa_inscripcion_requests FROM PUBLIC,anon,authenticated;
GRANT ALL ON public.torneo_qa_inscripcion_requests TO service_role;
CREATE OR REPLACE FUNCTION public.gestionar_dupla_qa(p_torneo_id bigint,p_actor_id uuid,p_accion text,p_nombre text DEFAULT '',p_jugadores uuid[] DEFAULT '{}'::uuid[],p_request_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE t public.torneos; r public.user_roles; e public.equipos; previous public.torneo_qa_inscripcion_requests;
 players jsonb; selected jsonb; payload jsonb; available boolean; writes boolean;
BEGIN
 SELECT * INTO t FROM public.torneos WHERE id=p_torneo_id FOR UPDATE;
 IF t.id IS NULL THEN RAISE EXCEPTION USING ERRCODE='P0002',MESSAGE='QA tournament not found'; END IF;
 SELECT * INTO r FROM public.user_roles WHERE user_id=p_actor_id;
 IF (r.role='super_admin' OR r.role='admin_club' AND r.sede_id=t.sede_id) IS DISTINCT FROM true THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Tournament scope denied'; END IF;
 IF t.es_prueba IS DISTINCT FROM true OR t.deporte IS DISTINCT FROM 'padbol' OR coalesce(t.modalidad_plantel,'dobles')<>'dobles' OR coalesce(t.formato_equipo,'dobles')<>'dobles' OR t.plan_nations IS NOT NULL THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Only QA doubles supported'; END IF;
 writes:=(t.estado IN('abierto','inscripcion','inscripcion_abierta') AND coalesce(t.costo_inscripcion,0)=0 AND coalesce(t.inscripcion_monto,0)=0 AND NOT EXISTS(SELECT 1 FROM public.partidos WHERE torneo_id=t.id)) IS TRUE;
 SELECT coalesce(jsonb_agg(jsonb_build_object('user_id',p.user_id,'nombre',p.nombre,'apellido',coalesce(p.apellido,''),'inscrito',EXISTS(SELECT 1 FROM public.equipos eq CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(eq.jugadores)='array' THEN eq.jugadores ELSE '[]'::jsonb END) j WHERE eq.torneo_id=t.id AND coalesce(j->>'user_id',j->>'id')=p.user_id::text)) ORDER BY p.nombre,p.user_id),'[]'::jsonb) INTO players
 FROM public.jugadores_perfil p JOIN auth.users u ON u.id=p.user_id
 WHERE u.raw_user_meta_data->>'qa_test'='true' AND u.raw_user_meta_data->>'qa_torneo_id'=t.id::text AND u.raw_user_meta_data->>'qa_sede_id'=t.sede_id::text
 AND p.fecha_nacimiento IS NOT NULL AND p.fecha_nacimiento<=current_date-interval '16 years';
 IF p_accion='listar' THEN RETURN jsonb_build_object('ok',true,'torneo_id',t.id,'can_manage',true,'can_write',writes,'players',players); END IF;
 IF p_accion<>'crear' OR p_request_id IS NULL OR length(trim(coalesce(p_nombre,''))) NOT BETWEEN 1 AND 80 OR cardinality(p_jugadores) IS DISTINCT FROM 2 OR p_jugadores[1] IS NULL OR p_jugadores[2] IS NULL OR p_jugadores[1]=p_jugadores[2] THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Choose two distinct QA players and a name'; END IF;
 payload:=jsonb_build_object('nombre',trim(p_nombre),'jugadores',to_jsonb(p_jugadores));
 SELECT * INTO previous FROM public.torneo_qa_inscripcion_requests WHERE torneo_id=t.id AND request_id=p_request_id;
 IF previous.request_id IS NOT NULL THEN
  IF previous.actor_id<>p_actor_id OR previous.payload<>payload THEN RAISE EXCEPTION USING ERRCODE='40001',MESSAGE='Request conflict'; END IF;
  SELECT * INTO e FROM public.equipos WHERE id=previous.equipo_id AND torneo_id=t.id;
  IF e.id IS NULL THEN RAISE EXCEPTION USING ERRCODE='40001',MESSAGE='Saved team unavailable'; END IF;
  RETURN jsonb_build_object('ok',true,'torneo_id',t.id,'status','idempotent','equipo',to_jsonb(e));
 END IF;
 IF NOT writes THEN RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='Registration closed or fixture already exists'; END IF;
 SELECT jsonb_agg(jsonb_build_object('id',x->>'user_id','user_id',x->>'user_id','nombre',x->>'nombre','apellido',x->>'apellido','estado','confirmado')) INTO selected FROM jsonb_array_elements(players) x WHERE (x->>'user_id')::uuid=ANY(p_jugadores);
 IF jsonb_array_length(selected) IS DISTINCT FROM 2 THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='QA players not eligible'; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(players) x WHERE (x->>'user_id')::uuid=ANY(p_jugadores) AND (x->>'inscrito')::boolean) THEN RAISE EXCEPTION USING ERRCODE='23505',MESSAGE='A player is already registered'; END IF;
 INSERT INTO public.equipos(torneo_id,sede_id,nombre,creador_id,jugadores,solicitudes,cupo_maximo,equipo_abierto,tipo_equipo,inscripcion_estado,modalidad_plantel)
 VALUES(t.id,t.sede_id,trim(p_nombre),p_jugadores[1],selected,'[]'::jsonb,2,false,'cerrado','confirmado','dobles') RETURNING * INTO e;
 INSERT INTO public.torneo_qa_inscripcion_requests(torneo_id,request_id,actor_id,payload,equipo_id) VALUES(t.id,p_request_id,p_actor_id,payload,e.id);
 RETURN jsonb_build_object('ok',true,'torneo_id',t.id,'status','created','equipo',to_jsonb(e));
END $$;
REVOKE ALL ON FUNCTION public.gestionar_dupla_qa(bigint,uuid,text,text,uuid[],uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.gestionar_dupla_qa(bigint,uuid,text,text,uuid[],uuid) TO service_role;
COMMIT;
