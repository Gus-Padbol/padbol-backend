-- LOCAL candidate only. No historic SQL edits or new roles/permissions.
-- Capacity counts registrations, not children. Same session row lock as
-- ng_confirm_registration/ng_promote_waitlist serializes capacity decisions.
BEGIN;
CREATE OR REPLACE FUNCTION public.ng_update_session(
 p_session_id uuid, p_patch jsonb, p_sede_scope bigint DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $fn$
DECLARE s public.ng_sesiones; v public.ng_sesiones; key text; confirmed integer;
BEGIN
 SELECT * INTO s FROM public.ng_sesiones WHERE id=p_session_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'NG_SESSION_NOT_FOUND' USING ERRCODE='P0002'; END IF;
 IF p_sede_scope IS NOT NULL AND s.sede_id IS DISTINCT FROM p_sede_scope THEN
  RAISE EXCEPTION 'NG_ADMIN_FORBIDDEN' USING ERRCODE='42501';
 END IF;
 IF jsonb_typeof(p_patch) IS DISTINCT FROM 'object' OR p_patch='{}'::jsonb THEN RAISE EXCEPTION 'NG_SESSION_UPDATE_EMPTY'; END IF;
 FOR key IN SELECT jsonb_object_keys(p_patch) LOOP
  IF NOT key=ANY(ARRAY['sede_id','nombre_publico','ciudad','pais','categoria','comienza_at','termina_at','cupo','estado']) THEN RAISE EXCEPTION 'NG_SESSION_UPDATE_INVALID'; END IF;
 END LOOP;
 v:=jsonb_populate_record(s,p_patch);
 IF p_sede_scope IS NOT NULL AND v.sede_id IS DISTINCT FROM p_sede_scope THEN RAISE EXCEPTION 'NG_ADMIN_FORBIDDEN' USING ERRCODE='42501'; END IF;
 IF v.sede_id IS NULL OR v.sede_id<=0 THEN RAISE EXCEPTION 'NG_SEDE_INVALID'; END IF;
 IF coalesce(v.nombre_publico,'')='' THEN RAISE EXCEPTION 'NG_SESSION_NAME_REQUIRED'; END IF;
 IF coalesce(v.categoria,'')='' THEN RAISE EXCEPTION 'NG_SESSION_CATEGORY_REQUIRED'; END IF;
 IF v.cupo IS NULL OR v.cupo<1 THEN RAISE EXCEPTION 'NG_SESSION_CAPACITY_INVALID'; END IF;
 IF v.estado IS NULL OR NOT v.estado=ANY(ARRAY['borrador','programada','activa','cerrada','cancelada']) THEN RAISE EXCEPTION 'NG_SESSION_STATUS_INVALID'; END IF;
 IF v.comienza_at IS NULL THEN RAISE EXCEPTION 'NG_SESSION_START_INVALID'; END IF;
 IF v.termina_at IS NOT NULL AND v.termina_at<=v.comienza_at THEN RAISE EXCEPTION 'NG_SESSION_DATES_INVALID'; END IF;
 -- Count AFTER obtaining the same lock that confirmation/promotion hold.
 IF p_patch ? 'cupo' THEN
  SELECT count(*) INTO confirmed FROM public.ng_inscripciones WHERE sesion_id=s.id AND estado='confirmada';
  IF v.cupo<confirmed THEN RAISE EXCEPTION 'NG_SESSION_CAPACITY_BELOW_CONFIRMED'; END IF;
 END IF;
 IF v.sede_id IS DISTINCT FROM s.sede_id AND EXISTS(SELECT 1 FROM public.ng_inscripciones WHERE sesion_id=s.id) THEN RAISE EXCEPTION 'NG_SESSION_HAS_REGISTRATIONS'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.sedes WHERE id=v.sede_id) THEN RAISE EXCEPTION 'NG_SEDE_INVALID'; END IF;
 UPDATE public.ng_sesiones SET sede_id=v.sede_id,nombre_publico=v.nombre_publico,ciudad=v.ciudad,pais=v.pais,categoria=v.categoria,
  comienza_at=v.comienza_at,termina_at=v.termina_at,cupo=v.cupo,estado=v.estado,updated_at=now() WHERE id=s.id RETURNING * INTO s;
 IF NOT FOUND THEN RAISE EXCEPTION 'NG_SESSION_UPDATE_UNAVAILABLE'; END IF;
 RETURN jsonb_build_object('id',s.id,'sede_id',s.sede_id,'nombre_publico',s.nombre_publico,'ciudad',s.ciudad,'pais',s.pais,
  'categoria',s.categoria,'comienza_at',s.comienza_at,'termina_at',s.termina_at,'cupo',s.cupo,'estado',s.estado);
END $fn$;
REVOKE ALL ON FUNCTION public.ng_update_session(uuid,jsonb,bigint) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.ng_update_session(uuid,jsonb,bigint) TO service_role;
-- Make the additive RPC visible to the existing PostgREST service after commit.
NOTIFY pgrst, 'reload schema';
COMMIT;
