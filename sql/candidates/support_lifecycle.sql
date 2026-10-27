-- Candidato interno; aplicar SOLO después de crm_support_preparation.sql.
-- No modifica CRM, mensajes, gates ni outbox de WhatsApp. Efectos son borradores internos.
begin;
create table if not exists public.crm_support_lifecycle_actions (
 id bigserial primary key,
 case_id bigint not null references public.crm_support_cases(id),
 action_key text not null,
 command_hash text not null check(command_hash ~ '^[0-9a-f]{64}$'),
 actor_id uuid not null,
 action text not null,
 payload jsonb not null,
 result jsonb not null,
 created_at timestamptz not null default now(),
 unique(case_id,action_key)
);
create table if not exists public.crm_support_lifecycle_effects (
 id bigserial primary key,
 case_id bigint not null references public.crm_support_cases(id),
 action_id bigint not null references public.crm_support_lifecycle_actions(id),
 effect_key text not null,
 effect_type text not null check(effect_type in('technical_delegation','acknowledgement_draft','response_draft')),
 payload jsonb not null,
 disposition text not null default 'draft_only' check(disposition='draft_only'),
 created_at timestamptz not null default now(),
 unique(case_id,effect_key)
);
alter table public.crm_support_lifecycle_actions enable row level security;
alter table public.crm_support_lifecycle_effects enable row level security;
revoke all on public.crm_support_lifecycle_actions,public.crm_support_lifecycle_effects from public,anon,authenticated;
grant select on public.crm_support_lifecycle_actions,public.crm_support_lifecycle_effects to service_role;
create or replace function public.crm_support_apply_lifecycle(
 p_case_id bigint,p_action_key text,p_command_hash text,p_expected_version integer,p_actor_id uuid,
 p_action text,p_next_state text,p_payload jsonb,p_effects jsonb
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare c public.crm_support_cases%rowtype; old public.crm_support_lifecycle_actions%rowtype; a bigint; e jsonb; result jsonb; out_effects jsonb:='[]'::jsonb;
begin
 if p_actor_id is null or p_action_key is null or length(p_action_key)>160 or (p_command_hash is null or p_command_hash !~ '^[0-9a-f]{64}$') or jsonb_typeof(p_payload) is distinct from 'object' or jsonb_typeof(p_effects) is distinct from 'array' or jsonb_array_length(p_effects)>3 then raise exception 'SUPPORT_LIFECYCLE_INVALID';end if;
 select * into c from public.crm_support_cases where id=p_case_id for update;
 if not found then raise exception 'SUPPORT_CASE_NOT_DURABLE';end if;
 select * into old from public.crm_support_lifecycle_actions where case_id=c.id and action_key=p_action_key;
 if found then
  if old.command_hash<>p_command_hash then raise exception 'SUPPORT_ACTION_KEY_CONFLICT';end if;
  return jsonb_build_object('case',to_jsonb(c),'duplicate',true,'effects','[]'::jsonb);
 end if;
 if c.version is distinct from p_expected_version then raise exception 'SUPPORT_VERSION_CONFLICT';end if;
 if p_action='prepare' then
  if c.lifecycle_state<>'received' or p_next_state<>'technical_pending' then raise exception 'SUPPORT_TRANSITION_INVALID';end if;
  if not exists(select 1 from public.crm_support_preparation_jobs j join public.crm_inbound_events e on e.id=j.event_id join public.crm_conversations cc on cc.id=j.conversation_id where j.event_id::text=p_payload->>'source_event_id' and j.conversation_id=c.conversation_id and e.conversation_id=c.conversation_id and e.source_channel=c.source_channel and e.origin=cc.origin) then raise exception 'SUPPORT_EVENT_MISMATCH';end if;
 elsif p_action='technical_start' then
  if c.lifecycle_state<>'technical_pending' or p_next_state<>'technical_review' then raise exception 'SUPPORT_TRANSITION_INVALID';end if;
 elsif p_action='technical_proposal' then
  if c.lifecycle_state<>'technical_review' or p_next_state<>'coordination_review' or c.lifecycle_data->>'technical_actor_id' is distinct from p_actor_id::text then raise exception 'SUPPORT_TRANSITION_INVALID';end if;
 elsif p_action='coordination_approve' then
  if c.lifecycle_state<>'coordination_review' or p_next_state<>'response_draft_ready' or coalesce(c.lifecycle_data->>'proposal_actor_id','') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' or c.lifecycle_data->>'proposal_actor_id' is not distinct from p_actor_id::text or c.lifecycle_data->>'delivery_review_required'='true' or c.lifecycle_data#>>'{proposal,verification,status}' is distinct from 'passed' or p_payload->>'evidence_verified' is distinct from 'true' or jsonb_typeof(c.lifecycle_data#>'{proposal,evidence}') is distinct from 'array' or coalesce(jsonb_array_length(c.lifecycle_data#>'{proposal,evidence}'),0)<1 or jsonb_typeof(c.lifecycle_data#>'{proposal,verification,evidence}') is distinct from 'array' or coalesce(jsonb_array_length(c.lifecycle_data#>'{proposal,verification,evidence}'),0)<1 then raise exception 'SUPPORT_REVIEW_REQUIRED';end if;
 elsif p_action='coordination_reject' then
  if c.lifecycle_state<>'coordination_review' or p_next_state<>'technical_pending' then raise exception 'SUPPORT_TRANSITION_INVALID';end if;
 elsif p_action='delivery_review' then
  if c.lifecycle_data->>'delivery_review_required' is distinct from 'true' or p_next_state is distinct from c.lifecycle_state or p_payload->>'delivery_evidence_verified' is distinct from 'true' then raise exception 'SUPPORT_TRANSITION_INVALID';end if;
 else raise exception 'SUPPORT_TRANSITION_INVALID';
 end if;
 if p_payload->>'resolved'='true' or p_next_state not in('technical_pending','technical_review','coordination_review','response_draft_ready') then raise exception 'SUPPORT_AUTOCLOSE_FORBIDDEN';end if;
 for e in select value from jsonb_array_elements(p_effects) loop
  if e->>'type' not in('technical_delegation','acknowledgement_draft','response_draft') or coalesce(e->>'key','')='' or length(e->>'key')>180 or jsonb_typeof(e->'payload') is distinct from 'object' or e#>>'{payload,conversation_id}' is distinct from c.conversation_id::text or e#>>'{payload,channel}' is distinct from c.source_channel or e#>>'{payload,case_reference}' is distinct from c.public_reference or e#>>'{payload,send_enabled}' is distinct from 'false' then raise exception 'SUPPORT_EFFECT_INVALID';end if;
  if c.source_channel='whatsapp' and e->>'type'='acknowledgement_draft' then raise exception 'SUPPORT_EXISTING_ACK_ONLY';end if;
  if e->>'type'='response_draft' and (p_action<>'coordination_approve' or p_next_state<>'response_draft_ready') then raise exception 'SUPPORT_REVIEW_REQUIRED';end if;
 end loop;
 update public.crm_support_cases set lifecycle_state=p_next_state,lifecycle_data=lifecycle_data||p_payload||jsonb_build_object('resolved',false),version=version+1,updated_at=now() where id=c.id returning * into c;
 result:=jsonb_build_object('case',to_jsonb(c),'duplicate',false,'effects',p_effects);
 insert into public.crm_support_lifecycle_actions(case_id,action_key,command_hash,actor_id,action,payload,result) values(c.id,p_action_key,p_command_hash,p_actor_id,p_action,p_payload,result) returning id into a;
 for e in select value from jsonb_array_elements(p_effects) loop
  insert into public.crm_support_lifecycle_effects(case_id,action_id,effect_key,effect_type,payload) values(c.id,a,e->>'key',e->>'type',e->'payload');
 end loop;
 return result;
end;
$$;
revoke all on function public.crm_support_apply_lifecycle(bigint,text,text,integer,uuid,text,text,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.crm_support_apply_lifecycle(bigint,text,text,integer,uuid,text,text,jsonb,jsonb) to service_role;
commit;
