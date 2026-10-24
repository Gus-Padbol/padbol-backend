-- Candidate only; service-role callers must authenticate and bind p_actor to
-- the verified session. This claims and records a reply, but does not send it.
-- A sender must serialize against inbound ingestion until the provider call is
-- complete and must preserve the existing idempotency and uncertain-send rules.
begin;
create table public.crm_commercial_case_send_attempts (
 reply_id uuid primary key references public.crm_replies(id) on delete restrict,
 case_id uuid not null references public.crm_commercial_cases(id) on delete restrict,
 status text not null default 'reserved' check (status in ('reserved','dispatching','sent','cancelled','uncertain'))
);
alter table public.crm_commercial_case_send_attempts enable row level security;
revoke all on public.crm_commercial_case_send_attempts from public,anon,authenticated;
grant all on public.crm_commercial_case_send_attempts to service_role;
create function public.crm_commercial_case_claim_reply(p_case_id uuid,p_actor uuid,p_reply_id uuid,p_body text,p_operator text)
returns jsonb language plpgsql set search_path=pg_catalog,public as $$
declare v_conversation uuid; v_case public.crm_commercial_cases%rowtype; v_result jsonb;
begin
 if p_actor is null or p_reply_id is null or length(trim(coalesce(p_body,''))) not between 1 and 4096
    or lower(trim(coalesce(p_operator,''))) <> 'sm@padbol.com' then raise exception 'invalid commercial reply'; end if;
 select conversation_id into v_conversation from public.crm_commercial_cases where id=p_case_id;
 if v_conversation is null then raise exception 'case unavailable'; end if;
 -- Same lock order as menu and ingress: conversation, then case.
 perform 1 from public.crm_conversations where id=v_conversation for update;
 select * into v_case from public.crm_commercial_cases where id=p_case_id for update;
 if not found or v_case.conversation_id<>v_conversation or v_case.assigned_user_id<>p_actor or v_case.status<>'open'
    or p_actor<>'7225442b-defd-42c1-a5a2-b9c1c339fa69'::uuid then raise exception 'case unavailable'; end if;
 v_result:=public.crm_claim_whatsapp_reply(p_reply_id,v_conversation,p_body,lower(trim(p_operator)));
 if coalesce((v_result->>'blocked')::boolean,false) then return v_result; end if;
 if (v_result#>>'{reply,id}')::uuid is distinct from p_reply_id then raise exception 'claim mismatch'; end if;
 if not coalesce((v_result->>'created')::boolean,false) then
   if not exists(select 1 from public.crm_commercial_case_replies where case_id=p_case_id and reply_id=p_reply_id)
      or v_result#>>'{reply,body}'<>p_body or v_result#>>'{reply,operador}'<>lower(trim(p_operator)) then
     raise exception 'reply already claimed elsewhere';
   end if;
 else
   insert into public.crm_commercial_case_replies(case_id,conversation_id,reply_id) values(p_case_id,v_conversation,p_reply_id);
   insert into public.crm_commercial_case_send_attempts(reply_id,case_id) values(p_reply_id,p_case_id);
 end if;
 return v_result;
end $$;
revoke all on function public.crm_commercial_case_claim_reply(uuid,uuid,uuid,text,text) from public,anon,authenticated;
grant execute on function public.crm_commercial_case_claim_reply(uuid,uuid,uuid,text,text) to service_role;
commit;
