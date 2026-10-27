-- Candidate only. Requires commercial team, case membership and reply claim foundations.
begin;
create function public.crm_commercial_team_claim_reply(p_case_id uuid,p_actor uuid,p_superadmin boolean,p_reply_id uuid,p_body text)
returns jsonb language plpgsql set search_path=pg_catalog,public as $$
declare v_conversation uuid; v_case public.crm_commercial_cases%rowtype; v_result jsonb; v_operator text;
begin
 if p_actor is null or p_reply_id is null or length(trim(coalesce(p_body,''))) not between 1 and 4096 then raise exception 'invalid commercial reply'; end if;
 select lower(email) into v_operator from auth.users where id=p_actor and email_confirmed_at is not null;
 if v_operator is null then raise exception 'case unavailable'; end if;
 -- Advisor first matches assignment and disable ordering; managers need no membership lock.
 perform 1 from public.crm_commercial_advisors where user_id=p_actor for update;
 select conversation_id into v_conversation from public.crm_commercial_cases where id=p_case_id;
 if v_conversation is null then raise exception 'case unavailable'; end if;
 -- Same lock order as menu and ingress: conversation, then case.
 perform 1 from public.crm_conversations where id=v_conversation for update;
 select * into v_case from public.crm_commercial_cases where id=p_case_id for update;
 if not found or v_case.conversation_id<>v_conversation or v_case.status<>'open'
    or not public.crm_commercial_team_case_allowed(p_actor,p_superadmin,v_case.assigned_user_id)
    or not exists(select 1 from public.crm_conversations where id=v_conversation and source_channel='whatsapp' and origin='whatsapp:1376102838911694') then raise exception 'case unavailable'; end if;
 v_result:=public.crm_claim_whatsapp_reply(p_reply_id,v_conversation,p_body,v_operator);
 if coalesce((v_result->>'blocked')::boolean,false) then return v_result; end if;
 if (v_result#>>'{reply,id}')::uuid is distinct from p_reply_id then raise exception 'claim mismatch'; end if;
 if not coalesce((v_result->>'created')::boolean,false) then
   if not exists(select 1 from public.crm_commercial_case_replies where case_id=p_case_id and reply_id=p_reply_id)
      or v_result#>>'{reply,body}'<>p_body or v_result#>>'{reply,operador}'<>v_operator then
     raise exception 'reply already claimed elsewhere';
   end if;
 else
   insert into public.crm_commercial_case_replies(case_id,conversation_id,reply_id) values(p_case_id,v_conversation,p_reply_id);
   insert into public.crm_commercial_case_send_attempts(reply_id,case_id) values(p_reply_id,p_case_id);
 end if;
 return v_result;
end $$;
revoke all on function public.crm_commercial_team_claim_reply(uuid,uuid,boolean,uuid,text) from public,anon,authenticated;
grant execute on function public.crm_commercial_team_claim_reply(uuid,uuid,boolean,uuid,text) to service_role;
commit;
