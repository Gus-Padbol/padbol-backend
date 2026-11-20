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
  sets_a integer := 0;
  sets_b integer := 0;
  set_count integer;
  i integer;
  s jsonb;
  set_a integer;
  set_b integer;
  points_a integer;
  points_b integer;
  winner bigint;
  existing public.nations_official_result_recoveries;
  previous_setting text;
  first_two_split boolean := false;
BEGIN
  IF p_actor_id IS NULL OR p_resultado IS NULL THEN
    RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='Actor and result are required';
  END IF;
  SELECT * INTO t FROM public.torneos WHERE id=57 FOR UPDATE;
  IF t.id IS NULL OR t.modalidad_plantel IS DISTINCT FROM 'selecciones' OR t.estado IS DISTINCT FROM 'en_curso' THEN
    RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='Nations event is not in progress';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('nations-official-result-recovery',0));
  PERFORM 1
    FROM nations_operator.grants g
    JOIN auth.users u ON u.id=g.user_id
   WHERE g.user_id=p_actor_id AND g.torneo_id=57 AND g.revoked_at IS NULL
     AND g.expires_at>clock_timestamp()
     AND u.email_confirmed_at IS NOT NULL
     AND to_jsonb(u)->>'deleted_at' IS NULL
     AND NOT coalesce(nullif(to_jsonb(u)->>'banned_until','')::timestamptz>clock_timestamp(),false)
   FOR SHARE OF g,u;
  IF NOT FOUND THEN
    PERFORM 1
      FROM public.user_roles r
      JOIN auth.users u ON u.id=r.user_id
     WHERE r.user_id=p_actor_id AND r.role='super_admin'
       AND u.email_confirmed_at IS NOT NULL
       AND to_jsonb(u)->>'deleted_at' IS NULL
       AND NOT coalesce(nullif(to_jsonb(u)->>'banned_until','')::timestamptz>clock_timestamp(),false)
     FOR SHARE OF r,u;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='Operator grant required for recovery';
    END IF;
  END IF;
  SELECT * INTO m FROM public.partidos WHERE id=p_partido_id FOR UPDATE;
  IF m.id IS NULL OR m.torneo_id IS DISTINCT FROM 57 THEN
    RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='Match is not part of Nations 57';
  END IF;
  IF m.equipo_a_id IS NULL OR m.equipo_b_id IS NULL OR m.equipo_a_id=m.equipo_b_id THEN
    RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='Match teams are invalid';
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
  IF jsonb_typeof(p_resultado->'historial_sets') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='Set-by-set games are required';
  END IF;
  set_count := jsonb_array_length(p_resultado->'historial_sets');
  IF set_count NOT IN (2,3) THEN
    RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='Two or three sets are required';
  END IF;
  FOR i IN 0..set_count-1 LOOP
    s := p_resultado->'historial_sets'->i;
    IF jsonb_typeof(s->'a') IS DISTINCT FROM 'number' OR jsonb_typeof(s->'b') IS DISTINCT FROM 'number' THEN
      RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='Each set needs numeric games';
    END IF;
    IF s ? 'set' THEN
      IF jsonb_typeof(s->'set') IS DISTINCT FROM 'number' OR (s->>'set')::integer <> i+1 THEN
        RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='Set sequence must be 1,2,3';
      END IF;
    END IF;
    set_a := (s->>'a')::integer;
    set_b := (s->>'b')::integer;
    IF set_a < 0 OR set_b < 0 OR set_a=set_b THEN
      RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='Invalid or tied set';
    END IF;
    IF i < 2 AND s ? 'type' THEN
      RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='Super tiebreak is only valid as the third group set';
    END IF;
    IF i < 2 OR (i=2 AND m.grupo IS NULL) THEN
      IF NOT ((greatest(set_a,set_b)=6 AND least(set_a,set_b)<=4)
           OR (greatest(set_a,set_b)=7 AND least(set_a,set_b) IN (5,6))) THEN
        RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='Invalid normal set score';
      END IF;
    END IF;
    IF i=2 AND m.grupo IS NOT NULL THEN
      IF s->>'type' IS DISTINCT FROM 'super_tiebreak' OR set_a NOT IN (0,1) OR set_b NOT IN (0,1) OR set_a=set_b THEN
        RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='Group third set must be canonical super tiebreak';
      END IF;
      IF jsonb_typeof(s->'points_a') IS DISTINCT FROM 'number' OR jsonb_typeof(s->'points_b') IS DISTINCT FROM 'number'
         OR jsonb_typeof(s->'target') IS DISTINCT FROM 'number' OR (s->>'target')::integer <> 10
         OR jsonb_typeof(s->'win_by') IS DISTINCT FROM 'number' OR (s->>'win_by')::integer <> 1 THEN
        RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='TB10 target 10 and win_by 1 are required';
      END IF;
      points_a := (s->>'points_a')::integer;
      points_b := (s->>'points_b')::integer;
      IF greatest(points_a,points_b)<>10 OR least(points_a,points_b)<0 OR least(points_a,points_b)>=10 OR (points_a>points_b)<>(set_a=1) THEN
        RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='Invalid TB10 score';
      END IF;
    ELSIF i=2 AND s ? 'type' THEN
      RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='Knockout third set must be a normal set';
    END IF;
    IF set_a>set_b THEN sets_a:=sets_a+1; ELSE sets_b:=sets_b+1; END IF;
    IF i=1 THEN first_two_split := (sets_a=1 AND sets_b=1); END IF;
  END LOOP;
  IF set_count=3 AND NOT first_two_split THEN
    RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='Cannot have a third set after a 2-0 start';
  END IF;
  IF sets_a<>sa OR sets_b<>sb THEN
    RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='Set totals do not match games';
  END IF;
  winner := CASE WHEN sa>sb THEN m.equipo_a_id ELSE m.equipo_b_id END;
  IF m.estado='finalizado' THEN
    SELECT * INTO existing FROM public.nations_official_result_recoveries WHERE partido_id=m.id;
    IF existing.id IS NOT NULL AND existing.resultado=p_resultado AND existing.ganador_equipo_id=winner
       AND m.resultado=p_resultado AND m.ganador_equipo_id=winner THEN
      RETURN jsonb_build_object('ok',true,'status','idempotent','partido_id',m.id,'recovery_id',existing.id);
    END IF;
    RAISE EXCEPTION USING ERRCODE='40001', MESSAGE='Official result already frozen';
  END IF;
  IF m.estado IS DISTINCT FROM 'pendiente' THEN
    RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='Recovery only applies to pending matches';
  END IF;
  previous_setting := current_setting('padbol.national_final_rpc',true);
  PERFORM set_config('padbol.national_final_rpc','1',true);
  UPDATE public.partidos
     SET estado='finalizado', resultado=p_resultado, ganador_equipo_id=winner
   WHERE id=m.id;
  PERFORM set_config('padbol.national_final_rpc',coalesce(previous_setting,''),true);
  INSERT INTO public.nations_official_result_recoveries(partido_id,torneo_id,resultado,ganador_equipo_id,actor_id)
  VALUES(m.id,57,p_resultado,winner,p_actor_id)
  RETURNING * INTO existing;
  RETURN jsonb_build_object('ok',true,'status','recovered','partido_id',m.id,'recovery_id',existing.id,'ganador_equipo_id',winner);
END $$;
REVOKE ALL ON FUNCTION public.recuperar_resultado_equipo_nations(bigint,jsonb,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.recuperar_resultado_equipo_nations(bigint,jsonb,uuid) TO service_role;
