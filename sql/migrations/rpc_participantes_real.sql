CREATE OR REPLACE FUNCTION public.gestionar_participantes_torneo(p_torneo_id bigint, p_actor_id uuid, p_accion text, p_payload jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
 t public.torneos; r public.user_roles; p public.torneo_participantes; v public.torneo_participante_vinculaciones;
 op public.torneo_participante_operaciones; e public.equipos; profile public.jugadores_perfil;
 manage boolean; open_registration boolean; shared_visible boolean:=false; reveal_at timestamptz; private_plan jsonb; req uuid; receipt jsonb; catalog jsonb; teams jsonb; claims jsonb; homologation jsonb; accreditations jsonb;
 item jsonb; roster jsonb:='[]'::jsonb; selected uuid[]:='{}'; participant uuid; captain uuid;
 lim_min integer; lim_max integer; identified integer:=0; include_captain boolean; name text; mode text;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM auth.users WHERE id=p_actor_id) THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Authenticated actor required';END IF;
 -- Same row lock used by fixture planning protects enrollment versus roster snapshots.
 SELECT * INTO t FROM public.torneos WHERE id=p_torneo_id FOR UPDATE;
 IF t.id IS NULL THEN RAISE EXCEPTION USING ERRCODE='P0002',MESSAGE='Tournament missing';END IF;
 SELECT * INTO r FROM public.user_roles WHERE user_id=p_actor_id;
 manage:=coalesce(r.role='super_admin' OR (r.role='admin_club' AND r.sede_id=t.sede_id),false);
 SELECT * INTO profile FROM public.jugadores_perfil WHERE user_id=p_actor_id;
 IF t.es_prueba IS TRUE AND NOT manage AND NOT EXISTS(SELECT 1 FROM auth.users u WHERE u.id=p_actor_id AND u.raw_app_meta_data->>'qa_test'='true' AND u.raw_app_meta_data->>'qa_torneo_id'=t.id::text AND u.raw_app_meta_data->>'qa_sede_id'=t.sede_id::text)
  AND NOT EXISTS(SELECT 1 FROM public.equipos eq WHERE eq.torneo_id=t.id AND (eq.creador_id=p_actor_id OR EXISTS(SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(eq.jugadores)='array' THEN eq.jugadores ELSE '[]'::jsonb END) j WHERE lower(coalesce(j->>'user_id',j->>'id'))=p_actor_id::text)))
  THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='QA event audience denied';END IF;
 IF t.plan_nations IS NOT NULL THEN
  SELECT plan INTO private_plan FROM public.torneo_nations_planes WHERE torneo_id=t.id;
  shared_visible:=false;
  BEGIN
   IF nullif(private_plan#>>'{config,reveal_at}','') IS NOT NULL THEN reveal_at:=(private_plan#>>'{config,reveal_at}')::timestamptz;
   ELSIF nullif(private_plan#>>'{config,timezone}','') IS NOT NULL AND nullif(to_jsonb(t)->>'fecha_inicio','') IS NOT NULL THEN
    reveal_at:=((to_jsonb(t)->>'fecha_inicio')::date+time '12:00') AT TIME ZONE (private_plan#>>'{config,timezone}')-coalesce((to_jsonb(t)->>'horas_revelar_equipos')::numeric,48)*interval '1 hour';
   END IF;
   shared_visible:=coalesce(reveal_at<=now(),false) AND EXISTS(SELECT 1 FROM public.nations_activation_events ev WHERE ev.torneo_id=t.id AND ev.roster_publication_approved);
  EXCEPTION WHEN OTHERS THEN shared_visible:=false;END;
 END IF;

 mode:=coalesce(t.modalidad_plantel,t.formato_equipo,'dobles');
 lim_min:=CASE WHEN mode='selecciones' THEN 4 WHEN mode IN('individual','individuales','singles','single') OR t.formato_equipo IN('individual','individuales','singles','single') THEN 1 ELSE 2 END;
 lim_max:=CASE WHEN mode='selecciones' THEN 8 ELSE lim_min END;
 open_registration:=coalesce(t.estado IN('abierto','inscripcion','inscripcion_abierta','proximo','planificacion'),false)
  AND public.torneo_inscripcion_fecha_vigente(t.fecha_fin,t.sede_id,t.plan_nations)
  AND NOT EXISTS(SELECT 1 FROM public.partidos WHERE torneo_id=t.id);
 IF p_accion='listar' THEN
  SELECT coalesce(jsonb_agg(jsonb_build_object('id',x.id,'nombre',x.nombre,'tipo_identidad',x.tipo_identidad,
   'estado_vinculacion',x.estado_vinculacion,'is_current_actor',coalesce(x.linked_user_id=p_actor_id,false),
   'ranking_oficial_elegible',x.ranking_oficial_elegible,'can_request_accreditation',x.linked_user_id=p_actor_id AND x.estado_vinculacion='vinculado' AND NOT x.ranking_oficial_elegible,'can_edit',(manage OR x.creado_por=p_actor_id) AND x.tipo_identidad<>'cuenta' AND x.linked_user_id IS NULL AND coalesce(t.estado IN('abierto','inscripcion','inscripcion_abierta','proximo','planificacion'),false) AND NOT public.participante_plantel_congelado(x.id),'inscrito',EXISTS(SELECT 1 FROM public.torneo_participante_equipos pe WHERE pe.torneo_id=t.id AND pe.participante_id=x.id),
   'can_claim',x.tipo_identidad='generico' AND x.linked_user_id IS NULL AND profile.user_id IS NOT NULL
    AND NOT EXISTS(SELECT 1 FROM public.torneo_participantes self WHERE self.torneo_id=t.id AND self.linked_user_id=p_actor_id) AND NOT EXISTS(SELECT 1 FROM public.equipos old CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(old.jugadores)='array' THEN old.jugadores ELSE '[]'::jsonb END) j WHERE old.torneo_id=t.id AND lower(coalesce(j->>'user_id',j->>'id'))=p_actor_id::text)) ORDER BY x.created_at,x.id),'[]'::jsonb)
   INTO catalog FROM public.torneo_participantes x WHERE x.torneo_id=t.id AND (manage OR x.creado_por=p_actor_id OR x.linked_user_id=p_actor_id OR (shared_visible AND EXISTS(SELECT 1 FROM public.torneo_participante_equipos pe WHERE pe.torneo_id=t.id AND pe.participante_id=x.id)));
  SELECT coalesce(jsonb_agg(to_jsonb(eq) ORDER BY eq.id),'[]'::jsonb) INTO teams FROM public.equipos eq WHERE eq.torneo_id=t.id AND
   (manage OR eq.creador_id=p_actor_id OR EXISTS(SELECT 1 FROM public.torneo_participante_equipos pe JOIN public.torneo_participantes pp ON pp.id=pe.participante_id WHERE pe.equipo_id=eq.id AND pp.linked_user_id=p_actor_id));
  SELECT coalesce(jsonb_agg(jsonb_build_object('id',cl.id,'participante_id',cl.participante_id,'estado',cl.estado,'nombre_solicitante',jp.nombre) ORDER BY cl.created_at),'[]'::jsonb)
   INTO claims FROM public.torneo_participante_vinculaciones cl LEFT JOIN public.jugadores_perfil jp ON jp.user_id=cl.user_id WHERE cl.torneo_id=t.id AND(manage OR cl.user_id=p_actor_id);
  SELECT jsonb_build_object('estado','aprobada','referencia_oficial',h.referencia_oficial) INTO homologation FROM public.torneo_homologaciones h WHERE h.torneo_id=t.id;
  SELECT coalesce(jsonb_agg(jsonb_build_object('id',a.id,'participante_id',a.participante_id,'estado',a.estado,'referencia_oficial',a.referencia_oficial,'nombre_solicitante',jp.nombre) ORDER BY a.created_at),'[]'::jsonb)
   INTO accreditations FROM public.torneo_participante_acreditaciones a LEFT JOIN public.jugadores_perfil jp ON jp.user_id=a.user_id WHERE a.torneo_id=t.id AND(manage OR a.user_id=p_actor_id);
  RETURN jsonb_build_object('ok',true,'torneo_id',t.id,'sede_id',t.sede_id,'can_manage',manage,'can_register',open_registration AND coalesce(t.deporte='padbol',false),
   'current_actor',jsonb_build_object('user_id',p_actor_id,'nombre',coalesce(profile.nombre,'')),
   'participants',catalog,'teams',teams,'link_requests',claims,'can_accredit',coalesce(r.role='super_admin',false),'can_homologate',coalesce(r.role='super_admin',false) AND t.es_prueba IS DISTINCT FROM true AND coalesce(to_jsonb(t)->>'nivel_torneo','') IN('club_oficial','nacional','internacional','mundial'),
   'homologation_requires_fipa_enablement',t.es_prueba IS DISTINCT FROM true AND coalesce(to_jsonb(t)->>'nivel_torneo','') IN('club_oficial','nacional','internacional','mundial') AND NOT coalesce((to_jsonb(t)->>'fipa_registration_enabled')::boolean,false),
   'homologation_block_reason',CASE WHEN r.role IS DISTINCT FROM 'super_admin' THEN 'La homologación requiere un super administrador.' WHEN t.es_prueba IS TRUE THEN 'Los eventos QA no se homologan ni otorgan puntos oficiales.' WHEN NOT coalesce((to_jsonb(t)->>'fipa_registration_enabled')::boolean,false) THEN 'Para homologar debes confirmar expresamente la activación de la inscripción FIPA.' WHEN coalesce(to_jsonb(t)->>'nivel_torneo','') NOT IN('club_oficial','nacional','internacional','mundial') THEN 'El nivel del torneo no es oficial.' ELSE NULL END,'homologacion',coalesce(homologation,jsonb_build_object('estado','pendiente','referencia_oficial',NULL)),'accreditation_requests',accreditations,'torneo',jsonb_build_object('modalidad_plantel',mode,'formato_equipo',t.formato_equipo));
 END IF;
 IF p_accion NOT IN('crear_participante','editar_participante','inscribir','solicitar_vinculacion','resolver_vinculacion') OR p_accion IS NULL THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Unknown action';END IF;
 BEGIN req:=(p_payload->>'request_id')::uuid;EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Request UUID required';END;
 IF req IS NULL THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Request UUID required';END IF;
 SELECT * INTO op FROM public.torneo_participante_operaciones WHERE torneo_id=t.id AND request_id=req;
 IF FOUND THEN
  IF op.actor_id<>p_actor_id OR op.accion<>p_accion OR op.payload<>p_payload THEN RAISE EXCEPTION USING ERRCODE='23505',MESSAGE='Request identity conflict';END IF;
  RETURN jsonb_set(op.receipt,'{status}','"idempotent"');
 END IF;
 IF p_accion='crear_participante' THEN
  IF NOT manage THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Club scope required';END IF;
  IF NOT open_registration THEN RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='Registration closed';END IF;
  name:=trim(coalesce(p_payload->>'nombre',''));
  IF coalesce(p_payload->>'tipo_identidad','generico') NOT IN('generico','plaza_pendiente') OR length(name)>100 OR (coalesce(p_payload->>'tipo_identidad','generico')='generico' AND name='') THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Participant identity invalid';END IF;
  INSERT INTO public.torneo_participantes(torneo_id,sede_id,nombre,tipo_identidad,origen,creado_por)
   VALUES(t.id,t.sede_id,name,coalesce(p_payload->>'tipo_identidad','generico'),'club',p_actor_id) RETURNING * INTO p;
  receipt:=jsonb_build_object('ok',true,'torneo_id',t.id,'status','created','participante',to_jsonb(p));
 ELSIF p_accion='editar_participante' THEN
  SELECT * INTO p FROM public.torneo_participantes WHERE id=(p_payload->>'participante_id')::uuid AND torneo_id=t.id FOR UPDATE;
  IF NOT FOUND OR (NOT manage AND p.creado_por<>p_actor_id) THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Participant edit scope denied';END IF;
  IF p.tipo_identidad='cuenta' OR p.linked_user_id IS NOT NULL OR coalesce(t.estado IN('abierto','inscripcion','inscripcion_abierta','proximo','planificacion'),false) IS DISTINCT FROM true
   OR public.participante_plantel_congelado(p.id)
   THEN RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='Roster frozen after start or marker';END IF;
  name:=trim(coalesce(p_payload->>'nombre',''));
  IF name='' OR length(name)>100 OR coalesce(p_payload->>'tipo_identidad','generico')<>'generico' THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Named participant required';END IF;
  UPDATE public.torneo_participantes SET nombre=name,tipo_identidad='generico' WHERE id=p.id RETURNING * INTO p;
  UPDATE public.equipos eq SET jugadores=(SELECT jsonb_agg(CASE WHEN j->>'participante_id'=p.id::text THEN j||jsonb_build_object('nombre',p.nombre,'tipo_identidad','generico','estado','confirmado') ELSE j END ORDER BY ord) FROM jsonb_array_elements(eq.jugadores) WITH ORDINALITY entries(j,ord))
   WHERE eq.id IN(SELECT equipo_id FROM public.torneo_participante_equipos WHERE participante_id=p.id);
  receipt:=jsonb_build_object('ok',true,'torneo_id',t.id,'status','updated','participante',to_jsonb(p));
 ELSIF p_accion='inscribir' THEN
  IF NOT open_registration THEN RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='Registration closed';END IF;
  IF t.deporte IS DISTINCT FROM 'padbol' THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Unsupported sport';END IF;
  name:=trim(coalesce(p_payload->>'nombre',''));
  IF name='' OR length(name)>100 OR jsonb_typeof(p_payload->'participantes') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Team and participants required';END IF;
  include_captain:=CASE WHEN manage THEN coalesce((p_payload->>'incluir_capitan')::boolean,false) ELSE true END;
  IF include_captain THEN
   IF profile.user_id IS NULL OR trim(coalesce(profile.nombre,''))='' THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Complete your name before registering as captain';END IF;
   SELECT * INTO p FROM public.torneo_participantes WHERE torneo_id=t.id AND linked_user_id=p_actor_id;
   IF NOT FOUND THEN INSERT INTO public.torneo_participantes(torneo_id,sede_id,nombre,tipo_identidad,origen,creado_por,linked_user_id,estado_vinculacion)
    VALUES(t.id,t.sede_id,profile.nombre,'cuenta','cuenta',p_actor_id,p_actor_id,'vinculado') RETURNING * INTO p;END IF;
   selected:=array_append(selected,p.id);
  END IF;
  FOR item IN SELECT value FROM jsonb_array_elements(p_payload->'participantes') LOOP
   IF item ? 'participante_id' THEN
    BEGIN participant:=(item->>'participante_id')::uuid;EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Participant UUID invalid';END;
    SELECT * INTO p FROM public.torneo_participantes WHERE id=participant AND torneo_id=t.id;
    IF NOT FOUND OR (NOT manage AND p.creado_por<>p_actor_id AND p.linked_user_id IS DISTINCT FROM p_actor_id) THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Participant scope denied';END IF;
   ELSE
    IF coalesce(item->>'tipo_identidad','') NOT IN('generico','plaza_pendiente') THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Participant type invalid';END IF;
    name:=trim(coalesce(item->>'nombre',''));
    IF length(name)>100 OR(item->>'tipo_identidad'='generico' AND name='') THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Participant name invalid';END IF;
    INSERT INTO public.torneo_participantes(torneo_id,sede_id,nombre,tipo_identidad,origen,creado_por)
     VALUES(t.id,t.sede_id,name,item->>'tipo_identidad',CASE WHEN manage THEN 'club' ELSE 'capitan' END,p_actor_id) RETURNING * INTO p;
   END IF;
   IF p.id=ANY(selected) THEN RAISE EXCEPTION USING ERRCODE='23505',MESSAGE='Duplicate participant in roster';END IF;
   selected:=array_append(selected,p.id);
  END LOOP;
  IF coalesce(cardinality(selected),0)<1 OR cardinality(selected)>lim_max THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Roster capacity exceeded';END IF;
  IF EXISTS(SELECT 1 FROM public.torneo_participante_equipos WHERE torneo_id=t.id AND participante_id=ANY(selected)) THEN RAISE EXCEPTION USING ERRCODE='23505',MESSAGE='Participant already enrolled';END IF;
  -- Legacy snapshots must also prevent the same authenticated person joining twice.
  IF EXISTS(SELECT 1 FROM public.equipos eq CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(eq.jugadores)='array' THEN eq.jugadores ELSE '[]'::jsonb END) j
   WHERE eq.torneo_id=t.id AND lower(coalesce(j->>'user_id',j->>'id')) IN(SELECT linked_user_id::text FROM public.torneo_participantes WHERE id=ANY(selected) AND linked_user_id IS NOT NULL)) THEN RAISE EXCEPTION USING ERRCODE='23505',MESSAGE='Account already enrolled';END IF;
  SELECT jsonb_agg(jsonb_build_object('participante_id',pp.id,'nombre',pp.nombre,'tipo_identidad',pp.tipo_identidad,'estado_vinculacion',pp.estado_vinculacion,
   'user_id',CASE WHEN pp.origen='cuenta' THEN pp.linked_user_id ELSE NULL END,'ranking_oficial_elegible',false,
   'estado',CASE WHEN pp.tipo_identidad='plaza_pendiente' THEN 'pendiente' ELSE 'confirmado' END) ORDER BY array_position(selected,pp.id)) INTO roster FROM public.torneo_participantes pp WHERE pp.id=ANY(selected);
  INSERT INTO public.equipos(torneo_id,sede_id,nombre,creador_id,jugadores,solicitudes,cupo_maximo,equipo_abierto,tipo_equipo,inscripcion_estado,modalidad_plantel)
   VALUES(t.id,t.sede_id,trim(p_payload->>'nombre'),p_actor_id,roster,'[]'::jsonb,lim_max,false,'cerrado','confirmado',mode) RETURNING * INTO e;
  INSERT INTO public.torneo_participante_equipos(torneo_id,participante_id,equipo_id,cuenta_user_id)
   SELECT t.id,pp.id,e.id,pp.linked_user_id FROM public.torneo_participantes pp WHERE pp.id=ANY(selected);
  receipt:=jsonb_build_object('ok',true,'torneo_id',t.id,'status','created','equipo',to_jsonb(e),'torneo',jsonb_build_object('modalidad_plantel',mode,'formato_equipo',t.formato_equipo));
 ELSIF p_accion='solicitar_vinculacion' THEN
  SELECT * INTO p FROM public.torneo_participantes WHERE id=(p_payload->>'participante_id')::uuid AND torneo_id=t.id FOR UPDATE;
  IF NOT FOUND OR (NOT manage AND p.creado_por<>p_actor_id AND NOT EXISTS(SELECT 1 FROM public.torneo_participante_equipos own WHERE own.participante_id=p.id AND own.torneo_id=t.id)) THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Participant claim scope denied';END IF;
  IF p.tipo_identidad<>'generico' OR p.linked_user_id IS NOT NULL OR profile.user_id IS NULL OR trim(coalesce(profile.nombre,''))='' THEN RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='Identity is not claimable';END IF;
  IF EXISTS(SELECT 1 FROM public.torneo_participantes WHERE torneo_id=t.id AND linked_user_id=p_actor_id) THEN RAISE EXCEPTION USING ERRCODE='23505',MESSAGE='Account already linked in tournament';END IF;
  IF EXISTS(SELECT 1 FROM public.equipos old CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(old.jugadores)='array' THEN old.jugadores ELSE '[]'::jsonb END) j WHERE old.torneo_id=t.id AND lower(coalesce(j->>'user_id',j->>'id'))=p_actor_id::text) THEN RAISE EXCEPTION USING ERRCODE='23505',MESSAGE='Account already belongs to a legacy roster';END IF;
  INSERT INTO public.torneo_participante_vinculaciones(torneo_id,participante_id,user_id) VALUES(t.id,p.id,p_actor_id)
   ON CONFLICT(participante_id,user_id) DO UPDATE SET estado='pendiente',resuelto_por=NULL,resolved_at=NULL RETURNING * INTO v;
  UPDATE public.torneo_participantes SET estado_vinculacion='pendiente' WHERE id=p.id;
  receipt:=jsonb_build_object('ok',true,'torneo_id',t.id,'status','created','solicitud',jsonb_build_object('id',v.id,'participante_id',p.id,'estado',v.estado));
 ELSE
  IF NOT manage THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Club scope required';END IF;
  SELECT * INTO v FROM public.torneo_participante_vinculaciones WHERE id=(p_payload->>'solicitud_id')::uuid AND torneo_id=t.id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0002',MESSAGE='Claim missing';END IF;
  IF v.estado<>'pendiente' THEN RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='Claim already resolved';END IF;
  SELECT * INTO p FROM public.torneo_participantes WHERE id=v.participante_id FOR UPDATE;
  IF p_payload->>'decision' NOT IN('aprobar','rechazar') OR p_payload->>'decision' IS NULL THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Claim decision invalid';END IF;
  IF p_payload->>'decision'='aprobar' THEN
   IF p.tipo_identidad<>'generico' OR p.linked_user_id IS NOT NULL THEN RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='Identity already linked';END IF;
   IF EXISTS(SELECT 1 FROM public.equipos old CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(old.jugadores)='array' THEN old.jugadores ELSE '[]'::jsonb END) j WHERE old.torneo_id=t.id AND lower(coalesce(j->>'user_id',j->>'id'))=v.user_id::text) THEN RAISE EXCEPTION USING ERRCODE='23505',MESSAGE='Account already belongs to a legacy roster';END IF;
   UPDATE public.torneo_participantes SET linked_user_id=v.user_id,estado_vinculacion='vinculado' WHERE id=p.id RETURNING * INTO p;
   UPDATE public.torneo_participante_equipos SET cuenta_user_id=v.user_id WHERE participante_id=p.id;
   -- Historical team snapshots and point ledgers deliberately remain unchanged.
  ELSE
   UPDATE public.torneo_participantes SET estado_vinculacion=CASE WHEN linked_user_id IS NOT NULL THEN 'vinculado' WHEN EXISTS(SELECT 1 FROM public.torneo_participante_vinculaciones other WHERE other.participante_id=p.id AND other.id<>v.id AND other.estado='pendiente') THEN 'pendiente' ELSE 'sin_cuenta' END WHERE id=p.id RETURNING * INTO p;
  END IF;
  UPDATE public.torneo_participante_vinculaciones SET estado=CASE WHEN p_payload->>'decision'='aprobar' THEN 'aprobado' ELSE 'rechazado' END,resuelto_por=p_actor_id,resolved_at=now() WHERE id=v.id RETURNING * INTO v;
  receipt:=jsonb_build_object('ok',true,'torneo_id',t.id,'status','updated','solicitud',jsonb_build_object('id',v.id,'participante_id',p.id,'estado',v.estado),'participante',to_jsonb(p));
 END IF;
 INSERT INTO public.torneo_participante_operaciones(torneo_id,request_id,actor_id,accion,payload,receipt) VALUES(t.id,req,p_actor_id,p_accion,p_payload,receipt);
 RETURN receipt;
END $function$
