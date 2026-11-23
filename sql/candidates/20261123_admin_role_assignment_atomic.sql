-- LOCAL CANDIDATE ONLY. Already-permitted SuperAdmin non-editor assignments.
-- No global email UNIQUE, no role/table/RLS change, no merging/deleting old rows.
BEGIN;
CREATE OR REPLACE FUNCTION public.asignar_rol_admin_atomico(p_actor_id uuid,p_payload jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET lock_timeout='3s' AS $fn$
DECLARE
 target_email text; target_role text; target_scope text; target_venue bigint;
 target_org uuid; target_country text; target_province text; target_city text;
 ids bigint[]; r public.user_roles; affected integer; key text;
BEGIN
 -- Revalidate the authenticated server actor and hold its authorization row.
 IF (SELECT count(*) FROM public.user_roles WHERE user_id=p_actor_id)<>1 THEN
  RAISE EXCEPTION 'ADMIN_ROLE_FORBIDDEN' USING ERRCODE='42501';
 END IF;
 PERFORM 1 FROM public.user_roles WHERE user_id=p_actor_id AND lower(btrim(role))='super_admin'
  AND coalesce(nullif(alcance,''),'global')='global' FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'ADMIN_ROLE_FORBIDDEN' USING ERRCODE='42501'; END IF;
 IF jsonb_typeof(p_payload) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'ADMIN_ROLE_INVALID_PAYLOAD' USING ERRCODE='22023'; END IF;
 FOR key IN SELECT jsonb_object_keys(p_payload) LOOP
  IF NOT key=ANY(ARRAY['email','role','alcance','nombre','sede_id','organizacion_id','pais','provincia','ciudad','torneos_oficiales_habilitados']) THEN
   RAISE EXCEPTION 'ADMIN_ROLE_INVALID_FIELD' USING ERRCODE='22023';
  END IF;
 END LOOP;
 target_email:=lower(btrim(coalesce(p_payload->>'email','')));
 target_role:=lower(btrim(coalesce(p_payload->>'role','')));
 target_scope:=lower(btrim(coalesce(p_payload->>'alcance','')));
 IF target_email='' OR target_role NOT IN('admin_club','admin_cadena','admin_nacional','empleado')
  OR target_scope NOT IN('sede','organizacion','ciudad','provincia','pais')
  OR (target_role='admin_cadena' AND target_scope<>'organizacion')
  OR (target_role<>'admin_cadena' AND target_scope='organizacion')
  OR (target_role='empleado' AND target_scope<>'sede') THEN
  RAISE EXCEPTION 'ADMIN_ROLE_INVALID_ASSIGNMENT' USING ERRCODE='22023';
 END IF;
 IF target_scope='sede' THEN
  IF coalesce(p_payload->>'sede_id','') !~ '^[1-9][0-9]*$' THEN RAISE EXCEPTION 'ADMIN_ROLE_INVALID_SEDE' USING ERRCODE='22023'; END IF;
  target_venue:=(p_payload->>'sede_id')::bigint;
 ELSIF target_scope='organizacion' THEN
  target_org:=nullif(p_payload->>'organizacion_id','')::uuid;
  IF target_org IS NULL THEN RAISE EXCEPTION 'ADMIN_ROLE_INVALID_ORGANIZATION' USING ERRCODE='22023'; END IF;
 END IF;
 IF target_scope IN('ciudad','provincia','pais') THEN
  target_country:=nullif(btrim(p_payload->>'pais'),'');
  IF target_country IS NULL THEN RAISE EXCEPTION 'ADMIN_ROLE_TERRITORY_REQUIRED' USING ERRCODE='22023'; END IF;
 END IF;
 IF target_scope IN('ciudad','provincia') THEN
  target_province:=nullif(btrim(p_payload->>'provincia'),'');
  IF target_province IS NULL THEN RAISE EXCEPTION 'ADMIN_ROLE_TERRITORY_REQUIRED' USING ERRCODE='22023'; END IF;
 END IF;
 IF target_scope='ciudad' THEN
  target_city:=nullif(btrim(p_payload->>'ciudad'),'');
  IF target_city IS NULL THEN RAISE EXCEPTION 'ADMIN_ROLE_TERRITORY_REQUIRED' USING ERRCODE='22023'; END IF;
 END IF;
 -- Same namespace as accepted club invitation and pending approval RPCs.
 PERFORM pg_advisory_xact_lock(hashtextextended('invitacion_admin_club:'||target_email,0));
 SELECT array_agg(locked.id) INTO ids FROM (
  SELECT id FROM public.user_roles WHERE lower(btrim(email))=target_email ORDER BY id FOR UPDATE
 ) locked;
 IF cardinality(ids)>1 THEN RETURN jsonb_build_object('ok',false,'reason','ambiguous_email'); END IF;
 IF cardinality(ids)=1 THEN
  UPDATE public.user_roles SET email=target_email,role=target_role,alcance=target_scope,
   nombre=nullif(btrim(p_payload->>'nombre'),''),sede_id=target_venue,organizacion_id=target_org,
   pais=target_country,provincia=target_province,ciudad=target_city,
   torneos_oficiales_habilitados=(target_role='admin_nacional') WHERE id=ids[1] RETURNING * INTO r;
 ELSE
  INSERT INTO public.user_roles(email,role,alcance,nombre,sede_id,organizacion_id,pais,provincia,ciudad,torneos_oficiales_habilitados)
   VALUES(target_email,target_role,target_scope,nullif(btrim(p_payload->>'nombre'),''),target_venue,target_org,target_country,target_province,target_city,target_role='admin_nacional') RETURNING * INTO r;
 END IF;
 GET DIAGNOSTICS affected=ROW_COUNT;
 IF affected<>1 OR r.id IS NULL THEN RAISE EXCEPTION 'ADMIN_ROLE_WRITE_SUPPRESSED'; END IF;
 RETURN jsonb_build_object('ok',true,'row',to_jsonb(r));
END $fn$;
REVOKE ALL ON FUNCTION public.asignar_rol_admin_atomico(uuid,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.asignar_rol_admin_atomico(uuid,jsonb) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
