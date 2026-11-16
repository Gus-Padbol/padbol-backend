-- CANONICAL CANDIDATE. Single transaction. Do not apply to production yet.
BEGIN;
CREATE TABLE IF NOT EXISTS public.nations_award_policies (
  torneo_id bigint PRIMARY KEY REFERENCES public.torneos(id) ON DELETE CASCADE,
  policy jsonb NOT NULL,
  policy_digest text NOT NULL,
  source_revision bigint NOT NULL,
  finalized_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.nations_awards (
  torneo_id bigint NOT NULL REFERENCES public.torneos(id) ON DELETE CASCADE,
  player_id text NOT NULL,
  player_name text NOT NULL,
  award_key text NOT NULL,
  position text NOT NULL,
  base numeric NOT NULL,
  bonus numeric NOT NULL,
  coefficient numeric NOT NULL,
  points numeric NOT NULL,
  source_digest text NOT NULL,
  source_revision bigint NOT NULL,
  status text NOT NULL DEFAULT 'preview' CHECK (status IN ('preview','awarded','void')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (torneo_id, player_id),
  UNIQUE (award_key)
);
ALTER TABLE public.nations_award_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.nations_awards ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.nations_award_policies, public.nations_awards FROM anon,authenticated;
GRANT SELECT,INSERT,UPDATE ON public.nations_award_policies, public.nations_awards TO service_role;

CREATE OR REPLACE FUNCTION public.guardar_nations_awards(p_torneo_id bigint,p_payload jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE row jsonb; src bigint; n int:=0; prev public.nations_award_policies; plan jsonb;
BEGIN
 IF p_payload->>'definitive' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='Awards require definitive close'; END IF;
 src:=(p_payload->>'sourceRevision')::bigint; IF src IS NULL OR src<0 THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='sourceRevision required'; END IF;
 IF jsonb_typeof(p_payload->'rows') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='rows required'; END IF;
 PERFORM 1 FROM public.torneos WHERE id=p_torneo_id FOR UPDATE;
 SELECT p.plan INTO plan FROM public.torneo_nations_planes p WHERE p.torneo_id=p_torneo_id FOR UPDATE;
 IF plan->'award_policy'->>'confirmed' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='Award policy not confirmed'; END IF;
 SELECT * INTO prev FROM public.nations_award_policies WHERE torneo_id=p_torneo_id FOR UPDATE;
 IF prev.torneo_id IS NOT NULL AND src<prev.source_revision THEN RAISE EXCEPTION USING ERRCODE='40001',MESSAGE='Stale awards source revision'; END IF;
 FOR row IN SELECT * FROM jsonb_array_elements(p_payload->'rows') LOOP
  INSERT INTO public.nations_awards(torneo_id,player_id,player_name,award_key,position,base,bonus,coefficient,points,source_digest,source_revision,status)
  VALUES(p_torneo_id,row->>'playerId',row->>'playerName',row->>'key',row->>'position',(row->>'base')::numeric,(row->>'bonus')::numeric,(row->>'coefficient')::numeric,(row->>'points')::numeric,row->>'sourceDigest',src,'awarded')
  ON CONFLICT (torneo_id,player_id) DO UPDATE SET player_name=EXCLUDED.player_name,position=EXCLUDED.position,base=EXCLUDED.base,bonus=EXCLUDED.bonus,coefficient=EXCLUDED.coefficient,points=EXCLUDED.points,source_digest=EXCLUDED.source_digest,source_revision=EXCLUDED.source_revision,status='awarded',updated_at=now()
  WHERE public.nations_awards.source_digest IS DISTINCT FROM EXCLUDED.source_digest OR public.nations_awards.status <> 'awarded';
  n:=n+1;
 END LOOP;
 UPDATE public.nations_awards a SET status='void',updated_at=now() WHERE a.torneo_id=p_torneo_id AND a.status='awarded' AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p_payload->'rows') x WHERE x->>'playerId'=a.player_id);
 INSERT INTO public.nations_award_policies(torneo_id,policy,policy_digest,source_revision,finalized_at,updated_at) VALUES(p_torneo_id,p_payload->'policy',encode(extensions.digest((p_payload->'policy')::text,'sha256'),'hex'),src,now(),now()) ON CONFLICT(torneo_id) DO UPDATE SET policy=EXCLUDED.policy,policy_digest=EXCLUDED.policy_digest,source_revision=EXCLUDED.source_revision,finalized_at=now(),updated_at=now();
 RETURN jsonb_build_object('ok',true,'torneo_id',p_torneo_id,'rows',n,'sourceRevision',src);
END $$;
REVOKE ALL ON FUNCTION public.guardar_nations_awards(bigint,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.guardar_nations_awards(bigint,jsonb) TO service_role;

-- Idempotent core rename; one transaction. If core already exists, wrapper only.
DO $$
DECLARE has_core boolean; has_public boolean;
BEGIN
 has_core:=to_regprocedure('public.guardar_plan_nations_core(bigint,uuid,text,bigint,uuid,text,jsonb)') IS NOT NULL;
 has_public:=to_regprocedure('public.guardar_plan_nations(bigint,uuid,text,bigint,uuid,text,jsonb)') IS NOT NULL;
 IF NOT has_core THEN
   IF NOT has_public THEN RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='Canonical guardar_plan_nations missing'; END IF;
   EXECUTE 'ALTER FUNCTION public.guardar_plan_nations(bigint,uuid,text,bigint,uuid,text,jsonb) RENAME TO guardar_plan_nations_core';
 END IF;
END $$;
CREATE OR REPLACE FUNCTION public.guardar_plan_nations(p_torneo_id bigint,p_actor_id uuid,p_action text,p_revision bigint,p_request_id uuid,p_request_digest text,p_payload jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE result jsonb;
BEGIN
 IF p_action='finalizar' AND p_payload ? 'awards' THEN
   IF p_payload->'awards'->>'definitive' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Awards payload must be definitive'; END IF;
   result:=public.guardar_plan_nations_core(p_torneo_id,p_actor_id,p_action,p_revision,p_request_id,p_request_digest,p_payload);
   IF result->>'ok' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Core finalization unconfirmed'; END IF;
   -- A replayed core request must not rewrite awards with old client payload.
   IF result->>'status'='idempotent' THEN RETURN result; END IF;
   PERFORM public.guardar_nations_awards(p_torneo_id,p_payload->'awards');
   RETURN result;
 END IF;
 RETURN public.guardar_plan_nations_core(p_torneo_id,p_actor_id,p_action,p_revision,p_request_id,p_request_digest,p_payload);
END $$;
REVOKE ALL ON FUNCTION public.guardar_plan_nations(bigint,uuid,text,bigint,uuid,text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.guardar_plan_nations(bigint,uuid,text,bigint,uuid,text,jsonb) TO service_role;
COMMIT;
