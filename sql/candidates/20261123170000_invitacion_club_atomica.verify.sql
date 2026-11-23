-- Verify for 20261123170000_invitacion_club_atomica.sql (candidate).
--
-- RUN ONLY ON AN ISOLATED LOCAL PostgreSQL (disposable cluster/PG17), after a
-- schema faithful to METADATOS-ALTAS-ROOT.json exists and the candidate SQL was
-- applied. DO NOT run against production or a shared database: it inserts
-- fixture rows (inside a transaction that is rolled back at the end) and it
-- creates temporary objects. It performs no external calls and no persistent
-- write.
--
-- It asserts: fixed SECURITY DEFINER/search_path, service_role-only EXECUTE,
-- single-commit seat+courts+role+invitation consumption, consumed token
-- returns a structured "consumed" result without duplicates, email/expiry/role
-- and payload validation happen before writes, and an injected failure after
-- the role binding but before the final invitation commit rolls back every
-- write and leaves the invitation retryable. Concurrency with two HTTP
-- sessions is covered by the new real HTTP+PG test owned by the tester.
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL statement_timeout = '30s';
SET LOCAL lock_timeout = '3s';

-- ---- static contract -------------------------------------------------------
DO $static$
DECLARE
  v_oid oid := 'public.completar_invitacion_club_atomica(text,text,text,jsonb,jsonb)'::regprocedure;
  v_def boolean;
  v_vol char;
BEGIN
  SELECT prosecdef, provolatile INTO v_def, v_vol FROM pg_proc WHERE oid = v_oid;
  IF v_def IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'VERIFY_FAILED: function is not SECURITY DEFINER';
  END IF;
  IF v_vol <> 'v' THEN
    RAISE EXCEPTION 'VERIFY_FAILED: function is not VOLATILE';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p, unnest(p.proconfig) c
     WHERE p.oid = v_oid AND c LIKE 'search_path=%'
       AND c NOT LIKE '%pg_temp%'
  ) THEN
    RAISE EXCEPTION 'VERIFY_FAILED: search_path is not fixed';
  END IF;
  IF NOT has_function_privilege('service_role', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'VERIFY_FAILED: service_role cannot execute';
  END IF;
  IF has_function_privilege('anon', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'VERIFY_FAILED: anon can execute';
  END IF;
  IF has_function_privilege('authenticated', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'VERIFY_FAILED: authenticated can execute';
  END IF;
END $static$;

-- anon must be rejected at execution time too, not only by the ACL check.
DO $anon$
BEGIN
  BEGIN
    EXECUTE 'SET LOCAL ROLE anon';
    BEGIN
      PERFORM public.completar_invitacion_club_atomica('atomica-verify-token-0001', 'x@verify.invalid', NULL, '{}'::jsonb, '[]'::jsonb);
      EXECUTE 'RESET ROLE';
      RAISE EXCEPTION 'VERIFY_FAILED: anon executed the atomic RPC';
    EXCEPTION WHEN insufficient_privilege THEN
      EXECUTE 'RESET ROLE';
    END;
  END;
END $anon$;

-- ---- fixture helpers -------------------------------------------------------
CREATE FUNCTION pg_temp.expect(cond boolean, msg text) RETURNS void
LANGUAGE plpgsql AS $expect$
BEGIN
  IF cond IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'VERIFY_FAILED: %', msg;
  END IF;
END
$expect$;

-- Previous assignment must survive a failed completion unchanged.
INSERT INTO public.sedes (
  id, nombre, pais, ciudad, horario_apertura, horario_cierre,
  precio_por_reserva, cantidad_canchas, whatsapp_contacto
) VALUES (
  999, 'Sede previa verify', 'Argentina', 'Rosario', '09:00', '22:00',
  1000, 1, '3410000000'
);
INSERT INTO public.user_roles (email, role, alcance, nombre, sede_id)
VALUES
  ('atomica1@verify.invalid', 'admin_club', 'sede', 'Asignacion previa 1', 999),
  ('atomica6@verify.invalid', 'admin_club', 'sede', 'Asignacion previa 6', 999);

INSERT INTO public.invitaciones_admin
  (email, token, pais, nombre_club, estado, expires_at, invited_role, invited_alcance)
VALUES
  ('atomica1@verify.invalid', 'atomica-verify-token-0001', 'Argentina', 'Club 1', 'pendiente', now() + interval '1 day', 'admin_club', NULL),
  ('atomica2@verify.invalid', 'atomica-verify-token-0002', 'Argentina', 'Club 2', 'pendiente', now() + interval '1 day', 'admin_club', NULL),
  ('atomica3@verify.invalid', 'atomica-verify-token-0003', 'Argentina', 'Club 3', 'pendiente', now() - interval '1 day', 'admin_club', NULL),
  ('atomica4@verify.invalid', 'atomica-verify-token-0004', 'Argentina', 'Club 4', 'pendiente', now() + interval '1 day', 'admin_club', NULL),
  ('atomica5@verify.invalid', 'atomica-verify-token-0005', 'Argentina', NULL,       'pendiente', now() + interval '1 day', 'admin_nacional', 'pais'),
  ('atomica6@verify.invalid', 'atomica-verify-token-0006', 'Argentina', 'Club 6', 'pendiente', now() + interval '1 day', 'admin_club', NULL),
  ('atomica7@verify.invalid', 'atomica-verify-token-0007', 'Argentina', 'Club 7', 'pendiente', now() + interval '1 day', 'admin_club', NULL);

-- Valid club payload (same shape the route sends). Extra keys must be ignored:
-- the routine never accepts role/user/scope passthrough from the payload.
DO $success$
DECLARE
  r jsonb;
  v_sede_id bigint;
  v_sede_before bigint;
  v_canchas_before bigint;
  v_role_before bigint;
  v_role_row public.user_roles%ROWTYPE;
BEGIN
  SELECT count(*) INTO v_sede_before FROM public.sedes WHERE id <> 999;
  SELECT count(*) INTO v_canchas_before FROM public.canchas_por_deporte;
  SELECT count(*) INTO v_role_before FROM public.user_roles;

  EXECUTE 'SET LOCAL ROLE service_role';
  SELECT public.completar_invitacion_club_atomica(
    'atomica-verify-token-0001',
    'atomica1@verify.invalid',
    'Admin Club 1',
    jsonb_build_object(
      'nombre', 'Club Atomico 1', 'pais', 'Argentina', 'ciudad', 'Rosario',
      'provincia', 'Santa Fe', 'timezone', 'America/Argentina/Buenos_Aires',
      'direccion', 'Calle 1', 'telefono', '3411111111',
      'horario_apertura', '09:00', 'horario_cierre', '22:00',
      'precio_por_reserva', 1500, 'precio_turno', 1500, 'cantidad_canchas', 1,
      'moneda', 'ARS', 'metodo_pago', 'mercadopago',
      'whatsapp_contacto', '3411111111', 'email_contacto', 'atomica1@verify.invalid',
      'latitud', -32.95, 'longitud', -60.65,
      'role', 'super_admin', 'alcance', 'pais', 'user_id', gen_random_uuid()
    ),
    '[{"deporte":"padbol","cantidad":2}]'::jsonb
  ) INTO r;
  EXECUTE 'RESET ROLE';

  PERFORM pg_temp.expect((r->>'ok')::boolean, 'valid club invitation did not complete');
  PERFORM pg_temp.expect((r->>'estado') = 'completada', 'returned estado is not completada');
  v_sede_id := (r->>'sede_id')::bigint;
  PERFORM pg_temp.expect(v_sede_id IS NOT NULL, 'no sede_id returned');
  PERFORM pg_temp.expect((r->'sede'->>'id')::bigint = v_sede_id, 'returned sede does not match sede_id');
  PERFORM pg_temp.expect((r->'sede'->>'tipo_sede') = 'reservable', 'tipo_sede is not reservable');
  PERFORM pg_temp.expect((r->'sede'->>'email_contacto') = 'atomica1@verify.invalid', 'email_contacto not taken from invitation');
  PERFORM pg_temp.expect((r->'sede'->>'nombre') = 'Club Atomico 1', 'seat payload not persisted');
  PERFORM pg_temp.expect((r->>'canchas')::integer = 1, 'unexpected court row count');
  PERFORM pg_temp.expect((SELECT count(*) FROM public.sedes WHERE id <> 999) = v_sede_before + 1, 'expected exactly one new seat');
  PERFORM pg_temp.expect((SELECT count(*) FROM public.canchas_por_deporte WHERE sede_id = v_sede_id) = 1, 'expected exactly one court row');
  PERFORM pg_temp.expect((SELECT count(*) FROM public.canchas_por_deporte) = v_canchas_before + 1, 'unexpected court rows');
  PERFORM pg_temp.expect((SELECT count(*) FROM public.user_roles) = v_role_before, 'role row was not reused');

  SELECT * INTO v_role_row FROM public.user_roles WHERE email = 'atomica1@verify.invalid';
  PERFORM pg_temp.expect(v_role_row.role = 'admin_club', 'role is not admin_club (payload role passthrough?)');
  PERFORM pg_temp.expect(v_role_row.alcance = 'sede', 'alcance is not sede');
  PERFORM pg_temp.expect(v_role_row.sede_id = v_sede_id, 'role not bound to the new seat');
  PERFORM pg_temp.expect(v_role_row.user_id IS NULL, 'user_id was taken from the payload');
  PERFORM pg_temp.expect((SELECT estado FROM public.invitaciones_admin WHERE token = 'atomica-verify-token-0001') = 'completada', 'invitation not consumed');
  PERFORM pg_temp.expect((SELECT sede_id FROM public.invitaciones_admin WHERE token = 'atomica-verify-token-0001') = v_sede_id, 'invitation not linked to the seat');

  -- Same token again: compatible consumed result, no duplicate writes.
  EXECUTE 'SET LOCAL ROLE service_role';
  SELECT public.completar_invitacion_club_atomica(
    'atomica-verify-token-0001', 'atomica1@verify.invalid', 'Admin Club 1',
    jsonb_build_object('nombre', 'Otro', 'pais', 'Argentina', 'ciudad', 'Rosario',
      'horario_apertura', '09:00', 'horario_cierre', '22:00', 'precio_por_reserva', 1,
      'cantidad_canchas', 1, 'whatsapp_contacto', '3411111111'),
    '[{"deporte":"padbol","cantidad":1}]'::jsonb
  ) INTO r;
  EXECUTE 'RESET ROLE';
  PERFORM pg_temp.expect((r->>'ok')::boolean IS NOT TRUE, 'consumed token returned ok');
  PERFORM pg_temp.expect((r->>'reason') = 'consumed', 'consumed token reason mismatch');
  PERFORM pg_temp.expect((r->>'estado') = 'completada', 'consumed token estado mismatch');
  PERFORM pg_temp.expect((SELECT count(*) FROM public.sedes WHERE id <> 999) = v_sede_before + 1, 'retry duplicated the seat');
  PERFORM pg_temp.expect((SELECT count(*) FROM public.canchas_por_deporte) = v_canchas_before + 1, 'retry duplicated courts');
END $success$;

-- ---- rejections happen before any write ------------------------------------
DO $rejections$
DECLARE
  r jsonb;
  v_sedes_before bigint;
  v_canchas_before bigint;
  v_roles_before bigint;
BEGIN
  SELECT count(*) INTO v_sedes_before FROM public.sedes;
  SELECT count(*) INTO v_canchas_before FROM public.canchas_por_deporte;
  SELECT count(*) INTO v_roles_before FROM public.user_roles;

  -- Email mismatch (wrong contact email).
  EXECUTE 'SET LOCAL ROLE service_role';
  SELECT public.completar_invitacion_club_atomica(
    'atomica-verify-token-0002', 'otro@verify.invalid', NULL,
    jsonb_build_object('nombre', 'Club 2', 'pais', 'Argentina', 'ciudad', 'Rosario',
      'horario_apertura', '09:00', 'horario_cierre', '22:00', 'precio_por_reserva', 100,
      'cantidad_canchas', 1, 'whatsapp_contacto', '3411111111'),
    '[{"deporte":"padbol","cantidad":1}]'::jsonb
  ) INTO r;
  EXECUTE 'RESET ROLE';
  PERFORM pg_temp.expect((r->>'reason') = 'email_mismatch', 'email mismatch was not rejected');
  PERFORM pg_temp.expect((SELECT estado FROM public.invitaciones_admin WHERE token = 'atomica-verify-token-0002') = 'pendiente', 'email mismatch consumed invitation');

  -- Expired invitation.
  EXECUTE 'SET LOCAL ROLE service_role';
  SELECT public.completar_invitacion_club_atomica(
    'atomica-verify-token-0003', 'atomica3@verify.invalid', NULL,
    jsonb_build_object('nombre', 'Club 3', 'pais', 'Argentina', 'ciudad', 'Rosario',
      'horario_apertura', '09:00', 'horario_cierre', '22:00', 'precio_por_reserva', 100,
      'cantidad_canchas', 1, 'whatsapp_contacto', '3411111111'),
    '[{"deporte":"padbol","cantidad":1}]'::jsonb
  ) INTO r;
  EXECUTE 'RESET ROLE';
  PERFORM pg_temp.expect((r->>'reason') = 'expired', 'expired invitation was not rejected');
  PERFORM pg_temp.expect((SELECT estado FROM public.invitaciones_admin WHERE token = 'atomica-verify-token-0003') = 'expirada', 'expired invitation not marked expirada');

  -- Invalid payload (no sports).
  EXECUTE 'SET LOCAL ROLE service_role';
  SELECT public.completar_invitacion_club_atomica(
    'atomica-verify-token-0004', 'atomica4@verify.invalid', NULL,
    jsonb_build_object('nombre', 'Club 4', 'pais', 'Argentina', 'ciudad', 'Rosario',
      'horario_apertura', '09:00', 'horario_cierre', '22:00', 'precio_por_reserva', 100,
      'cantidad_canchas', 1, 'whatsapp_contacto', '3411111111'),
    '[]'::jsonb
  ) INTO r;
  EXECUTE 'RESET ROLE';
  PERFORM pg_temp.expect((r->>'reason') = 'invalid_payload', 'empty deportes was not rejected');

  -- Geographic invitation cannot be completed as a club (role derives from row).
  EXECUTE 'SET LOCAL ROLE service_role';
  SELECT public.completar_invitacion_club_atomica(
    'atomica-verify-token-0005', 'atomica5@verify.invalid', NULL,
    jsonb_build_object('nombre', 'Club 5', 'pais', 'Argentina', 'ciudad', 'Rosario',
      'horario_apertura', '09:00', 'horario_cierre', '22:00', 'precio_por_reserva', 100,
      'cantidad_canchas', 1, 'whatsapp_contacto', '3411111111'),
    '[{"deporte":"padbol","cantidad":1}]'::jsonb
  ) INTO r;
  EXECUTE 'RESET ROLE';
  PERFORM pg_temp.expect((r->>'reason') = 'role_not_allowed', 'geo invitation accepted by club routine');

  PERFORM pg_temp.expect((SELECT count(*) FROM public.sedes) = v_sedes_before, 'rejections created seats');
  PERFORM pg_temp.expect((SELECT count(*) FROM public.canchas_por_deporte) = v_canchas_before, 'rejections created courts');
  PERFORM pg_temp.expect((SELECT count(*) FROM public.user_roles) = v_roles_before, 'rejections changed roles');
  PERFORM pg_temp.expect((SELECT count(*) FROM public.invitaciones_admin WHERE estado = 'pendiente' AND token IN ('atomica-verify-token-0002','atomica-verify-token-0004','atomica-verify-token-0005')) = 3, 'pending invitations were mutated');
END $rejections$;

-- ---- injected failure after role binding, before final invitation commit ---
CREATE FUNCTION pg_temp.verify_fail_inv_update() RETURNS trigger
LANGUAGE plpgsql AS $fail$
BEGIN
  RAISE EXCEPTION 'VERIFY_INJECTED_FAILURE_BEFORE_FINAL_COMMIT';
END
$fail$;
CREATE TRIGGER verify_fail_inv_update
  BEFORE UPDATE ON public.invitaciones_admin
  FOR EACH ROW
  WHEN (OLD.token = 'atomica-verify-token-0006')
  EXECUTE FUNCTION pg_temp.verify_fail_inv_update();

DO $inject$
DECLARE
  r jsonb;
  caught boolean := false;
  v_sedes_before bigint;
  v_canchas_before bigint;
  v_role_before public.user_roles%ROWTYPE;
  v_sede_id bigint;
BEGIN
  SELECT count(*) INTO v_sedes_before FROM public.sedes WHERE id <> 999;
  SELECT count(*) INTO v_canchas_before FROM public.canchas_por_deporte;
  SELECT * INTO v_role_before FROM public.user_roles WHERE email = 'atomica6@verify.invalid';

  EXECUTE 'SET LOCAL ROLE service_role';
  BEGIN
    SELECT public.completar_invitacion_club_atomica(
      'atomica-verify-token-0006', 'atomica6@verify.invalid', 'Admin Club 6',
      jsonb_build_object('nombre', 'Club 6', 'pais', 'Argentina', 'ciudad', 'Rosario',
        'horario_apertura', '09:00', 'horario_cierre', '22:00', 'precio_por_reserva', 100,
        'cantidad_canchas', 1, 'whatsapp_contacto', '3411111111'),
      '[{"deporte":"padbol","cantidad":1}]'::jsonb
    ) INTO r;
  EXCEPTION WHEN OTHERS THEN
    caught := true;
  END;
  EXECUTE 'RESET ROLE';

  PERFORM pg_temp.expect(caught, 'injected failure did not raise');
  PERFORM pg_temp.expect((SELECT count(*) FROM public.sedes WHERE id <> 999) = v_sedes_before, 'failed completion left an orphan seat');
  PERFORM pg_temp.expect((SELECT count(*) FROM public.canchas_por_deporte) = v_canchas_before, 'failed completion left orphan courts');
  PERFORM pg_temp.expect(
    (SELECT row(role, alcance, nombre, sede_id) FROM public.user_roles WHERE email = 'atomica6@verify.invalid')
      = row(v_role_before.role, v_role_before.alcance, v_role_before.nombre, v_role_before.sede_id),
    'failed completion changed the previous role binding'
  );
  PERFORM pg_temp.expect((SELECT estado FROM public.invitaciones_admin WHERE token = 'atomica-verify-token-0006') = 'pendiente', 'failed completion consumed the invitation');
END $inject$;

-- Remove the fault injector, then retry: the same invitation must create
-- exactly one seat, one court and one role binding, and be consumed once.
DROP TRIGGER verify_fail_inv_update ON public.invitaciones_admin;
DROP FUNCTION pg_temp.verify_fail_inv_update();

DO $retry$
DECLARE
  r jsonb;
  v_sedes_before bigint;
  v_canchas_before bigint;
  v_sede_id bigint;
BEGIN
  SELECT count(*) INTO v_sedes_before FROM public.sedes WHERE id <> 999;
  SELECT count(*) INTO v_canchas_before FROM public.canchas_por_deporte;

  EXECUTE 'SET LOCAL ROLE service_role';
  SELECT public.completar_invitacion_club_atomica(
    'atomica-verify-token-0006', 'atomica6@verify.invalid', 'Admin Club 6',
    jsonb_build_object('nombre', 'Club 6', 'pais', 'Argentina', 'ciudad', 'Rosario',
      'horario_apertura', '09:00', 'horario_cierre', '22:00', 'precio_por_reserva', 100,
      'cantidad_canchas', 1, 'whatsapp_contacto', '3411111111'),
    '[{"deporte":"padbol","cantidad":1}]'::jsonb
  ) INTO r;
  EXECUTE 'RESET ROLE';

  PERFORM pg_temp.expect((r->>'ok')::boolean, 'retry after rollback did not complete');
  v_sede_id := (r->>'sede_id')::bigint;
  PERFORM pg_temp.expect((SELECT count(*) FROM public.sedes WHERE id <> 999) = v_sedes_before + 1, 'retry did not create exactly one seat');
  PERFORM pg_temp.expect((SELECT count(*) FROM public.canchas_por_deporte) = v_canchas_before + 1, 'retry did not create exactly one court');
  PERFORM pg_temp.expect((SELECT count(*) FROM public.user_roles WHERE email = 'atomica6@verify.invalid') = 1, 'retry duplicated the role row');
  PERFORM pg_temp.expect((SELECT sede_id FROM public.user_roles WHERE email = 'atomica6@verify.invalid') = v_sede_id, 'retry did not bind the role');
  PERFORM pg_temp.expect((SELECT estado FROM public.invitaciones_admin WHERE token = 'atomica-verify-token-0006') = 'completada', 'retry did not consume the invitation');
END $retry$;

-- ---- different token/user stays independent --------------------------------
DO $independent$
DECLARE
  r jsonb;
  v_sedes_before bigint;
BEGIN
  SELECT count(*) INTO v_sedes_before FROM public.sedes WHERE id <> 999;
  EXECUTE 'SET LOCAL ROLE service_role';
  SELECT public.completar_invitacion_club_atomica(
    'atomica-verify-token-0007', 'atomica7@verify.invalid', 'Admin Club 7',
    jsonb_build_object('nombre', 'Club 7', 'pais', 'Uruguay', 'ciudad', 'Montevideo',
      'horario_apertura', '10:00', 'horario_cierre', '23:00', 'precio_por_reserva', 200,
      'cantidad_canchas', 2, 'whatsapp_contacto', '59811111111'),
    '[{"deporte":"padel","cantidad":2}]'::jsonb
  ) INTO r;
  EXECUTE 'RESET ROLE';
  PERFORM pg_temp.expect((r->>'ok')::boolean, 'independent token did not complete');
  PERFORM pg_temp.expect((SELECT count(*) FROM public.sedes WHERE id <> 999) = v_sedes_before + 1, 'independent token did not create its own seat');
  PERFORM pg_temp.expect((SELECT count(*) FROM public.user_roles WHERE email = 'atomica7@verify.invalid') = 1, 'independent token did not create its own role');
  PERFORM pg_temp.expect((SELECT sede_id FROM public.user_roles WHERE email = 'atomica7@verify.invalid') = (r->>'sede_id')::bigint, 'independent role bound to wrong seat');
  PERFORM pg_temp.expect((SELECT role FROM public.user_roles WHERE email = 'atomica7@verify.invalid') = 'admin_club', 'independent role is not admin_club');
END $independent$;

ROLLBACK;
