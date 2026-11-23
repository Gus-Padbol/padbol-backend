-- CANDIDATE — NOT AUTO-APPLIED. Additive function only: no table, column,
-- constraint, trigger, RLS or existing-role changes.
-- Target project: vpldffhsxhgnmitiikof. Apply only after review in an
-- authorized window. Footprint taken from METADATOS-ALTAS-ROOT.json
-- (2026-11-23): columns/types/defaults/constraints/FKs/RLS as reported there.
--
-- Scope: DB portion of POST /api/invitacion/:token/completar for the CLUB
-- invite flow (invited_role = admin_club, no territorial scope). It is one
-- durable transaction: claim the invitation row by token (FOR UPDATE), create
-- the seat, its sports, the admin_club role binding and consume the invitation
-- in the same commit. Any failure rolls every one of those writes back.
-- Supabase Auth user creation and welcome email remain OUTSIDE PostgreSQL with
-- the previously accepted semantics and are not part of this transaction.
--
-- The function derives identity/role from the invitation row; the caller only
-- supplies the token, the verified contact email and the seat payload. It does
-- not accept a role, user id, ownership id or arbitrary column passthrough.

BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '20s';

-- Fail closed (instead of creating a partial routine) if the expected
-- invitation footprint is absent or drifted.
DO $pre$
BEGIN
  IF to_regclass('public.invitaciones_admin') IS NULL
     OR to_regclass('public.sedes') IS NULL
     OR to_regclass('public.canchas_por_deporte') IS NULL
     OR to_regclass('public.user_roles') IS NULL THEN
    RAISE EXCEPTION 'INVITACION_ATOMICA_SCHEMA_MISSING';
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint k
      JOIN pg_class c ON c.oid = k.conrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname = 'invitaciones_admin'
       AND k.conname = 'invitaciones_admin_token_key'
  ) THEN
    RAISE EXCEPTION 'INVITACION_ATOMICA_TOKEN_UNIQUE_MISSING';
  END IF;
END $pre$;

CREATE OR REPLACE FUNCTION public.completar_invitacion_club_atomica(
  p_token text,
  p_email text,
  p_nombre_admin text,
  p_sede jsonb,
  p_deportes jsonb
) RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  -- Same allowlist as DEPORTES_SEDE_VALID in routes/commercialRelease.js.
  c_deportes CONSTANT text[] := ARRAY['padbol','padel','pickleball','squash','tenis','futbol_5','futbol_7'];
  v_token text := btrim(coalesce(p_token, ''));
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_nombre_admin text := nullif(btrim(coalesce(p_nombre_admin, '')), '');
  v_inv public.invitaciones_admin%ROWTYPE;
  v_sede public.sedes%ROWTYPE;
  v_sede_id bigint;
  v_role_id bigint;
  v_nombre text;
  v_pais text;
  v_ciudad text;
  v_provincia text;
  v_direccion text;
  v_telefono text;
  v_whatsapp text;
  v_horario_apertura text;
  v_horario_cierre text;
  v_moneda text;
  v_metodo_pago text;
  v_timezone text;
  v_google_maps_url text;
  v_stripe_account_id text;
  v_mp_access_token text;
  v_mp_public_key text;
  v_pago_manual text;
  v_precio_por_reserva integer;
  v_cantidad_canchas integer;
  v_latitud numeric;
  v_longitud numeric;
  v_deporte jsonb;
  v_dep text;
  v_deportes_n integer := 0;
  v_canchas_n integer := 0;
BEGIN
  -- ---- token / invitation claim (natural per-token lock) ------------------
  IF length(v_token) < 16 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_found');
  END IF;

  SELECT * INTO v_inv
    FROM public.invitaciones_admin
   WHERE token = v_token
     FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_found');
  END IF;
  IF v_inv.estado <> 'pendiente' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'consumed', 'estado', v_inv.estado);
  END IF;
  IF v_inv.expires_at IS NULL OR v_inv.expires_at <= now() THEN
    UPDATE public.invitaciones_admin
       SET estado = 'expirada'
     WHERE id = v_inv.id AND estado = 'pendiente';
    RETURN jsonb_build_object('ok', false, 'reason', 'expired');
  END IF;

  -- ---- identity / role validation against the invitation row --------------
  -- The contact email must be the invited one; the body cannot route the role.
  IF v_email = '' OR position('@' IN v_email) = 0
     OR v_email IS DISTINCT FROM lower(btrim(v_inv.email)) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'email_mismatch');
  END IF;
  IF p_sede ? 'email_contacto'
     AND nullif(btrim(coalesce(p_sede->>'email_contacto', '')), '') IS NOT NULL
     AND lower(btrim(p_sede->>'email_contacto')) <> v_email THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'email_mismatch');
  END IF;
  IF lower(btrim(coalesce(v_inv.invited_role, 'admin_club'))) <> 'admin_club'
     OR lower(btrim(coalesce(v_inv.invited_alcance, ''))) NOT IN ('', 'sede') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'role_not_allowed');
  END IF;

  -- ---- payload validation (server-side, inside the transaction) ----------
  IF p_sede IS NULL OR jsonb_typeof(p_sede) <> 'object'
     OR p_deportes IS NULL OR jsonb_typeof(p_deportes) <> 'array'
     OR jsonb_array_length(p_deportes) = 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_payload', 'detail', 'payload');
  END IF;

  v_nombre := nullif(btrim(coalesce(p_sede->>'nombre', '')), '');
  v_pais := nullif(btrim(coalesce(p_sede->>'pais', '')), '');
  v_ciudad := nullif(btrim(coalesce(p_sede->>'ciudad', '')), '');
  IF v_nombre IS NULL OR length(v_nombre) > 200 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_payload', 'detail', 'nombre');
  END IF;
  IF v_pais IS NULL OR length(v_pais) > 100 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_payload', 'detail', 'pais');
  END IF;
  IF v_ciudad IS NULL OR length(v_ciudad) > 120 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_payload', 'detail', 'ciudad');
  END IF;

  v_provincia := nullif(btrim(coalesce(p_sede->>'provincia', '')), '');
  v_direccion := nullif(btrim(coalesce(p_sede->>'direccion', '')), '');
  v_telefono := nullif(btrim(coalesce(p_sede->>'telefono', '')), '');
  v_whatsapp := nullif(btrim(coalesce(p_sede->>'whatsapp_contacto', '')), '');
  IF v_whatsapp IS NULL OR length(v_whatsapp) > 40 OR length(coalesce(v_telefono, '')) > 40 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_payload', 'detail', 'whatsapp_contacto');
  END IF;
  IF length(coalesce(v_direccion, '')) > 300 OR length(coalesce(v_provincia, '')) > 120 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_payload', 'detail', 'direccion');
  END IF;

  v_horario_apertura := nullif(btrim(coalesce(p_sede->>'horario_apertura', '')), '');
  v_horario_cierre := nullif(btrim(coalesce(p_sede->>'horario_cierre', '')), '');
  IF v_horario_apertura IS NULL OR v_horario_apertura !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
     OR v_horario_cierre IS NULL OR v_horario_cierre !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_payload', 'detail', 'horario');
  END IF;

  -- sedes.cantidad_canchas / precio_por_reserva / precio_turno are integer/int4
  -- and numeric respectively in the supplied metadata.
  IF coalesce(p_sede->>'cantidad_canchas', '') !~ '^[0-9]{1,4}$' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_payload', 'detail', 'cantidad_canchas');
  END IF;
  v_cantidad_canchas := (p_sede->>'cantidad_canchas')::integer;
  IF v_cantidad_canchas > 500 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_payload', 'detail', 'cantidad_canchas');
  END IF;
  IF coalesce(p_sede->>'precio_por_reserva', '') !~ '^[0-9]{1,9}$' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_payload', 'detail', 'precio_por_reserva');
  END IF;
  v_precio_por_reserva := (p_sede->>'precio_por_reserva')::integer;

  v_moneda := upper(coalesce(nullif(btrim(p_sede->>'moneda'), ''), 'ARS'));
  IF v_moneda !~ '^[A-Z]{2,8}$' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_payload', 'detail', 'moneda');
  END IF;
  v_metodo_pago := lower(coalesce(nullif(btrim(p_sede->>'metodo_pago'), ''), 'mercadopago'));
  IF v_metodo_pago NOT IN ('mercadopago', 'stripe', 'manual', 'efectivo') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_payload', 'detail', 'metodo_pago');
  END IF;
  v_timezone := coalesce(nullif(btrim(p_sede->>'timezone'), ''), 'America/Argentina/Buenos_Aires');
  IF v_timezone !~ '^[A-Za-z0-9_+/-]{1,64}$' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_payload', 'detail', 'timezone');
  END IF;

  v_google_maps_url := nullif(btrim(coalesce(p_sede->>'google_maps_url', '')), '');
  IF length(coalesce(v_google_maps_url, '')) > 2000 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_payload', 'detail', 'google_maps_url');
  END IF;
  v_stripe_account_id := nullif(btrim(coalesce(p_sede->>'stripe_account_id', '')), '');
  v_mp_access_token := nullif(btrim(coalesce(p_sede->>'mp_access_token', '')), '');
  v_mp_public_key := nullif(btrim(coalesce(p_sede->>'mp_public_key', '')), '');
  v_pago_manual := nullif(btrim(coalesce(p_sede->>'pago_manual_instrucciones', '')), '');
  IF length(coalesce(v_stripe_account_id, '')) > 255
     OR length(coalesce(v_mp_access_token, '')) > 2000
     OR length(coalesce(v_mp_public_key, '')) > 2000
     OR length(coalesce(v_pago_manual, '')) > 4000 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_payload', 'detail', 'payment');
  END IF;

  IF nullif(btrim(coalesce(p_sede->>'latitud', '')), '') IS NOT NULL THEN
    IF btrim(p_sede->>'latitud') !~ '^-?[0-9]{1,3}(\.[0-9]{1,8})?$' THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'invalid_payload', 'detail', 'latitud');
    END IF;
    v_latitud := btrim(p_sede->>'latitud')::numeric;
    IF v_latitud < -90 OR v_latitud > 90 THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'invalid_payload', 'detail', 'latitud');
    END IF;
  END IF;
  IF nullif(btrim(coalesce(p_sede->>'longitud', '')), '') IS NOT NULL THEN
    IF btrim(p_sede->>'longitud') !~ '^-?[0-9]{1,3}(\.[0-9]{1,8})?$' THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'invalid_payload', 'detail', 'longitud');
    END IF;
    v_longitud := btrim(p_sede->>'longitud')::numeric;
    IF v_longitud < -180 OR v_longitud > 180 THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'invalid_payload', 'detail', 'longitud');
    END IF;
  END IF;

  FOR v_deporte IN SELECT value FROM jsonb_array_elements(p_deportes) LOOP
    IF jsonb_typeof(v_deporte) <> 'object' THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'invalid_payload', 'detail', 'deportes');
    END IF;
    v_dep := lower(btrim(coalesce(v_deporte->>'deporte', '')));
    IF NOT (v_dep = ANY (c_deportes)) THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'invalid_payload', 'detail', 'deportes');
    END IF;
    IF coalesce(v_deporte->>'cantidad', '') !~ '^[0-9]{1,3}$' THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'invalid_payload', 'detail', 'deportes');
    END IF;
    IF (v_deporte->>'cantidad')::integer < 1 OR (v_deporte->>'cantidad')::integer > 200 THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'invalid_payload', 'detail', 'deportes');
    END IF;
    v_deportes_n := v_deportes_n + 1;
  END LOOP;
  IF v_deportes_n = 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_payload', 'detail', 'deportes');
  END IF;

  -- ---- business writes: all or nothing -----------------------------------
  -- Explicit column list. tipo_sede is forced to the club/reservable contract
  -- and email_contacto comes from the invitation, never from the client.
  INSERT INTO public.sedes (
    nombre, pais, ciudad, provincia, timezone, direccion, telefono, email_contacto,
    horario_apertura, horario_cierre, precio_turno, precio_por_reserva,
    cantidad_canchas, moneda, metodo_pago, whatsapp_contacto, google_maps_url,
    latitud, longitud, stripe_account_id, mp_access_token, mp_public_key,
    pago_manual_instrucciones, tipo_sede
  ) VALUES (
    v_nombre, v_pais, v_ciudad, v_provincia, v_timezone, v_direccion, v_telefono, v_email,
    v_horario_apertura, v_horario_cierre, v_precio_por_reserva, v_precio_por_reserva,
    v_cantidad_canchas, v_moneda, v_metodo_pago, v_whatsapp, v_google_maps_url,
    v_latitud, v_longitud, v_stripe_account_id, v_mp_access_token, v_mp_public_key,
    v_pago_manual, 'reservable'
  ) RETURNING * INTO v_sede;
  v_sede_id := v_sede.id;

  INSERT INTO public.canchas_por_deporte (sede_id, deporte, cantidad, activo)
  SELECT v_sede_id, lower(btrim(d->>'deporte')), (d->>'cantidad')::integer, true
    FROM jsonb_array_elements(p_deportes) AS d;
  GET DIAGNOSTICS v_canchas_n = ROW_COUNT;

  -- user_roles has no unique constraint on email in the supplied metadata.
  -- Serialize same-email bindings inside this transaction (durable PG lock,
  -- auto-released on commit/rollback) and reuse the existing binding instead
  -- of inserting a duplicate admin_club row.
  PERFORM pg_advisory_xact_lock(hashtextextended('invitacion_admin_club:' || v_email, 0));
  SELECT id INTO v_role_id
    FROM public.user_roles
   WHERE lower(btrim(coalesce(email, ''))) = v_email
   ORDER BY id
   LIMIT 1
     FOR UPDATE;
  IF v_role_id IS NOT NULL THEN
    UPDATE public.user_roles
       SET role = 'admin_club',
           alcance = 'sede',
           nombre = v_nombre_admin,
           pais = v_pais,
           ciudad = NULL,
           provincia = NULL,
           sede_id = v_sede_id,
           torneos_oficiales_habilitados = false
     WHERE id = v_role_id;
  ELSE
    INSERT INTO public.user_roles (
      email, role, alcance, nombre, pais, ciudad, provincia, sede_id,
      torneos_oficiales_habilitados
    ) VALUES (
      v_email, 'admin_club', 'sede', v_nombre_admin, v_pais, NULL, NULL, v_sede_id,
      false
    ) RETURNING id INTO v_role_id;
  END IF;

  UPDATE public.invitaciones_admin
     SET estado = 'completada', sede_id = v_sede_id
   WHERE id = v_inv.id AND estado = 'pendiente';
  IF NOT FOUND THEN
    -- Should be unreachable under the row lock; raise so the whole function
    -- transaction (seat, courts, role) rolls back instead of returning early.
    RAISE EXCEPTION 'INVITACION_ATOMICA_FINAL_MISMATCH';
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'invitation_id', v_inv.id,
    'sede_id', v_sede_id,
    'sede', to_jsonb(v_sede),
    'role_id', v_role_id,
    'canchas', v_canchas_n,
    'estado', 'completada'
  );
END;
$fn$;

-- Executable only by service_role (the existing server client). anon and
-- authenticated must never be able to call this routine directly.
REVOKE ALL ON FUNCTION public.completar_invitacion_club_atomica(text, text, text, jsonb, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.completar_invitacion_club_atomica(text, text, text, jsonb, jsonb)
  TO service_role;

DO $post$
DECLARE
  v_oid oid := 'public.completar_invitacion_club_atomica(text,text,text,jsonb,jsonb)'::regprocedure;
BEGIN
  IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = v_oid) THEN
    RAISE EXCEPTION 'INVITACION_ATOMICA_NOT_SECURITY_DEFINER';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p, unnest(p.proconfig) c
                  WHERE p.oid = v_oid AND c LIKE 'search_path=%') THEN
    RAISE EXCEPTION 'INVITACION_ATOMICA_SEARCH_PATH_NOT_FIXED';
  END IF;
  IF NOT has_function_privilege('service_role', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'INVITACION_ATOMICA_SERVICE_EXECUTE_MISSING';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon')
     AND has_function_privilege('anon', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'INVITACION_ATOMICA_ANON_EXECUTE_LEAK';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated')
     AND has_function_privilege('authenticated', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'INVITACION_ATOMICA_AUTHENTICATED_EXECUTE_LEAK';
  END IF;
END $post$;

NOTIFY pgrst, 'reload schema';
COMMIT;
