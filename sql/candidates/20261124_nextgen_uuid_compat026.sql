-- LOCAL QA schema candidate026. No table/column creation, data conversion, UUID-to-PP cast, or role creation.
BEGIN;
DO $schema$
BEGIN
 IF (SELECT atttypid FROM pg_attribute WHERE attrelid='public.ng_sesiones'::regclass AND attname='sede_id' AND NOT attisdropped) IS DISTINCT FROM 'uuid'::regtype
 OR (SELECT atttypid FROM pg_attribute WHERE attrelid='public.ng_solicitudes_sede'::regclass AND attname='canonical_sede_id' AND NOT attisdropped) IS DISTINCT FROM 'bigint'::regtype
 OR (SELECT atttypid FROM pg_attribute WHERE attrelid='public.ng_inscripciones'::regclass AND attname='sede_id' AND NOT attisdropped) IS DISTINCT FROM 'bigint'::regtype
 OR NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.ng_sesiones'::regclass AND conname='ng_sesiones_sede_id_fkey' AND confrelid='public.ng_solicitudes_sede'::regclass AND contype='f' AND convalidated)
 OR NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.ng_solicitudes_sede'::regclass AND conname='ng_solicitudes_sede_canonical_sede_id_fkey' AND confrelid='public.sedes'::regclass AND contype='f' AND convalidated)
 THEN RAISE EXCEPTION 'NG026_SCHEMA_INCOMPATIBLE'; END IF;
END $schema$;

-- Preserve every existing event label and add only labels already emitted by
-- the existing four RPCs and assignment service. No historical event rewrite.
DO $events$
DECLARE definition text; valid boolean;
BEGIN
 SELECT pg_get_constraintdef(oid),convalidated INTO definition,valid FROM pg_constraint
 WHERE conrelid='public.ng_inscripcion_eventos'::regclass AND conname='ng_inscripcion_eventos_tipo_check' AND contype='c';
 IF definition IS NULL OR valid IS DISTINCT FROM true OR md5(definition) NOT IN('f5d140179e3ef4ffcb7f2928a5698e5a','0ef246d3d2f50d84727963f16cc627ed') THEN RAISE EXCEPTION 'NG026_EVENT_CHECK_DRIFT'; END IF;
 IF md5(definition)='f5d140179e3ef4ffcb7f2928a5698e5a' THEN
  ALTER TABLE public.ng_inscripcion_eventos DROP CONSTRAINT ng_inscripcion_eventos_tipo_check;
  ALTER TABLE public.ng_inscripcion_eventos ADD CONSTRAINT ng_inscripcion_eventos_tipo_check CHECK (tipo=ANY(ARRAY['creada_confirmada','creada_espera','cancelada','promovida','corregida','derivada_club','confirmada','lista_espera','promovida_desde_espera','asignacion_actualizada']));
 END IF;
END $events$;

CREATE OR REPLACE FUNCTION public.ng_cancel_registration(p_registration_id uuid, p_actor text DEFAULT NULL::text, p_reason text DEFAULT NULL::text)
 RETURNS ng_inscripciones
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare r public.ng_inscripciones; old_state text; old_position integer;
begin
  select * into r from public.ng_inscripciones where id=p_registration_id for update;
  if not found then raise exception using errcode='P0002', message='NG_REGISTRATION_NOT_FOUND'; end if;
  if r.estado='cancelada' then return r; end if;
  old_state := r.estado; old_position := r.posicion_espera;
  update public.ng_inscripciones set estado='cancelada',posicion_espera=null,cancel_reason=nullif(trim(coalesce(p_reason,'')),''),updated_at=now() where id=r.id returning * into r;
  if old_state='en_espera' then update public.ng_inscripciones set posicion_espera=posicion_espera-1,updated_at=now() where sesion_id=r.sesion_id and estado='en_espera' and posicion_espera>old_position; end if;
  insert into public.ng_inscripcion_eventos(inscripcion_id,sesion_id,tipo,actor,detalle) values(r.id,r.sesion_id,'cancelada',p_actor,jsonb_build_object('motivo',p_reason));
  if old_state='confirmada' and r.sesion_id is not null then perform public.ng_promote_waitlist(r.sesion_id,p_actor); end if;
  return r;
end $function$;

CREATE OR REPLACE FUNCTION public.ng_confirm_registration(p_registration_id uuid, p_actor text DEFAULT NULL::text)
 RETURNS ng_inscripciones
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare r public.ng_inscripciones; s public.ng_sesiones; used integer; canonical_id bigint;
begin
  select * into r from public.ng_inscripciones where id = p_registration_id for update;
  if not found then raise exception using errcode = 'P0002', message = 'NG_REGISTRATION_NOT_FOUND'; end if;
  if r.estado = 'cancelada' then raise exception using errcode = 'P0001', message = 'NG_REGISTRATION_CANCELLED'; end if;

  if r.sesion_id is null or r.sede_id is null or nullif(trim(coalesce(r.categoria,'')), '') is null then
    raise exception using errcode = 'P0001', message = 'NG_ASSIGNMENT_REQUIRED';
  end if;
  select * into s from public.ng_sesiones where id = r.sesion_id for update;
  if not found then raise exception using errcode='P0001', message='NG_SESSION_INVALID'; end if;
  select canonical_sede_id into canonical_id from public.ng_solicitudes_sede where id=s.sede_id for share;
  if not found or canonical_id is null then raise exception 'NG_VENUE_UNLINKED'; end if;
  if canonical_id is distinct from r.sede_id then raise exception 'NG_SESSION_INVALID'; end if;
  if r.estado='confirmada' then return r; end if;
  select count(*) into used from public.ng_inscripciones where sesion_id = s.id and estado = 'confirmada' and id <> r.id;
  if s.cupo <= used then raise exception using errcode = 'P0001', message = 'NG_SESSION_FULL'; end if;
  update public.ng_inscripciones set estado='confirmada', posicion_espera=null, updated_at=now() where id=r.id returning * into r;
  insert into public.ng_inscripcion_eventos(inscripcion_id,sesion_id,tipo,actor) values(r.id,r.sesion_id,'confirmada',p_actor);
  return r;
end $function$;

CREATE OR REPLACE FUNCTION public.ng_promote_waitlist(p_session_id uuid, p_actor text DEFAULT NULL::text)
 RETURNS ng_inscripciones
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare r public.ng_inscripciones; s public.ng_sesiones; used integer; old_position integer; canonical_id bigint;
begin
  select * into s from public.ng_sesiones where id=p_session_id for update;
  if not found then raise exception using errcode='P0002', message='NG_SESSION_NOT_FOUND'; end if;
  select canonical_sede_id into canonical_id from public.ng_solicitudes_sede where id=s.sede_id for share;
  if not found or canonical_id is null then raise exception 'NG_VENUE_UNLINKED'; end if;
  select count(*) into used from public.ng_inscripciones where sesion_id=s.id and estado='confirmada';
  if s.cupo <= used then return null; end if;
  select * into r from public.ng_inscripciones where sesion_id=s.id and estado='en_espera' order by posicion_espera nulls last, created_at for update skip locked limit 1;
  if not found then return null; end if;
  if r.sede_id is distinct from canonical_id then raise exception 'NG_SESSION_INVALID'; end if;
  old_position := r.posicion_espera;
  update public.ng_inscripciones set estado='confirmada',posicion_espera=null,updated_at=now() where id=r.id returning * into r;
  update public.ng_inscripciones set posicion_espera=posicion_espera-1,updated_at=now() where sesion_id=s.id and estado='en_espera' and posicion_espera>coalesce(old_position,0);
  insert into public.ng_inscripcion_eventos(inscripcion_id,sesion_id,tipo,actor) values(r.id,r.sesion_id,'promovida_desde_espera',p_actor);
  return r;
end $function$;

CREATE OR REPLACE FUNCTION public.ng_waitlist_registration(p_registration_id uuid, p_actor text DEFAULT NULL::text)
 RETURNS ng_inscripciones
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare r public.ng_inscripciones; next_position integer; canonical_id bigint;
begin
  select * into r from public.ng_inscripciones where id=p_registration_id for update;
  if not found then raise exception using errcode='P0002', message='NG_REGISTRATION_NOT_FOUND'; end if;
  if r.estado='cancelada' then raise exception using errcode='P0001', message='NG_REGISTRATION_CANCELLED'; end if;

  if r.sesion_id is null then raise exception using errcode='P0001', message='NG_ASSIGNMENT_REQUIRED'; end if;
  select v.canonical_sede_id into canonical_id from public.ng_sesiones s join public.ng_solicitudes_sede v on v.id=s.sede_id where s.id=r.sesion_id for update of s for share of v;
  if not found or canonical_id is null then raise exception 'NG_VENUE_UNLINKED'; end if;
  if canonical_id is distinct from r.sede_id then raise exception 'NG_SESSION_INVALID'; end if;
  if r.estado='en_espera' then return r; end if;
  select coalesce(max(posicion_espera),0)+1 into next_position from public.ng_inscripciones where sesion_id=r.sesion_id and estado='en_espera';
  update public.ng_inscripciones set estado='en_espera', posicion_espera=next_position, updated_at=now() where id=r.id returning * into r;
  insert into public.ng_inscripcion_eventos(inscripcion_id,sesion_id,tipo,actor,detalle) values(r.id,r.sesion_id,'lista_espera',p_actor,jsonb_build_object('posicion',next_position));
  return r;
end $function$;
CREATE OR REPLACE FUNCTION public.ng_update_session(p_session_id uuid,p_patch jsonb,p_sede_scope bigint DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $fn$
DECLARE s public.ng_sesiones; v public.ng_sesiones; canonical_id bigint; target_id bigint; request_id uuid; ids uuid[]; key text; used integer;
BEGIN
 SELECT * INTO s FROM public.ng_sesiones WHERE id=p_session_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'NG_SESSION_NOT_FOUND'; END IF;
 SELECT canonical_sede_id INTO canonical_id FROM public.ng_solicitudes_sede WHERE id=s.sede_id FOR SHARE;
 IF NOT FOUND OR canonical_id IS NULL THEN RAISE EXCEPTION 'NG_VENUE_UNLINKED'; END IF;
 IF p_sede_scope IS NOT NULL AND canonical_id<>p_sede_scope THEN RAISE EXCEPTION 'NG_ADMIN_FORBIDDEN'; END IF;
 IF jsonb_typeof(p_patch) IS DISTINCT FROM 'object' OR p_patch='{}'::jsonb THEN RAISE EXCEPTION 'NG_SESSION_UPDATE_EMPTY'; END IF;
 FOR key IN SELECT jsonb_object_keys(p_patch) LOOP
  IF NOT key=ANY(ARRAY['sede_id','venue_request_id','nombre_publico','ciudad','pais','categoria','comienza_at','termina_at','cupo','estado']) THEN RAISE EXCEPTION 'NG_SESSION_UPDATE_INVALID'; END IF;
 END LOOP;
 target_id:=CASE WHEN p_patch?'sede_id' THEN (p_patch->>'sede_id')::bigint ELSE canonical_id END;
 IF target_id IS NULL OR target_id<=0 THEN RAISE EXCEPTION 'NG_SEDE_INVALID'; END IF;
 IF p_sede_scope IS NOT NULL AND target_id<>p_sede_scope THEN RAISE EXCEPTION 'NG_ADMIN_FORBIDDEN'; END IF;
 IF p_patch?'venue_request_id' THEN
  BEGIN request_id:=(p_patch->>'venue_request_id')::uuid; EXCEPTION WHEN invalid_text_representation THEN RAISE EXCEPTION 'NG_VENUE_REQUEST_INVALID'; END;
  PERFORM 1 FROM public.ng_solicitudes_sede WHERE id=request_id AND canonical_sede_id=target_id FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'NG_VENUE_UNLINKED'; END IF;
 ELSIF target_id=canonical_id THEN request_id:=s.sede_id;
 ELSE
  SELECT array_agg(id) INTO ids FROM (SELECT id FROM public.ng_solicitudes_sede WHERE canonical_sede_id=target_id FOR SHARE) mapped;
  IF coalesce(cardinality(ids),0)=0 THEN RAISE EXCEPTION 'NG_VENUE_UNLINKED'; END IF;
  IF cardinality(ids)<>1 THEN RAISE EXCEPTION 'NG_VENUE_AMBIGUOUS'; END IF;
  request_id:=ids[1];
 END IF;
 v:=jsonb_populate_record(s,p_patch-'sede_id'-'venue_request_id');v.sede_id:=request_id;
 IF coalesce(v.nombre_publico,'')='' THEN RAISE EXCEPTION 'NG_SESSION_NAME_REQUIRED'; END IF;
 IF v.categoria IS NULL OR NOT v.categoria=ANY(ARRAY['Sub-14','Sub-16','Sub-18']) THEN RAISE EXCEPTION 'NG_SESSION_CATEGORY_INVALID'; END IF;
 IF v.cupo IS NULL OR v.cupo<1 THEN RAISE EXCEPTION 'NG_SESSION_CAPACITY_INVALID'; END IF;
 IF v.estado IS NULL OR NOT v.estado=ANY(ARRAY['borrador','publicada','cerrada','cancelada']) THEN RAISE EXCEPTION 'NG_SESSION_STATUS_INVALID'; END IF;
 IF v.comienza_at IS NULL THEN RAISE EXCEPTION 'NG_SESSION_START_INVALID'; END IF;
 IF v.termina_at IS NULL OR v.termina_at<=v.comienza_at THEN RAISE EXCEPTION 'NG_SESSION_DATES_INVALID'; END IF;
 IF p_patch?'cupo' THEN SELECT count(*) INTO used FROM public.ng_inscripciones WHERE sesion_id=s.id AND estado='confirmada';IF v.cupo<used THEN RAISE EXCEPTION 'NG_SESSION_CAPACITY_BELOW_CONFIRMED'; END IF;END IF;
 IF v.sede_id IS DISTINCT FROM s.sede_id AND EXISTS(SELECT 1 FROM public.ng_inscripciones WHERE sesion_id=s.id) THEN RAISE EXCEPTION 'NG_SESSION_HAS_REGISTRATIONS'; END IF;
 UPDATE public.ng_sesiones SET sede_id=v.sede_id,nombre_publico=v.nombre_publico,ciudad=v.ciudad,pais=v.pais,categoria=v.categoria,comienza_at=v.comienza_at,termina_at=v.termina_at,cupo=v.cupo,estado=v.estado,updated_at=now() WHERE id=s.id RETURNING * INTO s;
 IF NOT FOUND THEN RAISE EXCEPTION 'NG_SESSION_UPDATE_UNAVAILABLE'; END IF;
 RETURN jsonb_build_object('id',s.id,'sede_id',target_id,'venue_request_id',s.sede_id,'nombre_publico',s.nombre_publico,'ciudad',s.ciudad,'pais',s.pais,'categoria',s.categoria,'comienza_at',s.comienza_at,'termina_at',s.termina_at,'cupo',s.cupo,'estado',s.estado);
END $fn$;

REVOKE ALL ON FUNCTION public.ng_confirm_registration(uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.ng_confirm_registration(uuid,text) TO service_role;
REVOKE ALL ON FUNCTION public.ng_waitlist_registration(uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.ng_waitlist_registration(uuid,text) TO service_role;
REVOKE ALL ON FUNCTION public.ng_promote_waitlist(uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.ng_promote_waitlist(uuid,text) TO service_role;
REVOKE ALL ON FUNCTION public.ng_cancel_registration(uuid,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.ng_cancel_registration(uuid,text,text) TO service_role;
REVOKE ALL ON FUNCTION public.ng_update_session(uuid,jsonb,bigint) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.ng_update_session(uuid,jsonb,bigint) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
