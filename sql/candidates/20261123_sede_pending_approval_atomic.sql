-- LOCAL CANDIDATE ONLY. Pending approval DB portion; Auth remains outside.
-- Requires reviewed effective sedes/sedes_pendientes/user_roles/organization schema.
-- No table/column/role/RLS change; no automatic application.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='20s';
CREATE OR REPLACE FUNCTION public.aprobar_sede_pendiente_atomica(
 p_request_id bigint,p_actor_id uuid,p_expected jsonb,p_sede jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $fn$
DECLARE
 p public.sedes_pendientes; s public.sedes; k text; columns_sql text;
 v_email text; preserve_chain boolean; assignment_role text; scope text;
 country text; province text; city text; written integer; expected_roles integer;
 allowed constant text[]:=ARRAY['nombre','direccion','ciudad','provincia','pais','timezone','latitud','longitud','horario_apertura','horario_cierre','precio_turno','precio_por_reserva','moneda','metodo_pago','stripe_account_id','mp_access_token','mp_public_key','pago_manual_instrucciones','telefono','email_contacto','cantidad_canchas','numero_licencia','fecha_licencia','licencia_activa','franjas_horarias','fotos_destacadas','whatsapp_contacto'];
BEGIN
 -- Actor comes from verified server identity, never a body field. Rechecked in DB.
 PERFORM 1 FROM public.user_roles r WHERE r.user_id=p_actor_id AND r.role='super_admin' FOR SHARE;
 IF p_actor_id IS NULL OR NOT FOUND THEN
  RAISE EXCEPTION 'SEDE_APPROVAL_FORBIDDEN' USING ERRCODE='42501';
 END IF;
 SELECT * INTO p FROM public.sedes_pendientes WHERE id=p_request_id FOR UPDATE;
 IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'reason','not_found'); END IF;
 IF p.estado IS DISTINCT FROM 'pendiente' THEN RETURN jsonb_build_object('ok',false,'reason','not_pending'); END IF;
 IF jsonb_typeof(p_expected) IS DISTINCT FROM 'object' OR jsonb_typeof(p_sede) IS DISTINCT FROM 'object' THEN
  RETURN jsonb_build_object('ok',false,'reason','changed');
 END IF;
 -- Auth provisioning may take time. Never install a stale application snapshot.
 -- Ignore only metadata created_at. JSONB compares numeric values semantically:
 -- PostgREST 100.00 -> JavaScript 100 is unchanged, not a stale snapshot.
 FOR k IN SELECT jsonb_object_keys(to_jsonb(p)) LOOP
  IF k<>'created_at' AND p_expected->k IS DISTINCT FROM to_jsonb(p)->k THEN
   RETURN jsonb_build_object('ok',false,'reason','changed');
  END IF;
 END LOOP;
 v_email:=lower(btrim(coalesce(p.licenciatario_email,'')));
 IF v_email !~ '^[^@[:space:]]+@[^@[:space:]]+$' THEN RAISE EXCEPTION 'SEDE_APPROVAL_INVALID_EMAIL'; END IF;
 FOR k IN SELECT jsonb_object_keys(p_sede) LOOP
  IF NOT(k=ANY(allowed)) THEN RAISE EXCEPTION 'SEDE_APPROVAL_COLUMN_NOT_ALLOWED'; END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM unnest(ARRAY['nombre','pais','ciudad','horario_apertura','horario_cierre','whatsapp_contacto']) f WHERE coalesce(btrim(p_sede->>f),'')='')
  OR coalesce(p_sede->>'horario_apertura','') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
  OR coalesce(p_sede->>'horario_cierre','') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
  OR coalesce(p_sede->>'cantidad_canchas','') !~ '^[0-9]+$'
  OR coalesce(p_sede->>'precio_por_reserva','') !~ '^[0-9]+$' THEN RAISE EXCEPTION 'SEDE_APPROVAL_INVALID_CONFIGURATION'; END IF;
 preserve_chain:=p.organizacion_id IS NOT NULL AND v_email=lower(btrim(coalesce(p.created_by,'')));
 assignment_role:='admin_club';scope:='sede';
 country:=coalesce(nullif(btrim(p.licenciatario_pais),''),nullif(btrim(p.pais),''));
 IF lower(btrim(coalesce(p.tipo_licencia,'club_afiliado'))) IN('master_ciudad','master_provincia','master_pais') THEN
  assignment_role:='admin_nacional';
  scope:=CASE lower(btrim(p.tipo_licencia)) WHEN 'master_ciudad' THEN 'ciudad' WHEN 'master_provincia' THEN 'provincia' ELSE 'pais' END;
  country:=CASE WHEN scope='pais' THEN coalesce(nullif(btrim(p.licenciatario_pais),''),nullif(btrim(p.pais),'')) ELSE nullif(btrim(p.pais),'') END;
  IF scope IN('ciudad','provincia') THEN province:=nullif(btrim(p.provincia),''); END IF;
  IF scope='ciudad' THEN city:=nullif(btrim(p.ciudad),''); END IF;
  IF NOT preserve_chain AND (country IS NULL OR (scope IN('ciudad','provincia') AND province IS NULL) OR (scope='ciudad' AND city IS NULL)) THEN RAISE EXCEPTION 'SEDE_APPROVAL_TERRITORY_REQUIRED'; END IF;
 END IF;
 -- One same-email namespace with the accepted invitation RPC. No process lock.
 PERFORM pg_advisory_xact_lock(hashtextextended('invitacion_admin_club:'||v_email,0));
 -- Only the fixed allowlist can become identifiers. Omitted columns keep defaults;
 -- JSON values are bound parameters, never interpolated SQL.
 SELECT string_agg(format('%I',key),',' ORDER BY key) INTO columns_sql FROM jsonb_object_keys(p_sede) key;
 EXECUTE format('INSERT INTO public.sedes(%s) SELECT %s FROM jsonb_populate_record(NULL::public.sedes,$1) RETURNING *',columns_sql,columns_sql) INTO s USING p_sede;
 IF s.id IS NULL THEN RAISE EXCEPTION 'SEDE_APPROVAL_WRITE_SUPPRESSED'; END IF;
 IF p.organizacion_id IS NOT NULL THEN
  INSERT INTO public.organizacion_sedes(organizacion_id,sede_id) VALUES(p.organizacion_id,s.id);
  GET DIAGNOSTICS written=ROW_COUNT; IF written<>1 THEN RAISE EXCEPTION 'SEDE_APPROVAL_WRITE_SUPPRESSED'; END IF;
 END IF;
 IF NOT preserve_chain THEN
  SELECT count(*) INTO expected_roles FROM public.user_roles r WHERE lower(btrim(r.email))=v_email;
  UPDATE public.user_roles r SET role=assignment_role,alcance=scope,nombre=nullif(btrim(p.licenciatario_nombre),''),
    sede_id=CASE WHEN scope='sede' THEN s.id ELSE NULL END,pais=country,provincia=province,ciudad=city,torneos_oficiales_habilitados=(assignment_role='admin_nacional')
   WHERE lower(btrim(r.email))=v_email;
  GET DIAGNOSTICS written=ROW_COUNT;
  IF written<>expected_roles THEN RAISE EXCEPTION 'SEDE_APPROVAL_ROLE_WRITE_SUPPRESSED'; END IF;
  IF expected_roles=0 THEN
   INSERT INTO public.user_roles(email,role,alcance,nombre,sede_id,pais,provincia,ciudad,torneos_oficiales_habilitados)
    VALUES(v_email,assignment_role,scope,nullif(btrim(p.licenciatario_nombre),''),CASE WHEN scope='sede' THEN s.id ELSE NULL END,country,province,city,assignment_role='admin_nacional');
   GET DIAGNOSTICS written=ROW_COUNT; IF written<>1 THEN RAISE EXCEPTION 'SEDE_APPROVAL_WRITE_SUPPRESSED'; END IF;
  END IF;
 END IF;
 UPDATE public.sedes_pendientes SET estado='aprobada' WHERE id=p.id AND estado='pendiente';
 GET DIAGNOSTICS written=ROW_COUNT;
 IF written<>1 OR NOT EXISTS(SELECT 1 FROM public.sedes_pendientes WHERE id=p.id AND estado='aprobada') THEN RAISE EXCEPTION 'SEDE_APPROVAL_FINAL_MISMATCH'; END IF;
 RETURN jsonb_build_object('ok',true,'sede_id',s.id);
END $fn$;
REVOKE ALL ON FUNCTION public.aprobar_sede_pendiente_atomica(bigint,uuid,jsonb,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.aprobar_sede_pendiente_atomica(bigint,uuid,jsonb,jsonb) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
