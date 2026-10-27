-- Experimental; receipt/cancellation and the mutation are one transaction.
CREATE TABLE public.scoreboard_transition_receipt_isolated_candidate (
 action_id uuid PRIMARY KEY, scoreboard_id uuid NOT NULL, actor_id uuid NOT NULL,
 action text NOT NULL, parameters jsonb NOT NULL, result jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE public.scoreboard_transition_cancelled_isolated_candidate (
 action_id uuid PRIMARY KEY, scoreboard_id uuid NOT NULL, actor_id uuid NOT NULL,
 action text NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE public.scoreboard_suspension_reason_isolated_candidate (
 action_id uuid PRIMARY KEY, scoreboard_id uuid NOT NULL, actor_id uuid NOT NULL,
 reason text NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE public.scoreboard_suspension_reason_isolated_candidate ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.scoreboard_suspension_reason_isolated_candidate FROM PUBLIC,anon,authenticated,service_role;
ALTER TABLE public.scoreboard_transition_receipt_isolated_candidate ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.scoreboard_transition_cancelled_isolated_candidate ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.scoreboard_transition_receipt_isolated_candidate,public.scoreboard_transition_cancelled_isolated_candidate FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.scoreboard_transition_receipt_isolated_candidate(
 p_action_id uuid,p_action text,p_id uuid,p_actor uuid,p_expected timestamptz,p_court_id bigint,p_duration integer,p_reason text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE board public.scoreboard_partidos;r public.user_roles; receipt public.scoreboard_transition_receipt_isolated_candidate;
 params jsonb; result jsonb;
BEGIN
 IF p_action_id IS NULL OR p_action NOT IN ('suspend','resume') OR p_action IS NULL OR p_expected IS NULL
 OR (p_action='suspend' AND (p_court_id IS NOT NULL OR p_duration IS NOT NULL OR length(trim(coalesce(p_reason,''))) NOT BETWEEN 1 AND 500))
 OR (p_action='resume' AND p_reason IS NOT NULL) THEN
  RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Invalid transition reference'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(p_action_id::text,175921));
 SELECT * INTO board FROM public.scoreboard_partidos WHERE id=p_id;
 SELECT * INTO r FROM public.user_roles WHERE user_id=p_actor FOR SHARE;
 IF board.id IS NULL OR (r.role='super_admin' OR r.role IN ('admin_club','admin_sede') AND r.sede_id=board.sede_id) IS DISTINCT FROM true THEN
  RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Scope denied'; END IF;
 params:=jsonb_build_object('expected',p_expected,'court',p_court_id,'duration',p_duration,'reason',p_reason);
 SELECT * INTO receipt FROM public.scoreboard_transition_receipt_isolated_candidate WHERE action_id=p_action_id;
 IF FOUND THEN
  IF receipt.scoreboard_id IS DISTINCT FROM p_id OR receipt.actor_id IS DISTINCT FROM p_actor OR receipt.action IS DISTINCT FROM p_action OR receipt.parameters IS DISTINCT FROM params THEN
   RAISE EXCEPTION USING ERRCODE='23505',MESSAGE='Action reference already used'; END IF;
  RETURN jsonb_build_object('status','replayed','result',receipt.result);
 END IF;
 IF EXISTS(SELECT 1 FROM public.scoreboard_transition_cancelled_isolated_candidate WHERE action_id=p_action_id) THEN
  RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='Action reference cancelled'; END IF;
 IF p_action='suspend' THEN result:=public.scoreboard_suspend_candidate(p_id,p_expected,p_actor);
 ELSE result:=public.scoreboard_resume_candidate(p_id,p_expected,p_actor,p_court_id,p_duration); END IF;
 IF result IS NULL THEN RETURN jsonb_build_object('status','conflict'); END IF;
 IF p_action='suspend' THEN INSERT INTO public.scoreboard_suspension_reason_isolated_candidate(action_id,scoreboard_id,actor_id,reason) VALUES(p_action_id,p_id,p_actor,trim(p_reason)); END IF;
 INSERT INTO public.scoreboard_transition_receipt_isolated_candidate(action_id,scoreboard_id,actor_id,action,parameters,result)
 VALUES(p_action_id,p_id,p_actor,p_action,params,result);
 RETURN jsonb_build_object('status','applied','result',result);
END $$;
REVOKE ALL ON FUNCTION public.scoreboard_transition_receipt_isolated_candidate(uuid,text,uuid,uuid,timestamptz,bigint,integer,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.scoreboard_transition_receipt_isolated_candidate(uuid,text,uuid,uuid,timestamptz,bigint,integer,text) TO service_role;

CREATE OR REPLACE FUNCTION public.scoreboard_reconcile_isolated_candidate(p_action_id uuid,p_action text,p_id uuid,p_actor uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE board public.scoreboard_partidos;r public.user_roles; receipt public.scoreboard_transition_receipt_isolated_candidate;
 cancel public.scoreboard_transition_cancelled_isolated_candidate;
BEGIN
 IF p_action_id IS NULL OR p_action NOT IN ('suspend','resume') OR p_action IS NULL THEN
  RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Invalid transition reference'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(p_action_id::text,175921));
 SELECT * INTO board FROM public.scoreboard_partidos WHERE id=p_id;
 SELECT * INTO r FROM public.user_roles WHERE user_id=p_actor FOR SHARE;
 IF board.id IS NULL OR (r.role='super_admin' OR r.role IN ('admin_club','admin_sede') AND r.sede_id=board.sede_id) IS DISTINCT FROM true THEN
  RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Scope denied'; END IF;
 SELECT * INTO receipt FROM public.scoreboard_transition_receipt_isolated_candidate WHERE action_id=p_action_id;
 IF FOUND THEN
  IF receipt.scoreboard_id IS DISTINCT FROM p_id OR receipt.actor_id IS DISTINCT FROM p_actor OR receipt.action IS DISTINCT FROM p_action THEN
   RAISE EXCEPTION USING ERRCODE='23505',MESSAGE='Action reference already used'; END IF;
  RETURN jsonb_build_object('status','applied','result',receipt.result);
 END IF;
 SELECT * INTO cancel FROM public.scoreboard_transition_cancelled_isolated_candidate WHERE action_id=p_action_id;
 IF FOUND THEN
  IF cancel.scoreboard_id IS DISTINCT FROM p_id OR cancel.actor_id IS DISTINCT FROM p_actor OR cancel.action IS DISTINCT FROM p_action THEN
   RAISE EXCEPTION USING ERRCODE='23505',MESSAGE='Action reference already used'; END IF;
  RETURN jsonb_build_object('status','cancelled');
 END IF;
 INSERT INTO public.scoreboard_transition_cancelled_isolated_candidate(action_id,scoreboard_id,actor_id,action) VALUES(p_action_id,p_id,p_actor,p_action);
 RETURN jsonb_build_object('status','cancelled');
END $$;
REVOKE ALL ON FUNCTION public.scoreboard_reconcile_isolated_candidate(uuid,text,uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.scoreboard_reconcile_isolated_candidate(uuid,text,uuid,uuid) TO service_role;
