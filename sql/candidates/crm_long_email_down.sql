-- Strict rollback refuses to delete/truncate long email history.
BEGIN;
SET LOCAL lock_timeout='100ms';
SET LOCAL statement_timeout='750ms';
SET LOCAL transaction_timeout='1s';
SET LOCAL idle_in_transaction_session_timeout='750ms';
LOCK TABLE public.crm_conversations,public.crm_replies IN ACCESS EXCLUSIVE MODE NOWAIT;
DO $guard$ BEGIN
 IF md5(pg_get_functiondef('public.crm_commercial_team_form_claim_reply(uuid,boolean,uuid,uuid,text)'::regprocedure))<>'f59483e819120564102efb1bd706cc89' THEN RAISE EXCEPTION 'claim function changed; review rollback'; END IF;
 IF EXISTS(SELECT 1 FROM public.crm_replies WHERE length(trim(body))>4096) THEN RAISE EXCEPTION 'strict rollback blocked: preserve long email history; application rollback must keep expanded storage'; END IF;
END $guard$;
CREATE OR REPLACE FUNCTION public.crm_commercial_team_form_claim_reply(p_actor uuid, p_superadmin boolean, p_case uuid, p_reply_id uuid, p_body text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare v_assigned uuid;v_email text;v_created boolean;v_reply public.crm_replies%rowtype;
begin
 if p_actor is null or p_reply_id is null or length(btrim(coalesce(p_body,''))) not between 1 and 4096 then raise exception 'invalid reply'; end if;
 select lower(email) into v_email from auth.users where id=p_actor and email_confirmed_at is not null;
 if v_email is null then raise exception 'case unavailable'; end if;
 perform 1 from public.crm_commercial_advisors where user_id=p_actor for update;
 perform 1 from public.crm_conversations where id=p_case for update;
 select assigned_user_id into v_assigned from public.crm_commercial_form_cases where conversation_id=p_case and progress_state<>'cerrado' for update;
 if v_assigned is null or not public.crm_commercial_form_is_allowed(p_case) or not public.crm_commercial_team_case_allowed(p_actor,p_superadmin,v_assigned) then raise exception 'case unavailable'; end if;
 if exists(select 1 from public.crm_replies where conversation_id=p_case and status='pending' and id<>p_reply_id) or exists(select 1 from public.crm_commercial_form_send_attempts where conversation_id=p_case and status in ('reserved','dispatching','uncertain') and reply_id<>p_reply_id) then return jsonb_build_object('blocked',true); end if;
 insert into public.crm_replies(id,conversation_id,body,operador,status) values(p_reply_id,p_case,btrim(p_body),v_email,'pending') on conflict(id) do nothing returning * into v_reply;
 v_created:=found;
 if not v_created then
  select * into v_reply from public.crm_replies where id=p_reply_id;
  if v_reply.conversation_id<>p_case or v_reply.operador<>v_email or v_reply.body<>btrim(p_body)
     or not exists(select 1 from public.crm_commercial_form_send_attempts where reply_id=p_reply_id and actor_id=p_actor and conversation_id=p_case) then raise exception 'reply conflict'; end if;
 else
  insert into public.crm_commercial_form_send_attempts(reply_id,conversation_id,actor_id,status) values(p_reply_id,p_case,p_actor,'reserved');
 end if;
 return jsonb_build_object('created',v_created,'reply',to_jsonb(v_reply));
end $function$;
ALTER TABLE public.crm_replies DROP CONSTRAINT crm_replies_body_check;
ALTER TABLE public.crm_replies ADD CONSTRAINT crm_replies_body_check CHECK(length(trim(body)) BETWEEN 1 AND 4096);
ALTER TABLE public.crm_replies DROP CONSTRAINT crm_replies_long_email_channel_fk;
DROP TRIGGER crm_reply_long_email_marker ON public.crm_replies;
DROP FUNCTION public.crm_reply_long_email_marker();
ALTER TABLE public.crm_replies DROP CONSTRAINT crm_replies_long_email_marker_check;
ALTER TABLE public.crm_replies DROP COLUMN long_email_channel;
ALTER TABLE public.crm_conversations DROP CONSTRAINT crm_conversations_id_channel_key;
COMMIT;
