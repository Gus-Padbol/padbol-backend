-- Candidato interno, después de support_lifecycle.sql. Ningún principal queda habilitado por defecto.
begin;
create table if not exists public.crm_support_executor_principals(
 id uuid primary key default gen_random_uuid(),label text not null,
 token_sha256 text not null unique check(token_sha256~'^[0-9a-f]{64}$'),
 capability text not null default 'mini_prepare' check(capability='mini_prepare'),
 enabled boolean not null default false,created_at timestamptz not null default now()
);
create table if not exists public.crm_support_executor_jobs(
 id uuid primary key default gen_random_uuid(),effect_id bigint not null unique references public.crm_support_lifecycle_effects(id),
 case_id bigint not null references public.crm_support_cases(id),
 state text not null default 'pending' check(state in('pending','leased','completed','review')),
 principal_id uuid references public.crm_support_executor_principals(id),worker_instance_id uuid,
 claim_request_id uuid,lease_token uuid,lease_expires_at timestamptz,attempts integer not null default 0,
 next_attempt_at timestamptz not null default now(),last_error_code text,
 completion_id uuid,completion_hash text,result jsonb,created_at timestamptz not null default now(),updated_at timestamptz not null default now()
);
create table if not exists public.crm_support_executor_claim_receipts(principal_id uuid not null references crm_support_executor_principals(id),request_id uuid not null,job_id uuid references crm_support_executor_jobs(id),primary key(principal_id,request_id));
alter table public.crm_support_executor_claim_receipts enable row level security;
revoke all on public.crm_support_executor_claim_receipts from public,anon,authenticated,service_role;
create unique index if not exists crm_support_executor_claim_request on public.crm_support_executor_jobs(principal_id,claim_request_id) where claim_request_id is not null;
alter table public.crm_support_executor_principals enable row level security;
alter table public.crm_support_executor_jobs enable row level security;
revoke all on public.crm_support_executor_principals,public.crm_support_executor_jobs from public,anon,authenticated,service_role;
-- Only backend service role can read principals to authenticate. No public bootstrap endpoint.
grant select on public.crm_support_executor_principals,public.crm_support_executor_jobs to service_role;
create or replace function public.crm_support_executor_scope(p_case bigint,p_event text)returns boolean language sql stable security definer set search_path=public,pg_temp as $$
select exists(select 1 from crm_support_cases k join crm_conversations c on c.id=k.conversation_id join crm_inbound_events e on e.conversation_id=c.id and e.id::text=p_event
where k.id=p_case and k.source_channel=c.source_channel and e.source_channel=c.source_channel and e.origin=c.origin and k.public_reference='PB-'||c.ticket_number
and ((c.source_channel='email' and c.origin='support_email' and c.qualification_data#>>'{mailbox,address}'='support@padbol.com')
or(c.source_channel='whatsapp' and exists(select 1 from crm_support_event_context x where x.event_id=e.id and x.conversation_id=c.id and x.origin=e.origin and x.tenant_id=k.tenant_id and x.channel_id=k.channel_id and x.confirmed and x.effective_topic='soporte'))));
$$;
revoke all on function public.crm_support_executor_scope(bigint,text)from public,anon,authenticated,service_role;
create or replace function public.crm_support_executor_claim(p_principal uuid,p_request uuid,p_worker uuid,p_seconds integer default 120)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare j public.crm_support_executor_jobs%rowtype;c public.crm_support_cases%rowtype; effect public.crm_support_lifecycle_effects%rowtype;r jsonb;body text;
begin
 if p_request is null or p_worker is null or (p_seconds is null or p_seconds not between 30 and 180) or not exists(select 1 from crm_support_executor_principals where id=p_principal and enabled and capability='mini_prepare') then raise exception 'SUPPORT_EXECUTOR_FORBIDDEN';end if;
 perform pg_advisory_xact_lock(hashtextextended(p_principal::text||p_request::text,0));
 -- A repeated HTTP claim request returns the same unexpired lease, never another job.
 if exists(select 1 from crm_support_executor_claim_receipts where principal_id=p_principal and request_id=p_request and job_id is null)then return jsonb_build_object('job',null,'repeated',true);end if;
 select q.* into j from crm_support_executor_jobs q join crm_support_executor_claim_receipts x on x.job_id=q.id where x.principal_id=p_principal and x.request_id=p_request for update of q;
 if found then
  if j.state='leased' and j.lease_expires_at>now() and j.claim_request_id=p_request then
   select * into c from crm_support_cases where id=j.case_id;select * into effect from crm_support_lifecycle_effects where id=j.effect_id;
   if not crm_support_executor_scope(c.id,coalesce(effect.payload->>'event_id',c.source_event_id::text)) then raise exception 'SUPPORT_EXECUTOR_CASE_SCOPE';end if;
   select e.body into body from crm_inbound_events e where e.id::text=coalesce(effect.payload->>'event_id',c.source_event_id::text) and e.conversation_id=c.conversation_id;
   return jsonb_build_object('jobId',j.id,'caseId',c.id,'caseReference',c.public_reference,'sourceEventId',coalesce(effect.payload->>'event_id',c.source_event_id::text),'channel',c.source_channel,'conversationId',c.conversation_id,'message',left(coalesce(body,''),4000),'leaseToken',j.lease_token,'leaseExpiresAt',j.lease_expires_at,'attempt',j.attempts,'mode','prepare','repeated',true);
  end if;
  return jsonb_build_object('job',null,'repeated',true,'state',j.state);
 end if;
 insert into crm_support_executor_jobs(effect_id,case_id)
 select e.id,e.case_id from crm_support_lifecycle_effects e join crm_support_cases k on k.id=e.case_id
 where crm_support_executor_scope(k.id,coalesce(e.payload->>'event_id',k.source_event_id::text)) and e.effect_type='technical_delegation' and e.disposition='draft_only' and k.lifecycle_state in('technical_pending','technical_review')
 on conflict(effect_id)do nothing;
 update crm_support_executor_jobs set state='review',last_error_code='LEASE_ATTEMPTS_EXHAUSTED',updated_at=now() where state='leased' and lease_expires_at<=now() and attempts>=3;
 select q.* into j from crm_support_executor_jobs q join crm_support_cases k on k.id=q.case_id
 where ((q.state='pending' and q.next_attempt_at<=now()) or (q.state='leased' and q.lease_expires_at<=now())) and q.attempts<3
 and exists(select 1 from crm_support_lifecycle_effects e where e.id=q.effect_id and crm_support_executor_scope(k.id,coalesce(e.payload->>'event_id',k.source_event_id::text)))
 and (k.lifecycle_state='technical_pending' or (k.lifecycle_state='technical_review' and k.lifecycle_data->>'technical_actor_id'=p_principal::text))
 order by q.created_at,q.id for update of q skip locked limit 1;
 if not found then insert into crm_support_executor_claim_receipts values(p_principal,p_request,null);return jsonb_build_object('job',null);end if;
 select * into c from crm_support_cases where id=j.case_id for update;
 if c.lifecycle_state='technical_pending' then
  r:=crm_support_apply_lifecycle(c.id,'executor-start:'||j.id,repeat('0',64),c.version,p_principal,'technical_start','technical_review',jsonb_build_object('technical_actor_id',p_principal,'actor_kind','service_principal'),'[]'::jsonb);
 elsif c.lifecycle_state<>'technical_review' or c.lifecycle_data->>'technical_actor_id' is distinct from p_principal::text then raise exception 'SUPPORT_EXECUTOR_CASE_STATE';end if;
 update crm_support_executor_jobs set state='leased',principal_id=p_principal,worker_instance_id=p_worker,claim_request_id=p_request,lease_token=gen_random_uuid(),lease_expires_at=now()+make_interval(secs=>p_seconds),attempts=attempts+1,updated_at=now() where id=j.id returning * into j;
 insert into crm_support_executor_claim_receipts values(p_principal,p_request,j.id);
 select * into effect from crm_support_lifecycle_effects where id=j.effect_id;
 select e.body into body from crm_inbound_events e where e.id::text=coalesce(effect.payload->>'event_id',c.source_event_id::text) and e.conversation_id=c.conversation_id;
 return jsonb_build_object('jobId',j.id,'caseId',c.id,'caseReference',c.public_reference,'sourceEventId',coalesce(effect.payload->>'event_id',c.source_event_id::text),'channel',c.source_channel,'conversationId',c.conversation_id,'message',left(coalesce(body,''),4000),'leaseToken',j.lease_token,'leaseExpiresAt',j.lease_expires_at,'attempt',j.attempts,'mode','prepare');
end;$$;
create or replace function public.crm_support_executor_complete(p_principal uuid,p_job uuid,p_lease uuid,p_completion uuid,p_hash text,p_proposal jsonb)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare j public.crm_support_executor_jobs%rowtype;c public.crm_support_cases%rowtype;r jsonb;proposal jsonb;source_event text;
begin
 if not exists(select 1 from crm_support_executor_principals where id=p_principal and enabled and capability='mini_prepare') then raise exception 'SUPPORT_EXECUTOR_FORBIDDEN';end if;
 select * into j from crm_support_executor_jobs where id=p_job for update;
 if not found or j.principal_id is distinct from p_principal or j.lease_token is distinct from p_lease or p_completion is null then raise exception 'SUPPORT_EXECUTOR_LEASE_INVALID';end if;
 if j.state='completed' then
  if j.completion_id is distinct from p_completion or j.completion_hash is distinct from p_hash then raise exception 'SUPPORT_EXECUTOR_COMPLETION_CONFLICT';end if;
  return j.result||jsonb_build_object('duplicate',true);
 end if;
 if j.state<>'leased' or j.lease_expires_at<=now() then raise exception 'SUPPORT_EXECUTOR_LEASE_EXPIRED';end if;
 if p_hash is null or p_hash!~'^[0-9a-f]{64}$' or jsonb_typeof(p_proposal) is distinct from 'object' or coalesce(length(p_proposal->>'summary'),0) not between 1 and 2000 or coalesce(length(p_proposal->>'reply'),0) not between 1 and 2000 or jsonb_typeof(p_proposal->'steps') is distinct from 'array' or jsonb_array_length(p_proposal->'steps')>10 or coalesce(length(p_proposal->>'diagnosis'),0) not between 1 and 2000 then raise exception 'SUPPORT_EXECUTOR_PROPOSAL_INVALID';end if;
 select * into c from crm_support_cases where id=j.case_id for update;
 select coalesce(payload->>'event_id',c.source_event_id::text) into source_event from crm_support_lifecycle_effects where id=j.effect_id;
 if not crm_support_executor_scope(c.id,source_event) then raise exception 'SUPPORT_EXECUTOR_CASE_SCOPE';end if;
 if c.lifecycle_state<>'technical_review' or c.lifecycle_data->>'technical_actor_id' is distinct from p_principal::text then raise exception 'SUPPORT_EXECUTOR_CASE_STATE';end if;
 -- The model never supplies verification or approval. Evidence is only a source event, not a passed test.
 proposal:=jsonb_build_object('summary',p_proposal->>'summary','reply',p_proposal->>'reply','diagnosis',p_proposal->>'diagnosis','steps',p_proposal->'steps','evidence',jsonb_build_array(jsonb_build_object('kind','source_event','reference','crm-event:'||source_event)),'verification',jsonb_build_object('status','not_run','evidence',jsonb_build_array(jsonb_build_object('kind','source_event','reference','crm-event:'||source_event))));
 r:=crm_support_apply_lifecycle(c.id,'executor-proposal:'||j.id,p_hash,c.version,p_principal,'technical_proposal','coordination_review',jsonb_build_object('proposal',proposal,'proposal_request_id',p_completion,'proposal_actor_id',p_principal,'actor_kind','service_principal','resolved',false),'[]'::jsonb);
 r:=jsonb_build_object('jobId',j.id,'caseId',c.id,'state','coordination_review','mode','prepare','sendEnabled',false,'verification','not_run','duplicate',false);
 update crm_support_executor_jobs set state='completed',completion_id=p_completion,completion_hash=p_hash,result=r,updated_at=now() where id=j.id;
 return r;
end;$$;
create or replace function public.crm_support_executor_fail(p_principal uuid,p_job uuid,p_lease uuid,p_error text)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare j public.crm_support_executor_jobs%rowtype;
begin
 if not exists(select 1 from crm_support_executor_principals where id=p_principal and enabled) then raise exception 'SUPPORT_EXECUTOR_FORBIDDEN';end if;
 if p_error is null or p_error not in('MODEL_UNAVAILABLE','MODEL_OUTPUT_INVALID','LOCAL_PREPARATION_FAILED') then raise exception 'SUPPORT_EXECUTOR_ERROR_INVALID';end if;
 select * into j from crm_support_executor_jobs where id=p_job for update;
 if not found or j.principal_id is distinct from p_principal or j.lease_token is distinct from p_lease then raise exception 'SUPPORT_EXECUTOR_LEASE_INVALID';end if;
 if j.state='completed' then return jsonb_build_object('state','completed');end if;
 if j.state<>'leased' or j.lease_expires_at<=now() then raise exception 'SUPPORT_EXECUTOR_LEASE_EXPIRED';end if;
 update crm_support_executor_jobs set state=case when attempts>=3 or p_error='MODEL_OUTPUT_INVALID' then 'review' else 'pending' end,next_attempt_at=now()+make_interval(secs=>least(300,15*attempts)),last_error_code=p_error,updated_at=now() where id=j.id returning * into j;
 return jsonb_build_object('state',j.state,'retryAt',j.next_attempt_at,'sendEnabled',false);
end;$$;
revoke all on function public.crm_support_executor_claim(uuid,uuid,uuid,integer),public.crm_support_executor_complete(uuid,uuid,uuid,uuid,text,jsonb),public.crm_support_executor_fail(uuid,uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.crm_support_executor_claim(uuid,uuid,uuid,integer),public.crm_support_executor_complete(uuid,uuid,uuid,uuid,text,jsonb),public.crm_support_executor_fail(uuid,uuid,uuid,text) to service_role;
commit;
