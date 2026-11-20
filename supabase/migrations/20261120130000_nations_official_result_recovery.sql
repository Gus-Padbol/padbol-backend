-- Audited recovery of already-played Nations 57 team results.
-- Intentionally does NOT create player participation or ranking/award rows.
CREATE TABLE IF NOT EXISTS public.nations_official_result_recoveries (
  id bigserial PRIMARY KEY,
  partido_id bigint NOT NULL UNIQUE REFERENCES public.partidos(id),
  torneo_id bigint NOT NULL,
  resultado jsonb NOT NULL,
  ganador_equipo_id bigint NOT NULL,
  actor_id uuid NOT NULL,
  fuente text NOT NULL DEFAULT 'scoresheet_recovery',
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.nations_official_result_recoveries ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.nations_official_result_recoveries FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON TABLE public.nations_official_result_recoveries TO service_role;

CREATE OR REPLACE FUNCTION public.recuperar_resultado_equipo_nations(
  p_partido_id bigint,
  p_resultado jsonb,
  p_actor_id uuid
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE
  m public.partidos;
  t public.torneos;
  sa integer;
  sb integer;
  winner bigint;
  existing public.nations_official_result_recoveries;
BEGIN
  IF p_actor_id IS NULL OR p_resultado IS NULL THEN
    RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='Actor and result are required';
  END IF;
  SELECT * INTO t FROM public.torneos WHERE id=57 FOR UPDATE;
  IF t.id IS NULL OR t.modalidad_plantel IS DISTINCT FROM 'selecciones' THEN
    RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='Nations event unavailable';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM nations_operator.grants g
    JOIN auth.users u ON u.id=g.user_id
    WHERE g.user_id=p_actor_id AND g.torneo_id=57 AND g.revoked_at IS NULL
      AND g.expires_at>clock_timestamp()
      AND u.email_confirmed_at IS NOT NULL
      AND to_jsonb(u)->>'deleted_at' IS NULL
      AND NOT coalesce(nullif(to_jsonb(u)->>'banned_until','')::timestamptz>clock_timestamp(),false)
  ) AND NOT EXISTS (
    SELECT 1 FROM public.user_roles r WHERE r.user_id=p_actor_id AND r.role='super_admin'
  ) THEN
    RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='Operator grant required for recovery';
  END IF;
  SELECT * INTO m FROM public.partidos WHERE id=p_partido_id FOR UPDATE;
  IF m.id IS NULL OR m.torneo_id IS DISTINCT FROM 57 THEN
    RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='Match is not part of Nations 57';
  END IF;
  IF EXISTS (SELECT 1 FROM public.scoreboard_partidos WHERE partido_torneo_id=m.id) THEN
    RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='Recovery refused: match has a scoreboard';
  END IF;
  IF jsonb_typeof(p_resultado->'goles_a') IS DISTINCT FROM 'number' OR jsonb_typeof(p_resultado->'goles_b') IS DISTINCT FROM 'number' THEN
    RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='Invalid set totals';
  END IF;
  sa := (p_resultado->>'goles_a')::integer;
  sb := (p_resultado->>'goles_b')::integer;
  IF NOT ((sa=2 AND sb IN(0,1)) OR (sb=2 AND sa IN(0,1))) THEN
    RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='Match must finish 2-0 or 2-1';
  END IF;
  IF jsonb_typeof(p_resultado->'historial_sets') IS DISTINCT FROM 'array'
     OR jsonb_array_length(p_resultado->'historial_sets') NOT IN (2,3) THEN
    RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='Set-by-set games are required';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_resultado->'historial_sets') s
    WHERE coalesce((s->>'a')::int, -1) < 0 OR coalesce((s->>'b')::int, -1) < 0
       OR coalesce((s->>'a')::int, -1) = coalesce((s->>'b')::int, -2)
  ) THEN
    RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='Invalid or tied set';
  END IF;
  winner := CASE WHEN sa>sb THEN m.equipo_a_id ELSE m.equipo_b_id END;
  IF m.estado='finalizado' THEN
    SELECT * INTO existing FROM public.nations_official_result_recoveries WHERE partido_id=m.id;
    IF existing.id IS NOT NULL AND existing.resultado=p_resultado AND existing.ganador_equipo_id=winner THEN
      RETURN jsonb_build_object('ok',true,'status','idempotent','partido_id',m.id,'recovery_id',existing.id);
    END IF;
    RAISE EXCEPTION USING ERRCODE='40001', MESSAGE='Official result already frozen';
  END IF;
  IF m.estado IS DISTINCT FROM 'pendiente' THEN
    RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='Recovery only applies to pending matches';
  END IF;
  PERFORM set_config('padbol.national_final_rpc','1',true);
  UPDATE public.partidos
     SET estado='finalizado', resultado=p_resultado, ganador_equipo_id=winner
   WHERE id=m.id;
  INSERT INTO public.nations_official_result_recoveries(partido_id,torneo_id,resultado,ganador_equipo_id,actor_id)
  VALUES(m.id,57,p_resultado,winner,p_actor_id)
  RETURNING * INTO existing;
  RETURN jsonb_build_object('ok',true,'status','recovered','partido_id',m.id,'recovery_id',existing.id,'ganador_equipo_id',winner);
END $$;
REVOKE ALL ON FUNCTION public.recuperar_resultado_equipo_nations(bigint,jsonb,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.recuperar_resultado_equipo_nations(bigint,jsonb,uuid) TO service_role;
