-- Candidate only. Canonical source is public.torneo_nations_planes.plan; summary stays coherent.
BEGIN;
CREATE OR REPLACE FUNCTION public.configurar_award_policy_nations_57(p_expected_plan_md5 text,p_expected_revision bigint,p_policy jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_plan jsonb; summary jsonb; new_plan jsonb; new_summary jsonb;
BEGIN
  IF p_policy IS NULL OR jsonb_typeof(p_policy) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='award_policy object required'; END IF;
  IF p_policy->>'confirmed' IS DISTINCT FROM 'true' OR p_policy->>'confirmedTour500' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='confirmedTour500 required'; END IF;
  IF p_policy->>'unit' IS DISTINCT FROM 'sets' THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='award_policy.unit=sets required'; END IF;
  IF p_policy->>'denominatorMode' IS DISTINCT FROM 'max_player_sets' THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='denominatorMode=max_player_sets required'; END IF;
  IF p_policy->>'bonusProration' IS DISTINCT FROM 'none' THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='bonusProration=none required'; END IF;
  IF (p_policy->>'minimumSets')::int IS DISTINCT FROM 1 THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='minimumSets=1 required'; END IF;
  SELECT t.plan_nations INTO summary FROM public.torneos t WHERE t.id=57 FOR UPDATE;
  SELECT p.plan INTO v_plan FROM public.torneo_nations_planes p WHERE p.torneo_id=57 FOR UPDATE;
  IF v_plan IS NULL OR summary IS NULL THEN RAISE EXCEPTION USING ERRCODE='P0002',MESSAGE='torneo57 canonical plan/summary missing'; END IF;
  IF md5(v_plan::text) IS DISTINCT FROM p_expected_plan_md5 OR (v_plan->>'revision')::bigint IS DISTINCT FROM p_expected_revision THEN RAISE EXCEPTION USING ERRCODE='40001',MESSAGE='plan CAS mismatch (private hash/revision)'; END IF;
  IF coalesce(v_plan->'award_policy','null'::jsonb) IS DISTINCT FROM 'null'::jsonb THEN RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='award_policy already configured'; END IF;
  PERFORM set_config('padbol.nations_rpc','1',true);
  new_plan:=jsonb_set(jsonb_set(v_plan,'{award_policy}',p_policy,true),'{revision}',to_jsonb(p_expected_revision+1),true);
  new_summary:=jsonb_set(jsonb_set(summary,'{award_policy}',p_policy,true),'{revision}',to_jsonb(p_expected_revision+1),true);
  UPDATE public.torneo_nations_planes AS t SET plan=new_plan,updated_at=now() WHERE t.torneo_id=57 AND md5(t.plan::text)=p_expected_plan_md5;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='40001',MESSAGE='Private plan CAS update lost'; END IF;
  UPDATE public.torneos SET plan_nations=new_summary,updated_at=now() WHERE id=57 AND plan_nations IS NOT DISTINCT FROM summary;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='40001',MESSAGE='plan CAS update lost'; END IF;
  RETURN jsonb_build_object('ok',true,'torneo_id',57,'revision',p_expected_revision+1,'plan_md5_before',md5(v_plan::text),'plan_md5_after',md5(new_plan::text),'award_policy',p_policy);
END $$;
REVOKE ALL ON FUNCTION public.configurar_award_policy_nations_57(text,bigint,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.configurar_award_policy_nations_57(text,bigint,jsonb) TO service_role;
COMMIT;
