-- MANUAL LOCAL CANDIDATE ONLY. No execution authorization for QA or production.
-- Requires exact-target catalog review, preserved recovery definitions, code4a
-- deployed and ALL old instances/workers proven drained before this transaction.
-- ACCESS EXCLUSIVE blocks readers/writers; not an HTTP/Auth/provider pause.
-- Failure: caller must ROLLBACK/close connection, never continue statements.
-- Success: preserve business data; no automatic destructive down migration.
-- classes_reservas is locked for its capacity trigger, NEVER assumed empty,
-- counted, retired or migrated by this bundle.
BEGIN ISOLATION LEVEL READ COMMITTED;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '30s';
SET LOCAL idle_in_transaction_session_timeout = '60s';
-- One deterministic name order. Missing required existing relation aborts.
LOCK TABLE public.canchas,
  public.canchas_por_deporte,
  public.clases,
  public.clases_horarios,
  public.clases_reservas,
  public.equipos,
  public.inscripciones_clases,
  public.invitaciones_admin,
  public.jugadores_perfil,
  public.profesores,
  public.reservas,
  public.sedes,
  public.store_catalog_products,
  public.store_sede_offers,
  public.tabla_puntos,
  public.torneos,
  public.user_roles IN ACCESS EXCLUSIVE MODE;
-- A distinct statement AFTER locks: READ COMMITTED sees committed writers
-- that preceded lock acquisition, not a snapshot taken before the wait.
DO $prospective_precheck$
BEGIN
 IF EXISTS (SELECT 1 FROM public.inscripciones_clases)
    OR EXISTS (SELECT 1 FROM public.reservas WHERE tipo='clase' AND estado='confirmada') THEN
  RAISE EXCEPTION 'QA_INSTALL_PROSPECTIVE_LEGACY_NONZERO' USING ERRCODE='55000';
 END IF;
END $prospective_precheck$;

-- SOURCE 1 sql/candidates/20261122_canonical_enrollment_pending.sql SHA256 4f059b2c720dc170e246065112f02b2b354b902fbb4703edfa91d112016c91f7
-- BODY-BEGIN 1
-- LOCAL CANDIDATE ONLY. Never confirms payment or grants access.
-- Preserve the installed function's guards and ACL rather than replaying an old definition.
DO $candidate$
DECLARE
  target regprocedure := to_regprocedure('public.gestionar_participantes_torneo(bigint,uuid,text,jsonb)');
  definition text;
  previous text := 'VALUES(t.id,t.sede_id,trim(p_payload->>''nombre''),p_actor_id,roster,''[]''::jsonb,lim_max,false,''cerrado'',''confirmado'',mode) RETURNING * INTO e;';
  replacement text := '/* canonical_enrollment_pending_v1 */ VALUES(t.id,t.sede_id,trim(p_payload->>''nombre''),p_actor_id,roster,''[]''::jsonb,lim_max,false,''cerrado'',''pendiente'',mode) RETURNING * INTO e;';
BEGIN
  IF target IS NULL THEN RAISE EXCEPTION 'Canonical registration function missing; inspect before applying candidate'; END IF;
  definition := pg_get_functiondef(target);
  IF position('canonical_enrollment_pending_v1' IN definition) > 0 THEN
    IF position(replacement IN definition) = 0 THEN RAISE EXCEPTION 'Candidate marker exists but pending insert differs'; END IF;
    RETURN;
  END IF;
  IF (length(definition)-length(replace(definition,previous,'')))/length(previous) <> 1 THEN
    RAISE EXCEPTION 'Canonical registration body differs; candidate not applicable';
  END IF;
  EXECUTE replace(definition,previous,replacement);
END $candidate$;
-- BODY-END 1

-- SOURCE 2 sql/candidates/20261122_clases_reservas_cupo_guard.sql SHA256 2c020858a7a08940468917ceec41765616b1ad7feb8bdf5436a5dc66d1793e73
-- BODY-BEGIN 2
-- Candidato local CLASES-CUPO-001: serializa reservas por clase y valida cupo
-- dentro de la misma transacción. No crear en producción desde este lote.
CREATE OR REPLACE FUNCTION public.clases_reservas_cupo_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_cupo integer;
  v_activo boolean;
  v_ocupadas integer;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RETURN NEW;
  END IF;

  -- Bloquea la fila de la clase: dos reservas simultáneas de la última plaza
  -- se serializan antes de contar, no hay count/insert separado sin lock.
  SELECT cupo_maximo, activo
    INTO v_cupo, v_activo
    FROM public.clases
   WHERE id = NEW.clase_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'CLASE_NO_ENCONTRADA' USING ERRCODE = 'P0001';
  END IF;

  IF v_activo IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'CLASE_INACTIVA' USING ERRCODE = 'P0001';
  END IF;

  SELECT count(*) INTO v_ocupadas
    FROM public.clases_reservas
   WHERE clase_id = NEW.clase_id;

  IF v_ocupadas >= COALESCE(v_cupo, 4) THEN
    RAISE EXCEPTION 'CLASE_COMPLETA' USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS clases_reservas_cupo_guard ON public.clases_reservas;
CREATE TRIGGER clases_reservas_cupo_guard
BEFORE INSERT ON public.clases_reservas
FOR EACH ROW EXECUTE FUNCTION public.clases_reservas_cupo_guard();

COMMENT ON FUNCTION public.clases_reservas_cupo_guard() IS
  'CLASES-CUPO-001 local: bloquea clase y evita sobrecupo en INSERT concurrente.';
-- BODY-END 2

-- SOURCE 3 sql/candidates/20261122_finalizar_torneo_generico_atomico.sql SHA256 630fff353ec62ff71f97bdaec7881eae3651707fb1d3582b04fc16d37eb15320
-- BODY-BEGIN 3
-- Generic (non-Nations) tournament closure.
-- One transaction persists the immutable ledger (tabla_puntos), the team points
-- (equipos.puntos_ranking) and the tournament state (torneos.estado/fecha_fin).
-- The backend route authenticates the caller and computes the final ranking;
-- this function only accepts a complete, self-consistent snapshot and is
-- executable by service_role only. A retry on an already closed tournament
-- returns the stored ledger without recalculating it.

CREATE OR REPLACE FUNCTION public.finalizar_torneo_generico(
  p_torneo_id bigint,
  p_expected_estado text,
  p_expected_updated_at timestamp,
  p_fecha_fin date,
  p_puntos jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  t public.torneos;
  n integer;
  affected integer;
  tabla jsonb;
BEGIN
  IF p_torneo_id IS NULL OR jsonb_typeof(p_puntos) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='Invalid generic closure payload';
  END IF;

  -- Lock first: the whole closure is serialized per tournament.
  SELECT * INTO t FROM public.torneos WHERE id = p_torneo_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'status', 'not_found');
  END IF;

  -- A closed ledger is immutable: never recompute it from a later policy/ranking.
  IF t.estado = 'finalizado' THEN
    SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY x.id), '[]'::jsonb)
      INTO tabla FROM public.tabla_puntos x WHERE x.torneo_id = t.id;
    RETURN jsonb_build_object('ok', true, 'status', 'idempotent', 'torneo', to_jsonb(t), 'tabla', tabla);
  END IF;

  -- Optimistic concurrency: a stale caller writes nothing.
  IF t.estado IS DISTINCT FROM p_expected_estado
     OR t.updated_at IS DISTINCT FROM p_expected_updated_at THEN
    RETURN jsonb_build_object('ok', false, 'status', 'conflict');
  END IF;

  IF p_fecha_fin IS NULL THEN
    RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='Closure date required';
  END IF;

  SELECT count(*) INTO n FROM public.equipos WHERE torneo_id = t.id;
  IF n < 2 THEN
    RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='Tournament has no complete field';
  END IF;

  -- Validate text shapes before casting so malformed snapshots fail cleanly.
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_puntos) p
    WHERE jsonb_typeof(p) IS DISTINCT FROM 'object'
       OR coalesce(p->>'torneo_id', '') !~ '^[0-9]{1,18}$'
       OR coalesce(p->>'equipo_id', '') !~ '^[0-9]{1,18}$'
       OR coalesce(p->>'posicion', '') !~ '^[0-9]{1,18}$'
       OR coalesce(p->>'puntos', '') !~ '^[0-9]{1,18}$'
  ) THEN
    RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='Invalid team points snapshot';
  END IF;

  IF jsonb_array_length(p_puntos) <> n
     OR (SELECT count(DISTINCT (p->>'equipo_id')) FROM jsonb_array_elements(p_puntos) p) <> n
     OR (SELECT count(DISTINCT (p->>'posicion')) FROM jsonb_array_elements(p_puntos) p) <> n
     OR EXISTS (
       SELECT 1 FROM jsonb_array_elements(p_puntos) p
       WHERE (p->>'torneo_id')::bigint IS DISTINCT FROM t.id
          OR (p->>'posicion')::numeric NOT BETWEEN 1 AND n
          OR (p->>'puntos')::numeric < 0
          OR (p->>'puntos')::numeric > 2147483647
          OR NOT EXISTS (
            SELECT 1 FROM public.equipos e
            WHERE e.id = (p->>'equipo_id')::bigint AND e.torneo_id = t.id
          )
     ) THEN
    RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='Invalid team points snapshot';
  END IF;

  DELETE FROM public.tabla_puntos WHERE torneo_id = t.id;

  INSERT INTO public.tabla_puntos (torneo_id, equipo_id, posicion, puntos)
  SELECT t.id, (p->>'equipo_id')::bigint, (p->>'posicion')::int, (p->>'puntos')::int
  FROM jsonb_array_elements(p_puntos) p;
  -- A silent BEFORE INSERT trigger returning NULL must abort the whole closure.
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected <> n THEN
    RAISE EXCEPTION USING ERRCODE='55000', MESSAGE='Ledger insert was not persisted atomically';
  END IF;

  UPDATE public.equipos e
     SET puntos_ranking = (p->>'puntos')::int
    FROM jsonb_array_elements(p_puntos) p
   WHERE e.id = (p->>'equipo_id')::bigint AND e.torneo_id = t.id;
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected <> n THEN
    RAISE EXCEPTION USING ERRCODE='55000', MESSAGE='Team points update was not persisted atomically';
  END IF;

  UPDATE public.torneos
     SET estado = 'finalizado',
         fecha_fin = p_fecha_fin,
         updated_at = clock_timestamp()
   WHERE id = t.id
   RETURNING * INTO t;
  -- Exactly one tournament row must be updated; RETURN NULL suppression raises here.
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF NOT FOUND OR affected <> 1 THEN
    RAISE EXCEPTION USING ERRCODE='55000', MESSAGE='Tournament state update was not persisted atomically';
  END IF;
  -- Re-read so AFTER triggers or silent column rewrites are detected, not returned blindly.
  SELECT * INTO t FROM public.torneos WHERE id = p_torneo_id;
  IF NOT FOUND OR t.estado IS DISTINCT FROM 'finalizado' OR t.fecha_fin IS DISTINCT FROM p_fecha_fin THEN
    RAISE EXCEPTION USING ERRCODE='55000', MESSAGE='Tournament state was not persisted atomically';
  END IF;

  -- Final all-or-nothing snapshot check: a suppressed or rewritten ledger/team row
  -- can never be committed, even if a BEFORE trigger returned a valid row.
  IF (SELECT count(*) FROM public.tabla_puntos WHERE torneo_id = t.id) <> n THEN
    RAISE EXCEPTION USING ERRCODE='55000', MESSAGE='Ledger row count does not match the closed snapshot';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_puntos) p
    LEFT JOIN public.tabla_puntos q
      ON q.torneo_id = t.id AND q.equipo_id = (p->>'equipo_id')::bigint
    WHERE q.id IS NULL
       OR q.posicion IS DISTINCT FROM (p->>'posicion')::int
       OR q.puntos IS DISTINCT FROM (p->>'puntos')::int
  ) THEN
    RAISE EXCEPTION USING ERRCODE='55000', MESSAGE='Persisted ledger differs from the closed snapshot';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_puntos) p
    JOIN public.equipos e ON e.id = (p->>'equipo_id')::bigint AND e.torneo_id = t.id
    WHERE e.puntos_ranking IS DISTINCT FROM (p->>'puntos')::int
  ) THEN
    RAISE EXCEPTION USING ERRCODE='55000', MESSAGE='Persisted team points differ from the closed snapshot';
  END IF;

  SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY x.id), '[]'::jsonb)
    INTO tabla FROM public.tabla_puntos x WHERE x.torneo_id = t.id;

  RETURN jsonb_build_object('ok', true, 'status', 'completed', 'torneo', to_jsonb(t), 'tabla', tabla);
END;
$$;

REVOKE ALL ON FUNCTION public.finalizar_torneo_generico(bigint,text,timestamp,date,jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finalizar_torneo_generico(bigint,text,timestamp,date,jsonb) TO service_role;

-- BODY-END 3

-- SOURCE 4 sql/candidates/20261123_inscripciones_clases_cupo_ocurrencia.sql SHA256 c728062306f44851a18179905ad61e1259358212ad78bac040f7d53eeaba1446
-- BODY-BEGIN 4
-- Candidato local CLASES-OCURRENCIA-001: cupo por fecha/hora y clase.
-- No aplicar en producción desde este lote. Mantiene el contrato de /api/clases/inscribir.
CREATE OR REPLACE FUNCTION public.inscripciones_clases_cupo_ocurrencia_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_cupo integer;
  v_activo boolean;
  v_ocupadas integer;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RETURN NEW;
  END IF;

  -- Serializa las inscripciones de la misma clase; luego cuenta sólo la
  -- ocurrencia exacta (fecha + hora), no la plantilla completa.
  SELECT cupo_maximo, activo
    INTO v_cupo, v_activo
    FROM public.clases
   WHERE id = NEW.clase_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'CLASE_NO_ENCONTRADA' USING ERRCODE = 'P0001';
  END IF;
  IF v_activo IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'CLASE_INACTIVA' USING ERRCODE = 'P0001';
  END IF;

  SELECT count(*) INTO v_ocupadas
    FROM public.inscripciones_clases
   WHERE clase_id = NEW.clase_id
     AND fecha = NEW.fecha
     AND hora_inicio = NEW.hora_inicio
     AND lower(COALESCE(estado, '')) IN ('pendiente', 'confirmada', 'pagada');

  IF v_ocupadas >= COALESCE(v_cupo, 4) THEN
    RAISE EXCEPTION 'CLASE_OCURRENCIA_COMPLETA' USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS inscripciones_clases_cupo_ocurrencia_guard ON public.inscripciones_clases;
CREATE TRIGGER inscripciones_clases_cupo_ocurrencia_guard
BEFORE INSERT ON public.inscripciones_clases
FOR EACH ROW EXECUTE FUNCTION public.inscripciones_clases_cupo_ocurrencia_guard();
-- BODY-END 4

-- SOURCE 5 sql/candidates/20261123_clases_ocurrencias_acceso.sql SHA256 877b8168e041615dda9222504000722b8e7bdc3ef946f7c6939757745c7b2c61
-- BODY-BEGIN 5
-- LOCAL candidate only. No changes to the general reservation overlap guard.
CREATE TABLE public.clases_ocurrencias (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 clase_id bigint NOT NULL REFERENCES public.clases(id),
 fecha date NOT NULL, hora_inicio time NOT NULL,
 cancha_id bigint NOT NULL REFERENCES public.canchas(id),
 organizador_id uuid NOT NULL REFERENCES auth.users(id),
 reserva_cancha_id bigint NOT NULL UNIQUE REFERENCES public.reservas(id),
 estado text NOT NULL DEFAULT 'preparada' CHECK(estado IN ('preparada','cancelada')),
 UNIQUE(clase_id,fecha,hora_inicio)
);
ALTER TABLE public.inscripciones_clases ADD COLUMN ocurrencia_id bigint REFERENCES public.clases_ocurrencias(id);
CREATE TABLE public.clases_accesos (
 inscripcion_id bigint PRIMARY KEY REFERENCES public.inscripciones_clases(id),
 token text NOT NULL UNIQUE CHECK(token ~ '^[0-9a-f]{64}$')
);
ALTER TABLE public.clases_ocurrencias ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.clases_accesos ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.clases_ocurrencias,public.clases_accesos FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON public.clases_ocurrencias,public.clases_accesos TO service_role;
GRANT USAGE,SELECT ON SEQUENCE public.clases_ocurrencias_id_seq TO service_role;

CREATE OR REPLACE FUNCTION public.clases_ocurrencia_comando(
 p_accion text, p_clase_id bigint, p_user_id uuid,
 p_fecha date DEFAULT NULL, p_hora time DEFAULT NULL,
 p_inscripcion_id bigint DEFAULT NULL, p_ocurrencia_id bigint DEFAULT NULL,
 p_token text DEFAULT NULL, p_super boolean DEFAULT false, p_email text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
DECLARE c public.clases%ROWTYPE; o public.clases_ocurrencias%ROWTYPE;
 i public.inscripciones_clases%ROWTYPE; p record; s record;
 v_reserva bigint; v_num integer; v_count integer; v_duplicate boolean:=false;
 v_court bigint; v_today date; v_hours integer; v_expected integer; v_written integer;
BEGIN
 IF p_user_id IS NULL THEN RAISE EXCEPTION 'CLASE_NO_AUTORIZADO'; END IF;
 -- All commands acquire class first, then occurrence/enrollment: consistent lock order.
 SELECT * INTO c FROM public.clases WHERE id=p_clase_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'CLASE_NO_ENCONTRADA'; END IF;
 SELECT * INTO s FROM public.sedes WHERE id=c.sede_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'CLASE_SEDE_NO_ENCONTRADA'; END IF;
 IF s.timezone IS NULL OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_timezone_names WHERE name=s.timezone) THEN RAISE EXCEPTION 'CLASE_TIMEZONE_REVISAR'; END IF;
 IF p_accion IN ('preparar','inscribir') THEN
  IF c.activo IS DISTINCT FROM true OR NOT EXISTS(SELECT 1 FROM public.profesores WHERE id=c.profesor_id AND aprobado AND activo) THEN RAISE EXCEPTION 'CLASE_INACTIVA'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.clases_horarios WHERE clase_id=c.id AND dia_semana=extract(dow FROM p_fecha) AND hora_inicio=p_hora) THEN RAISE EXCEPTION 'CLASE_HORARIO_INVALIDO'; END IF;
  SELECT * INTO o FROM public.clases_ocurrencias WHERE clase_id=c.id AND fecha=p_fecha AND hora_inicio=p_hora AND estado='preparada' FOR UPDATE;
  IF FOUND AND (o.estado<>'preparada' OR o.cancha_id IS DISTINCT FROM c.cancha_id) THEN RAISE EXCEPTION 'CLASE_OCURRENCIA_NO_DISPONIBLE'; END IF;
 END IF;
 IF p_accion='preparar' THEN
  IF o.id IS NOT NULL THEN
   IF o.organizador_id<>p_user_id AND NOT p_super THEN RAISE EXCEPTION 'CLASE_OTRO_ORGANIZADOR'; END IF;
   RETURN jsonb_build_object('ocurrencia_id',o.id,'clase_id',c.id,'fecha',o.fecha,'hora_inicio',to_char(o.hora_inicio,'HH24:MI'),'estado',o.estado,'reutilizada',true);
  END IF;
  IF coalesce(s.tipo_sede,'')='torneo' THEN RAISE EXCEPTION 'CLASE_SEDE_NO_RESERVABLE'; END IF;
  -- Source is the authenticated organizer's persisted real profile, never request contacts.
  IF (SELECT count(*) FROM public.jugadores_perfil WHERE user_id=p_user_id AND lower(trim(email))=lower(trim(p_email)))<>1 THEN RAISE EXCEPTION 'CLASE_ORGANIZADOR_CONTACTO_REQUERIDO'; END IF;
  SELECT trim(j.nombre) nombre,trim(j.apellido) apellido,lower(trim(j.email)) email,trim(j.whatsapp) whatsapp
   INTO p FROM public.jugadores_perfil j WHERE j.user_id=p_user_id AND lower(trim(j.email))=lower(trim(p_email));
  IF NOT FOUND OR coalesce(p.nombre,'')='' OR coalesce(p.email,'') !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'
    OR coalesce(p.whatsapp,'') !~ '^\+?[0-9 ()-]{7,25}$' OR length(regexp_replace(coalesce(p.whatsapp,''),'[^0-9]','','g')) NOT BETWEEN 7 AND 15 THEN RAISE EXCEPTION 'CLASE_ORGANIZADOR_CONTACTO_REQUERIDO'; END IF;
  SELECT CASE WHEN orden>0 THEN orden ELSE numero END INTO v_num FROM (
   SELECT id,orden,row_number() OVER(ORDER BY id)::int numero FROM public.canchas WHERE sede_id=c.sede_id
  ) courts WHERE id=c.cancha_id;
  IF v_num IS NULL THEN RAISE EXCEPTION 'CLASE_CANCHA_INVALIDA'; END IF;
  IF c.duracion_minutos IS NULL OR c.duracion_minutos<15 THEN RAISE EXCEPTION 'CLASE_DURACION_INVALIDA'; END IF;
  IF c.precio<>trunc(c.precio) OR c.precio<0 THEN RAISE EXCEPTION 'CLASE_PRECIO_REVISAR'; END IF;
  INSERT INTO public.reservas(sede,sede_id,fecha,hora,hora_inicio,cancha,cancha_id,nombre,email,telefono,whatsapp,nivel,precio,moneda,estado,duracion_minutos,user_id,tipo)
   VALUES(s.nombre,s.id,p_fecha::text,to_char(p_hora,'HH24:MI'),to_char(p_hora,'HH24:MI'),v_num,c.cancha_id,concat_ws(' ',p.nombre,nullif(p.apellido,'')),p.email,p.whatsapp,p.whatsapp,'Clase',c.precio,coalesce(s.moneda,'ARS'),'confirmada',c.duracion_minutos,p_user_id,'clase') RETURNING id INTO v_reserva;
  IF NOT FOUND THEN RAISE EXCEPTION 'CLASE_ESCRITURA_INCOMPLETA'; END IF;
  INSERT INTO public.clases_ocurrencias(clase_id,fecha,hora_inicio,cancha_id,organizador_id,reserva_cancha_id)
   VALUES(c.id,p_fecha,p_hora,c.cancha_id,p_user_id,v_reserva) RETURNING * INTO o;
  IF NOT FOUND THEN RAISE EXCEPTION 'CLASE_ESCRITURA_INCOMPLETA'; END IF;
  RETURN jsonb_build_object('ocurrencia_id',o.id,'clase_id',c.id,'fecha',o.fecha,'hora_inicio',to_char(o.hora_inicio,'HH24:MI'),'estado',o.estado,'reutilizada',false);
 ELSIF p_accion='inscribir' THEN
  IF o.id IS NULL THEN RAISE EXCEPTION 'CLASE_OCURRENCIA_NO_PREPARADA'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.reservas WHERE id=o.reserva_cancha_id AND estado='confirmada') THEN RAISE EXCEPTION 'CLASE_OCURRENCIA_NO_DISPONIBLE'; END IF;
  SELECT * INTO i FROM public.inscripciones_clases WHERE clase_id=c.id AND user_id=p_user_id AND fecha=p_fecha AND hora_inicio=p_hora FOR UPDATE;
  IF FOUND AND coalesce(i.estado,'')<>'cancelada' THEN RAISE EXCEPTION 'CLASE_INSCRIPCION_DUPLICADA'; END IF;
  SELECT count(*) INTO v_count FROM public.inscripciones_clases WHERE clase_id=c.id AND fecha=p_fecha AND hora_inicio=p_hora AND estado IN('pendiente','confirmada');
  IF v_count>=coalesce(c.cupo_maximo,4) THEN RAISE EXCEPTION 'CLASE_OCURRENCIA_COMPLETA'; END IF;
  IF i.id IS NULL THEN
   INSERT INTO public.inscripciones_clases(clase_id,user_id,fecha,hora_inicio,estado,reserva_cancha_id,ocurrencia_id)
    VALUES(c.id,p_user_id,p_fecha,p_hora,'pendiente',o.reserva_cancha_id,o.id) RETURNING * INTO i;
   IF NOT FOUND THEN RAISE EXCEPTION 'CLASE_ESCRITURA_INCOMPLETA'; END IF;
  ELSE
   UPDATE public.inscripciones_clases SET estado='pendiente',reserva_cancha_id=o.reserva_cancha_id,ocurrencia_id=o.id,asistio=false,asistencia_marcada_at=NULL,asistencia_marcada_por=NULL WHERE id=i.id RETURNING * INTO i;
   IF NOT FOUND THEN RAISE EXCEPTION 'CLASE_ESCRITURA_INCOMPLETA'; END IF;
  END IF;
 ELSIF p_accion IN ('retirar','acceso','checkin') THEN
  SELECT * INTO i FROM public.inscripciones_clases WHERE id=p_inscripcion_id AND clase_id=c.id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'CLASE_INSCRIPCION_NO_ENCONTRADA'; END IF;
  IF p_accion<>'checkin' AND i.user_id IS DISTINCT FROM p_user_id THEN RAISE EXCEPTION 'CLASE_INSCRIPCION_AJENA'; END IF;
  IF p_accion='retirar' THEN
   IF i.estado='cancelada' THEN RETURN jsonb_build_object('ok',true,'ya_cancelada',true); END IF;
   v_hours:=greatest(coalesce(c.horas_cancelacion,24),0);
   IF (i.fecha+i.hora_inicio) AT TIME ZONE s.timezone < now()+make_interval(hours=>v_hours) THEN RAISE EXCEPTION 'CLASE_CANCELACION_FUERA_PLAZO'; END IF;
   UPDATE public.inscripciones_clases SET estado='cancelada' WHERE id=i.id;
   IF NOT FOUND THEN RAISE EXCEPTION 'CLASE_ESCRITURA_INCOMPLETA'; END IF;
   DELETE FROM public.clases_accesos WHERE inscripcion_id=i.id;
   RETURN jsonb_build_object('ok',true);
  END IF;
  SELECT * INTO o FROM public.clases_ocurrencias WHERE id=i.ocurrencia_id FOR UPDATE;
  IF NOT FOUND OR o.estado<>'preparada' OR coalesce(i.estado,'') NOT IN('pendiente','confirmada') THEN RAISE EXCEPTION 'CLASE_INSCRIPCION_NO_ACTIVA'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.reservas WHERE id=o.reserva_cancha_id AND estado='confirmada') THEN RAISE EXCEPTION 'CLASE_OCURRENCIA_NO_DISPONIBLE'; END IF;
  IF p_accion='acceso' THEN
   IF p_token !~ '^[0-9a-f]{64}$' OR p_token IS NULL THEN RAISE EXCEPTION 'CLASE_TOKEN_INVALIDO'; END IF;
   INSERT INTO public.clases_accesos(inscripcion_id,token) VALUES(i.id,p_token) ON CONFLICT(inscripcion_id) DO NOTHING;
   RETURN (SELECT jsonb_build_object('inscripcion_id',i.id,'clase_id',i.clase_id,'qr_code',token,'tipo','clase') FROM public.clases_accesos WHERE inscripcion_id=i.id);
  END IF;
  IF NOT EXISTS(SELECT 1 FROM public.clases_accesos WHERE inscripcion_id=i.id AND token=p_token) THEN RAISE EXCEPTION 'CLASE_TOKEN_INVALIDO'; END IF;
  IF nullif(s.timezone,'') IS NULL THEN RAISE EXCEPTION 'CLASE_TIMEZONE_REVISAR'; END IF;
  v_today:=(now() AT TIME ZONE s.timezone)::date;
  IF i.fecha<>v_today THEN RAISE EXCEPTION 'CLASE_CHECKIN_FECHA_INVALIDA'; END IF;
  IF i.asistio IS TRUE THEN RAISE EXCEPTION 'CLASE_CHECKIN_YA_REALIZADO'; END IF;
  UPDATE public.inscripciones_clases SET asistio=true,asistencia_marcada_at=now(),asistencia_marcada_por=p_user_id::text WHERE id=i.id;
  IF NOT FOUND THEN RAISE EXCEPTION 'CLASE_ESCRITURA_INCOMPLETA'; END IF;
  RETURN jsonb_build_object('ok',true,'inscripcion_id',i.id,'asistio',true);
 ELSIF p_accion='cancelar_ocurrencia' THEN
  SELECT * INTO o FROM public.clases_ocurrencias WHERE id=p_ocurrencia_id AND clase_id=c.id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'CLASE_OCURRENCIA_NO_ENCONTRADA'; END IF;
  IF o.organizador_id<>p_user_id AND NOT p_super THEN RAISE EXCEPTION 'CLASE_OTRO_ORGANIZADOR'; END IF;
  IF o.estado='cancelada' THEN RETURN jsonb_build_object('ok',true,'ya_cancelada',true); END IF;
  SELECT count(*) INTO v_expected FROM public.inscripciones_clases WHERE ocurrencia_id=o.id;
  UPDATE public.inscripciones_clases SET estado='cancelada' WHERE ocurrencia_id=o.id;
  GET DIAGNOSTICS v_written=ROW_COUNT;
  IF v_written<>v_expected THEN RAISE EXCEPTION 'CLASE_ESCRITURA_INCOMPLETA'; END IF;
  DELETE FROM public.clases_accesos WHERE inscripcion_id IN(SELECT id FROM public.inscripciones_clases WHERE ocurrencia_id=o.id);
  UPDATE public.clases_ocurrencias SET estado='cancelada' WHERE id=o.id;
  IF NOT FOUND THEN RAISE EXCEPTION 'CLASE_ESCRITURA_INCOMPLETA'; END IF;
  UPDATE public.reservas SET estado='cancelada' WHERE id=o.reserva_cancha_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'CLASE_RESERVA_NO_ENCONTRADA'; END IF;
  RETURN jsonb_build_object('ok',true);
 ELSE RAISE EXCEPTION 'CLASE_COMANDO_INVALIDO'; END IF;
 -- Student DTO deliberately excludes shared booking ownership/token.
 RETURN jsonb_build_object('id',i.id,'clase_id',i.clase_id,'fecha',i.fecha,'hora_inicio',to_char(i.hora_inicio,'HH24:MI'),'estado',i.estado,'ocurrencia_id',i.ocurrencia_id,'asistio',coalesce(i.asistio,false));
END $$;
REVOKE ALL ON FUNCTION public.clases_ocurrencia_comando(text,bigint,uuid,date,time,bigint,bigint,text,boolean,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.clases_ocurrencia_comando(text,bigint,uuid,date,time,bigint,bigint,text,boolean,text) TO service_role;
-- BODY-END 5

-- SOURCE 6 sql/candidates/20261123_clases_ocurrencias_lifecycle.sql SHA256 50e7d3938a5d0f34005522f80bc1bd1cdf39a22d771b5f55f2c177c8609cbd76
-- BODY-BEGIN 6
-- Local candidate, applies after 20261123_clases_ocurrencias_acceso.sql.
-- Preserve cancelled occurrence history; only one prepared occurrence owns the slot.
ALTER TABLE public.clases_ocurrencias DROP CONSTRAINT clases_ocurrencias_clase_id_fecha_hora_inicio_key;
CREATE UNIQUE INDEX clases_ocurrencias_preparada_slot_key ON public.clases_ocurrencias(clase_id,fecha,hora_inicio) WHERE estado='preparada';

CREATE OR REPLACE FUNCTION public.clases_ocurrencia_footprint_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
BEGIN
 IF ROW(NEW.sede_id,NEW.cancha_id,NEW.duracion_minutos) IS NOT DISTINCT FROM ROW(OLD.sede_id,OLD.cancha_id,OLD.duracion_minutos) THEN RETURN NEW; END IF;
 -- End comes from the persisted booking footprint, not the mutable class template.
 -- Missing/invalid interval or venue timezone cannot establish that occupancy ended.
 IF EXISTS (
  SELECT 1 FROM public.clases_ocurrencias o
  JOIN public.reservas r ON r.id=o.reserva_cancha_id
  LEFT JOIN public.sedes s ON s.id=OLD.sede_id
  CROSS JOIN LATERAL (SELECT CASE WHEN EXISTS(SELECT 1 FROM pg_catalog.pg_timezone_names z WHERE z.name=s.timezone)
    THEN upper(public.reserva_intervalo_guard(r.fecha,r.hora,r.hora_inicio,r.duracion_minutos)) AT TIME ZONE s.timezone
    ELSE NULL END AS fecha_fin) ends
  WHERE o.clase_id=OLD.id AND o.estado='preparada' AND r.estado='confirmada'
    AND (ends.fecha_fin IS NULL OR ends.fecha_fin>=now())
 ) THEN RAISE EXCEPTION 'CLASE_OCURRENCIA_FOOTPRINT_BLOQUEADO' USING ERRCODE='P0001'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.clases_ocurrencia_footprint_guard() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.clases_ocurrencia_footprint_guard() TO service_role;
CREATE TRIGGER clases_ocurrencia_footprint_guard BEFORE UPDATE OF sede_id,cancha_id,duracion_minutos ON public.clases FOR EACH ROW EXECUTE FUNCTION public.clases_ocurrencia_footprint_guard();
-- BODY-END 6

-- SOURCE 7 sql/candidates/20261123_clases_ocurrencias_booking_guard.sql SHA256 51e544a353c89b6393208033b95bb64e15878aff9828ba4d011eb0df3d91f19f
-- BODY-BEGIN 7
-- LOCAL candidate after acceso + lifecycle. No ordinary reservation policy changed.
CREATE OR REPLACE FUNCTION public.clases_ocurrencia_reserva_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 -- Integrity check must see the link even when caller cannot read its RLS table.
 -- Trigger-only function: fixed relation lookup, no caller-controlled SQL or bypass flag.
 IF NOT EXISTS(SELECT 1 FROM public.clases_ocurrencias WHERE reserva_cancha_id=OLD.id) THEN
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
 END IF;
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'CLASE_OCUPACION_GESTION_CLASES' USING ERRCODE='P0001'; END IF;
 IF ROW(NEW.sede_id,NEW.sede,NEW.fecha,NEW.hora,NEW.hora_inicio,NEW.hora_fin,NEW.cancha_id,NEW.cancha,NEW.duracion_minutos,NEW.user_id,NEW.email,NEW.nombre,NEW.telefono,NEW.whatsapp,NEW.tipo,NEW.precio,NEW.moneda)
   IS DISTINCT FROM ROW(OLD.sede_id,OLD.sede,OLD.fecha,OLD.hora,OLD.hora_inicio,OLD.hora_fin,OLD.cancha_id,OLD.cancha,OLD.duracion_minutos,OLD.user_id,OLD.email,OLD.nombre,OLD.telefono,OLD.whatsapp,OLD.tipo,OLD.precio,OLD.moneda) THEN
  RAISE EXCEPTION 'CLASE_OCUPACION_GESTION_CLASES' USING ERRCODE='P0001';
 END IF;
 IF NEW.estado IS DISTINCT FROM OLD.estado THEN
  IF OLD.estado='cancelada' OR NEW.estado IS DISTINCT FROM 'cancelada'
    OR EXISTS(SELECT 1 FROM public.clases_ocurrencias WHERE reserva_cancha_id=OLD.id AND estado<>'cancelada') THEN
   RAISE EXCEPTION 'CLASE_OCUPACION_GESTION_CLASES' USING ERRCODE='P0001';
  END IF;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.clases_ocurrencia_reserva_guard() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.clases_ocurrencia_reserva_guard() TO service_role;
CREATE TRIGGER clases_ocurrencia_reserva_guard BEFORE UPDATE OR DELETE ON public.reservas FOR EACH ROW EXECUTE FUNCTION public.clases_ocurrencia_reserva_guard();
-- BODY-END 7

-- SOURCE 8 sql/candidates/20261123120000_store_orders_schema.sql SHA256 bf8abf7f4fbd1d5e7829024c7ef04df1c74111b275511784c88dede781626dae
-- BODY-BEGIN 8
-- CANDIDATE — NO AUTOAPLICABLE. Requires review and an explicit activation window.
-- TIENDA-SEDE-CIERRE-002 · additive schema for the four public store tables that
-- are absent from the effective catalog. It preserves store_catalog_products,
-- store_central_offers and store_sede_offers untouched and uses their real types:
--   sedes.id = integer or bigint (effective catalog is bigint), store_sede_offers.id/product_id = bigint.
-- RLS is enabled on every new table with no policies; anon/authenticated are
-- revoked and service_role is the only client role with table/RPC access.
-- The order/stock transaction lives in the two SECURITY DEFINER functions below
-- so the existing Supabase service-role client can call it without a new pgPool.
-- Apply only after the precheck/verify file: 20261123120000_store_orders_schema.verify.sql


-- Fail before creating anything if this is not the expected Supabase-shaped
-- target. No role/schema is created by this migration.
DO $precheck$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon')
     OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated')
     OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    RAISE EXCEPTION 'TIENDA_SCHEMA_REQUIRES_SUPABASE_ROLES';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role' AND rolbypassrls) THEN
    RAISE EXCEPTION 'TIENDA_SCHEMA_REQUIRES_SERVICE_ROLE_BYPASSRLS';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'sedes'
       AND column_name = 'id' AND data_type IN ('integer', 'bigint')
  ) THEN
    RAISE EXCEPTION 'TIENDA_SCHEMA_REQUIRES_SEDES_ID_INTEGER_OR_BIGINT';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'store_sede_offers'
       AND column_name = 'sede_id' AND data_type = 'integer'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'store_sede_offers'
       AND column_name = 'id' AND data_type = 'bigint'
  ) THEN
    RAISE EXCEPTION 'TIENDA_SCHEMA_REQUIRES_REAL_OFFER_TYPES';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'store_catalog_products'
       AND column_name = 'id' AND data_type = 'bigint'
  ) THEN
    RAISE EXCEPTION 'TIENDA_SCHEMA_REQUIRES_REAL_CATALOG_TYPES';
  END IF;
END
$precheck$;

CREATE TABLE IF NOT EXISTS public.store_sede_config (
  sede_id integer PRIMARY KEY REFERENCES public.sedes(id) ON DELETE CASCADE,
  estado text NOT NULL DEFAULT 'opening_soon'
    CHECK (estado IN ('active', 'opening_soon', 'paused')),
  retiro_en_sede boolean NOT NULL DEFAULT true,
  entrega_local boolean NOT NULL DEFAULT false,
  radio_entrega_km numeric(6,2)
    CHECK (radio_entrega_km IS NULL OR radio_entrega_km >= 0),
  instrucciones_retiro text,
  instrucciones_entrega text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.store_sede_payment_methods (
  id BIGSERIAL PRIMARY KEY,
  sede_id integer NOT NULL REFERENCES public.sedes(id) ON DELETE CASCADE,
  codigo text NOT NULL
    CHECK (codigo IN ('cash_on_pickup', 'bank_transfer', 'mercadopago', 'stripe', 'other')),
  nombre text NOT NULL,
  activo boolean NOT NULL DEFAULT false,
  instrucciones text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (sede_id, codigo)
);

CREATE TABLE IF NOT EXISTS public.store_orders (
  id BIGSERIAL PRIMARY KEY,
  codigo text NOT NULL UNIQUE,
  sede_id integer NOT NULL REFERENCES public.sedes(id) ON DELETE RESTRICT,
  user_id uuid,
  estado text NOT NULL DEFAULT 'nuevo'
    CHECK (estado IN ('nuevo','confirmado','preparando','listo_retiro','enviado','entregado','cancelado')),
  pago_estado text NOT NULL DEFAULT 'a_confirmar'
    CHECK (pago_estado IN ('pendiente','a_confirmar','confirmado','rechazado','reembolsado')),
  fulfillment_type text NOT NULL
    CHECK (fulfillment_type IN ('pickup','local_delivery')),
  moneda text NOT NULL,
  total numeric(12,2) NOT NULL DEFAULT 0 CHECK (total >= 0),
  nota_cliente text,
  idempotency_key text,
  idempotency_hash text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT store_orders_idempotency_pair_check
    CHECK ((idempotency_key IS NULL) = (idempotency_hash IS NULL)),
  CONSTRAINT store_orders_idempotency_key_check
    CHECK (idempotency_key IS NULL OR (length(idempotency_key) BETWEEN 1 AND 200)),
  CONSTRAINT store_orders_idempotency_hash_check
    CHECK (idempotency_hash IS NULL OR idempotency_hash ~ '^[a-f0-9]{32}$')
);

CREATE TABLE IF NOT EXISTS public.store_order_items (
  id BIGSERIAL PRIMARY KEY,
  order_id bigint NOT NULL REFERENCES public.store_orders(id) ON DELETE CASCADE,
  product_id bigint REFERENCES public.store_catalog_products(id) ON DELETE SET NULL,
  nombre_producto text NOT NULL,
  precio_unitario numeric(12,2) NOT NULL CHECK (precio_unitario >= 0),
  cantidad integer NOT NULL CHECK (cantidad > 0),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Additive safety if a previous candidate created store_orders without the
-- idempotency columns. Existing data is preserved; new columns stay nullable.
ALTER TABLE public.store_orders ADD COLUMN IF NOT EXISTS idempotency_key text;
ALTER TABLE public.store_orders ADD COLUMN IF NOT EXISTS idempotency_hash text;
DO $constraints$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.store_orders'::regclass
       AND conname = 'store_orders_idempotency_pair_check'
  ) THEN
    ALTER TABLE public.store_orders
      ADD CONSTRAINT store_orders_idempotency_pair_check
      CHECK ((idempotency_key IS NULL) = (idempotency_hash IS NULL));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.store_orders'::regclass
       AND conname = 'store_orders_idempotency_key_check'
  ) THEN
    ALTER TABLE public.store_orders
      ADD CONSTRAINT store_orders_idempotency_key_check
      CHECK (idempotency_key IS NULL OR (length(idempotency_key) BETWEEN 1 AND 200));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.store_orders'::regclass
       AND conname = 'store_orders_idempotency_hash_check'
  ) THEN
    ALTER TABLE public.store_orders
      ADD CONSTRAINT store_orders_idempotency_hash_check
      CHECK (idempotency_hash IS NULL OR idempotency_hash ~ '^[a-f0-9]{32}$');
  END IF;
END
$constraints$;

CREATE INDEX IF NOT EXISTS idx_store_payment_methods_sede
  ON public.store_sede_payment_methods (sede_id, activo);
CREATE INDEX IF NOT EXISTS idx_store_orders_sede
  ON public.store_orders (sede_id, estado, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_store_orders_user
  ON public.store_orders (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_store_order_items_order
  ON public.store_order_items (order_id);
CREATE UNIQUE INDEX IF NOT EXISTS store_orders_idempotency_uq
  ON public.store_orders (user_id, sede_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

ALTER TABLE public.store_sede_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.store_sede_payment_methods ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.store_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.store_order_items ENABLE ROW LEVEL SECURITY;

-- No policies: anon/authenticated have no row access. service_role keeps its
-- existing bypassrls attribute; explicit grants below are the only client access.
REVOKE ALL ON TABLE public.store_sede_config FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.store_sede_payment_methods FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.store_orders FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.store_order_items FROM PUBLIC, anon, authenticated;
REVOKE ALL ON SEQUENCE public.store_sede_payment_methods_id_seq FROM PUBLIC, anon, authenticated;
REVOKE ALL ON SEQUENCE public.store_orders_id_seq FROM PUBLIC, anon, authenticated;
REVOKE ALL ON SEQUENCE public.store_order_items_id_seq FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.store_sede_config TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.store_sede_payment_methods TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.store_orders TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.store_order_items TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.store_sede_payment_methods_id_seq TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.store_orders_id_seq TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.store_order_items_id_seq TO service_role;

-- Transactional create. Idempotency scope is (verified buyer, sede, client key).
-- The cart hash covers fulfillment + sorted offer/quantity pairs; a replay with a
-- different cart raises STORE_IDEMPOTENCY_MISMATCH instead of creating a second
-- order or returning the previous one silently.
CREATE OR REPLACE FUNCTION public.store_create_order(
  p_user_id uuid,
  p_sede_id integer,
  p_fulfillment_type text,
  p_items jsonb,
  p_nota_cliente text DEFAULT NULL,
  p_idempotency_key text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  v_key text;
  v_count integer;
  v_distinct integer;
  v_cart_hash text;
  v_config public.store_sede_config%ROWTYPE;
  v_offer record;
  v_item record;
  v_total numeric := 0;
  v_currency text;
  v_order public.store_orders%ROWTYPE;
  v_payload jsonb;
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'STORE_AUTH_REQUIRED';
  END IF;
  IF p_sede_id IS NULL OR p_sede_id <= 0 THEN
    RAISE EXCEPTION 'STORE_INVALID_SEDE';
  END IF;
  IF p_fulfillment_type IS NULL OR p_fulfillment_type NOT IN ('pickup', 'local_delivery') THEN
    RAISE EXCEPTION 'STORE_INVALID_FULFILLMENT';
  END IF;

  v_key := NULLIF(btrim(COALESCE(p_idempotency_key, '')), '');
  IF v_key IS NOT NULL AND length(v_key) > 200 THEN
    RAISE EXCEPTION 'STORE_IDEMPOTENCY_KEY_INVALID';
  END IF;

  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array'
     OR jsonb_array_length(p_items) = 0 OR jsonb_array_length(p_items) > 50 THEN
    RAISE EXCEPTION 'STORE_INVALID_ITEMS';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM jsonb_array_elements(p_items) AS e
     WHERE (e->>'offer_id') IS NULL
        OR (e->>'quantity') IS NULL
        OR (e->>'offer_id') !~ '^[0-9]+$'
        OR (e->>'quantity') !~ '^[0-9]+$'
        OR (e->>'offer_id')::numeric <= 0
        OR (e->>'quantity')::numeric <= 0
        OR (e->>'offer_id')::numeric > 9223372036854775807
        OR (e->>'quantity')::numeric > 2147483647
  ) THEN
    RAISE EXCEPTION 'STORE_INVALID_ITEMS';
  END IF;

  SELECT count(*), count(DISTINCT (e->>'offer_id')::bigint)
    INTO v_count, v_distinct
    FROM jsonb_array_elements(p_items) AS e;
  IF v_count <> v_distinct THEN
    RAISE EXCEPTION 'STORE_INVALID_ITEMS';
  END IF;

  SELECT md5(
    p_fulfillment_type || '|' || string_agg(
      ((e->>'offer_id')::bigint)::text || ':' || ((e->>'quantity')::integer)::text,
      ',' ORDER BY (e->>'offer_id')::bigint
    )
  ) INTO v_cart_hash
    FROM jsonb_array_elements(p_items) AS e;

  -- The pair check requires both idempotency columns to be NULL together.
  IF v_key IS NULL THEN
    v_cart_hash := NULL;
  END IF;

  IF v_key IS NOT NULL THEN
    -- Serialise concurrent retries with the same (buyer, sede, key) before the
    -- existence check; the unique index remains the durable backstop.
    PERFORM pg_advisory_xact_lock(
      hashtextextended(p_user_id::text || '|' || p_sede_id::text || '|' || v_key, 0)
    );
    SELECT * INTO v_order
      FROM public.store_orders
     WHERE user_id = p_user_id
       AND sede_id = p_sede_id
       AND idempotency_key = v_key
     FOR UPDATE;
    IF FOUND THEN
      IF v_order.idempotency_hash IS DISTINCT FROM v_cart_hash THEN
        RAISE EXCEPTION 'STORE_IDEMPOTENCY_MISMATCH';
      END IF;
      SELECT jsonb_build_object(
        'order', (to_jsonb(v_order) - 'idempotency_key' - 'idempotency_hash'),
        'items', COALESCE((
          SELECT jsonb_agg(to_jsonb(i) ORDER BY i.id)
            FROM public.store_order_items i
           WHERE i.order_id = v_order.id
        ), '[]'::jsonb),
        'replayed', true
      ) INTO v_payload;
      RETURN v_payload;
    END IF;
  END IF;

  SELECT * INTO v_config
    FROM public.store_sede_config
   WHERE sede_id = p_sede_id;
  IF NOT FOUND OR v_config.estado <> 'active' THEN
    RAISE EXCEPTION 'STORE_NOT_ACTIVE';
  END IF;
  IF p_fulfillment_type = 'pickup' AND NOT v_config.retiro_en_sede THEN
    RAISE EXCEPTION 'STORE_PICKUP_UNAVAILABLE';
  END IF;
  IF p_fulfillment_type = 'local_delivery' AND NOT v_config.entrega_local THEN
    RAISE EXCEPTION 'STORE_DELIVERY_UNAVAILABLE';
  END IF;

  -- Lock offers in ascending id order so concurrent carts cannot deadlock.
  FOR v_item IN
    SELECT value AS item
      FROM jsonb_array_elements(p_items)
     ORDER BY (value->>'offer_id')::bigint
  LOOP
    SELECT o.id, o.product_id, o.activo, o.autorizado, o.autorizado_por_super,
           o.precio, o.moneda, o.stock,
           p.nombre AS producto_nombre, p.activo AS producto_activo
      INTO v_offer
      FROM public.store_sede_offers o
      JOIN public.store_catalog_products p ON p.id = o.product_id
     WHERE o.sede_id = p_sede_id
       AND o.id = (v_item.item->>'offer_id')::bigint
     FOR UPDATE OF o;

    IF NOT FOUND
       OR v_offer.activo IS NOT TRUE
       OR v_offer.autorizado IS NOT TRUE
       OR v_offer.autorizado_por_super IS NOT TRUE
       OR v_offer.producto_activo IS NOT TRUE THEN
      RAISE EXCEPTION 'STORE_OFFER_UNAVAILABLE';
    END IF;
    IF v_offer.precio IS NULL OR v_offer.precio < 0 THEN
      RAISE EXCEPTION 'STORE_PRICE_UNAVAILABLE';
    END IF;
    IF v_offer.moneda IS NULL OR btrim(v_offer.moneda) = '' THEN
      RAISE EXCEPTION 'STORE_PRICE_UNAVAILABLE';
    END IF;
    IF v_currency IS NULL THEN
      v_currency := v_offer.moneda;
    ELSIF v_currency <> v_offer.moneda THEN
      RAISE EXCEPTION 'STORE_CURRENCY_MISMATCH';
    END IF;
    IF v_offer.stock < (v_item.item->>'quantity')::integer THEN
      RAISE EXCEPTION 'STORE_STOCK_UNAVAILABLE';
    END IF;
    v_total := v_total + (v_offer.precio * (v_item.item->>'quantity')::integer);
  END LOOP;

  IF v_total > 9999999999.99 THEN
    RAISE EXCEPTION 'STORE_INVALID_ITEMS';
  END IF;

  FOR v_item IN
    SELECT value AS item
      FROM jsonb_array_elements(p_items)
     ORDER BY (value->>'offer_id')::bigint
  LOOP
    UPDATE public.store_sede_offers
       SET stock = stock - (v_item.item->>'quantity')::integer,
           updated_at = now()
     WHERE sede_id = p_sede_id
       AND id = (v_item.item->>'offer_id')::bigint
       AND stock >= (v_item.item->>'quantity')::integer;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'STORE_STOCK_CHANGED';
    END IF;
  END LOOP;

  INSERT INTO public.store_orders (
    codigo, sede_id, user_id, fulfillment_type, moneda, total, nota_cliente,
    estado, pago_estado, idempotency_key, idempotency_hash
  ) VALUES (
    'PMS-' || upper(to_hex((extract(epoch FROM clock_timestamp()) * 1000)::bigint))
           || '-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 6)),
    p_sede_id, p_user_id, p_fulfillment_type, v_currency, round(v_total, 2),
    NULLIF(left(btrim(COALESCE(p_nota_cliente, '')), 1000), ''),
    'nuevo', 'a_confirmar', v_key, v_cart_hash
  ) RETURNING * INTO v_order;

  INSERT INTO public.store_order_items (
    order_id, product_id, nombre_producto, precio_unitario, cantidad
  )
  SELECT v_order.id, o.product_id, p.nombre, o.precio, (e.item->>'quantity')::integer
    FROM jsonb_array_elements(p_items) AS e(item)
    JOIN public.store_sede_offers o
      ON o.id = (e.item->>'offer_id')::bigint
     AND o.sede_id = p_sede_id
    JOIN public.store_catalog_products p ON p.id = o.product_id
   ORDER BY (e.item->>'offer_id')::bigint;

  SELECT jsonb_build_object(
    'order', (to_jsonb(v_order) - 'idempotency_key' - 'idempotency_hash'),
    'items', COALESCE((
      SELECT jsonb_agg(to_jsonb(i) ORDER BY i.id)
        FROM public.store_order_items i
       WHERE i.order_id = v_order.id
    ), '[]'::jsonb),
    'replayed', false
  ) INTO v_payload;
  RETURN v_payload;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.store_update_order(
  p_order_id bigint,
  p_sede_id integer,
  p_estado text DEFAULT NULL,
  p_pago_estado text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  v_order public.store_orders%ROWTYPE;
  v_prev_estado text;
  v_next_estado text;
  v_next_pago text;
  v_item record;
  v_payload jsonb;
BEGIN
  IF p_order_id IS NULL OR p_order_id <= 0 OR p_sede_id IS NULL OR p_sede_id <= 0 THEN
    RAISE EXCEPTION 'STORE_ORDER_NOT_FOUND';
  END IF;
  IF p_estado IS NOT NULL
     AND p_estado NOT IN ('nuevo','confirmado','preparando','listo_retiro','enviado','entregado','cancelado') THEN
    RAISE EXCEPTION 'STORE_INVALID_STATE';
  END IF;
  IF p_pago_estado IS NOT NULL
     AND p_pago_estado NOT IN ('pendiente','a_confirmar','confirmado','rechazado','reembolsado') THEN
    RAISE EXCEPTION 'STORE_INVALID_STATE';
  END IF;

  SELECT * INTO v_order
    FROM public.store_orders
   WHERE id = p_order_id AND sede_id = p_sede_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'STORE_ORDER_NOT_FOUND';
  END IF;

  v_prev_estado := v_order.estado;
  v_next_estado := COALESCE(p_estado, v_order.estado);
  v_next_pago := COALESCE(p_pago_estado, v_order.pago_estado);

  IF v_prev_estado = 'cancelado' AND v_next_estado <> 'cancelado' THEN
    FOR v_item IN
      SELECT product_id, sum(cantidad)::integer AS cantidad
        FROM public.store_order_items
       WHERE order_id = p_order_id AND product_id IS NOT NULL
       GROUP BY product_id
       ORDER BY product_id
    LOOP
      UPDATE public.store_sede_offers
         SET stock = stock - v_item.cantidad, updated_at = now()
       WHERE sede_id = p_sede_id
         AND product_id = v_item.product_id
         AND stock >= v_item.cantidad;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'STORE_STOCK_UNAVAILABLE';
      END IF;
    END LOOP;
  END IF;

  UPDATE public.store_orders
     SET estado = v_next_estado,
         pago_estado = v_next_pago,
         updated_at = now()
   WHERE id = p_order_id
   RETURNING * INTO v_order;

  IF v_prev_estado <> 'cancelado' AND v_next_estado = 'cancelado' THEN
    UPDATE public.store_sede_offers o
       SET stock = o.stock + restored.cantidad,
           updated_at = now()
      FROM (
        SELECT product_id, sum(cantidad)::integer AS cantidad
          FROM public.store_order_items
         WHERE order_id = p_order_id AND product_id IS NOT NULL
         GROUP BY product_id
      ) restored
     WHERE o.sede_id = p_sede_id
       AND o.product_id = restored.product_id;
  END IF;

  SELECT jsonb_build_object(
    'order', (to_jsonb(v_order) - 'idempotency_key' - 'idempotency_hash'),
    'items', COALESCE((
      SELECT jsonb_agg(to_jsonb(i) ORDER BY i.id)
        FROM public.store_order_items i
       WHERE i.order_id = v_order.id
    ), '[]'::jsonb),
    'replayed', false
  ) INTO v_payload;
  RETURN v_payload;
END;
$fn$;

REVOKE ALL ON FUNCTION public.store_create_order(uuid, integer, text, jsonb, text, text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.store_update_order(bigint, integer, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.store_create_order(uuid, integer, text, jsonb, text, text)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.store_update_order(bigint, integer, text, text)
  TO service_role;

-- Ask PostgREST to refresh its function/table cache after the DDL commit.
NOTIFY pgrst, 'reload schema';

-- BODY-END 8

-- SOURCE 9 sql/candidates/20261123170000_invitacion_club_atomica.sql SHA256 cb7fb207e769ba676ba53fcfa4a5be0e18a823ab1d6e074b0e7842f10ee0a2a7
-- BODY-BEGIN 9
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
-- BODY-END 9

-- SOURCE 10 sql/candidates/20261123_sede_pending_approval_atomic.sql SHA256 25ae66c827da2a9415f134e7ff2f9e7257d58b2736a14071316117a73ac0daa8
-- BODY-BEGIN 10
-- LOCAL CANDIDATE ONLY. Pending approval DB portion; Auth remains outside.
-- Requires reviewed effective sedes/sedes_pendientes/user_roles/organization schema.
-- No table/column/role/RLS change; no automatic application.
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
-- BODY-END 10

-- SOURCE 11 sql/candidates/20261123_admin_role_assignment_atomic.sql SHA256 f1f7230b7c12d8cc999445484fbb0c72cf6927e07d8853365d5e5c14cbbcd2d8
-- BODY-BEGIN 11
-- LOCAL CANDIDATE ONLY. Already-permitted SuperAdmin non-editor assignments.
-- No global email UNIQUE, no role/table/RLS change, no merging/deleting old rows.
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
-- BODY-END 11

COMMIT;
