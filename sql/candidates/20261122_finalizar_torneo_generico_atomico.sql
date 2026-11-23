-- Generic (non-Nations) tournament closure.
-- One transaction persists the immutable ledger (tabla_puntos), the team points
-- (equipos.puntos_ranking) and the tournament state (torneos.estado/fecha_fin).
-- The backend route authenticates the caller and computes the final ranking;
-- this function only accepts a complete, self-consistent snapshot and is
-- executable by service_role only. A retry on an already closed tournament
-- returns the stored ledger without recalculating it.
BEGIN;

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

COMMIT;
