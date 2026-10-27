-- Explicit support delivery. Never create a menu_event/manual attempt.
-- Prerequisites: support_lifecycle.sql and immutable support event context.
begin;
do $$declare name text;begin
 foreach name in array array['crm_support_cases','crm_support_lifecycle_effects','crm_support_lifecycle_actions','crm_support_event_context','crm_inbound_events','crm_replies','crm_whatsapp_manual_attempts','crm_whatsapp_automation_releases','crm_whatsapp_menu_events','whatsapp_outbox','whatsapp_inbound_messages','whatsapp_tenants','whatsapp_tenant_channels']loop
  if to_regclass('public.'||name)is null then raise exception 'SUPPORT_DELIVERY_PREREQUISITE_MISSING: %',name;end if;
 end loop;
 foreach name in array array['test_visibility_version','identity_used','assigned_by','handoff_ready','derivado','qualification_data']loop
  if not exists(select 1 from information_schema.columns where table_schema='public' and table_name='crm_conversations' and column_name=name)then raise exception 'SUPPORT_DELIVERY_COLUMN_MISSING: crm_conversations.%',name;end if;
 end loop;
end$$;
create table public.crm_support_delivery_principals (
 id uuid primary key, active boolean not null default false,
 capability text not null check(capability='support.whatsapp.send'),
 tenant_id uuid not null,channel_id uuid not null,
 origin text not null check(origin like 'whatsapp:%'),organization_id uuid not null,
 phone_number_id text not null,waba_id text not null,credential_ref text not null
);
-- No principal is seeded. In particular mini_prepare has no delivery capability.
create table public.crm_support_delivery_journal (
 id bigserial primary key,effect_id bigint not null unique references public.crm_support_lifecycle_effects(id),
 case_id bigint not null references public.crm_support_cases(id),
 conversation_id uuid not null references public.crm_conversations(id),
 source_event_id uuid not null references public.crm_inbound_events(id),
 principal_id uuid not null references public.crm_support_delivery_principals(id),
 tenant_id uuid not null,channel_id uuid not null,menu_revision bigint not null,
 state text not null default 'claimed' check(state in('claimed','sent','uncertain')),
 reply_id uuid not null unique references public.crm_replies(id),
 provider_message_id text,attempts integer not null default 1 check(attempts=1),
 created_at timestamptz not null default now()
);
alter table public.crm_support_delivery_principals enable row level security;
alter table public.crm_support_delivery_journal enable row level security;
revoke all on public.crm_support_delivery_principals,public.crm_support_delivery_journal from public,anon,authenticated,service_role;
grant select on public.crm_support_delivery_principals,public.crm_support_delivery_journal to service_role;
grant update(state,provider_message_id)on public.crm_support_delivery_journal to service_role;
create function public.crm_support_prepare_whatsapp_delivery(p_effect_id bigint,p_principal_id uuid)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare e public.crm_support_lifecycle_effects%rowtype;a public.crm_support_lifecycle_actions%rowtype;
 c public.crm_support_cases%rowtype;v public.crm_conversations%rowtype;
 x public.crm_support_event_context%rowtype;p public.crm_support_delivery_principals%rowtype;
 incoming public.crm_inbound_events%rowtype;j public.crm_support_delivery_journal%rowtype;
 ch record;inbound record;reply uuid;
begin
 select * into p from public.crm_support_delivery_principals where id=p_principal_id and active and capability='support.whatsapp.send';
 if not found then raise exception 'SUPPORT_DELIVERY_PRINCIPAL_DENIED';end if;
 select * into e from public.crm_support_lifecycle_effects where id=p_effect_id and effect_type='response_draft' and disposition='draft_only';
 if not found then raise exception 'SUPPORT_APPROVED_RESPONSE_REQUIRED';end if;
 select * into c from public.crm_support_cases where id=e.case_id for update;
 select * into v from public.crm_conversations where id=c.conversation_id for update;
 select * into j from public.crm_support_delivery_journal where effect_id=e.id;
 if found then
  if j.principal_id is distinct from p.id then raise exception 'SUPPORT_DELIVERY_PRINCIPAL_CONFLICT';end if;
  return jsonb_build_object('journalId',j.id,'status',j.state,'sendEnabled',false,'duplicate',true);
 end if;
 select * into a from public.crm_support_lifecycle_actions where id=e.action_id and case_id=c.id;
 if c.source_channel is distinct from 'whatsapp' or c.lifecycle_state is distinct from 'response_draft_ready'
  or a.action is distinct from 'coordination_approve' or a.payload->>'evidence_verified' is distinct from 'true'
  or a.actor_id is null or c.lifecycle_data->>'proposal_actor_id' is null or a.actor_id::text is not distinct from c.lifecycle_data->>'proposal_actor_id'
  or c.lifecycle_data#>>'{proposal,verification,status}' is distinct from 'passed'
  or c.lifecycle_data->>'proposal_request_id' is null
  or a.payload->>'approved_proposal_request_id' is distinct from c.lifecycle_data->>'proposal_request_id'
  or e.effect_key is distinct from 'response:'||(c.lifecycle_data->>'proposal_request_id')
  or e.payload->>'body' is distinct from c.lifecycle_data#>>'{proposal,reply}'
  or e.payload->>'conversation_id' is distinct from c.conversation_id::text
  or e.payload->>'case_reference' is distinct from c.public_reference
  or e.payload->>'channel' is distinct from 'whatsapp' or e.payload->>'send_enabled' is distinct from 'false'
  or length(trim(coalesce(e.payload->>'body',''))) not between 1 and 4096 then raise exception 'SUPPORT_APPROVED_RESPONSE_REQUIRED';end if;
 select * into x from public.crm_support_event_context where event_id=c.source_event_id and conversation_id=c.conversation_id and confirmed and effective_topic='soporte';
 if not found or x.tenant_id is distinct from p.tenant_id or x.channel_id is distinct from p.channel_id
  or c.tenant_id is distinct from p.tenant_id or c.channel_id is distinct from p.channel_id
  or x.origin is distinct from p.origin or v.origin is distinct from p.origin
  or x.menu_revision is distinct from v.test_visibility_version then raise exception 'SUPPORT_DELIVERY_SCOPE_STALE';end if;
 select * into inbound from public.whatsapp_inbound_messages where id=x.menu_inbound_id and tenant_id=p.tenant_id and channel_id=p.channel_id;
 if not found or inbound.provider_message_id is distinct from x.source_ref
  or inbound.from_wa_id is distinct from regexp_replace(coalesce(v.identity_used,''),'[^0-9]','','g')
  or inbound.message_type is distinct from 'text' or inbound.meta_media_type is not null then raise exception 'SUPPORT_DELIVERY_INBOUND_MISMATCH';end if;
 select * into incoming from public.crm_inbound_events where conversation_id=c.conversation_id order by received_at desc,created_at desc,id desc limit 1;
 if incoming.id is distinct from c.source_event_id or incoming.origin is distinct from p.origin or incoming.source_channel is distinct from 'whatsapp'
  or incoming.received_at>now() or incoming.received_at<=now()-interval '24 hours' then raise exception 'SUPPORT_DELIVERY_WINDOW_OR_EVENT_STALE';end if;
 if c.lifecycle_data->>'delivery_review_required'='true'
  or v.qualification_data#>>'{whatsapp_order_review,required}'='true'
  or v.qualification_data#>>'{whatsapp_message_order_review,required}'='true'
  or coalesce(v.operador,'')<>'' or v.sede_id is not null or v.assigned_by is not null
  or v.derivado or v.handoff_ready or v.estado is distinct from 'nuevo' then raise exception 'SUPPORT_HUMAN_OR_REVIEW_REQUIRED';end if;
 select channels.*,tenants.status tenant_status,tenants.organization_id into ch from public.whatsapp_tenant_channels channels join public.whatsapp_tenants tenants on tenants.id=channels.tenant_id where channels.id=p.channel_id and channels.tenant_id=p.tenant_id;
 if not found or not ch.active or ch.tenant_status is distinct from 'active' or ch.organization_id is distinct from p.organization_id
  or ch.meta_phone_number_id is distinct from p.phone_number_id or ch.meta_waba_id is distinct from p.waba_id
  or ch.credential_ref is distinct from p.credential_ref or p.origin is distinct from 'whatsapp:'||p.phone_number_id then raise exception 'SUPPORT_CHANNEL_DENIED';end if;
 if exists(select 1 from public.crm_support_delivery_journal where conversation_id=c.conversation_id and state in('claimed','uncertain'))
  or exists(select 1 from public.crm_whatsapp_menu_events m join public.whatsapp_outbox o on o.id=m.outbox_id where m.conversation_id=c.conversation_id and (o.status in('pending','sending') or o.last_error='WHATSAPP_SEND_UNCERTAIN_NO_RETRY'))
  or exists(select 1 from public.crm_whatsapp_manual_attempts m join public.crm_replies r on r.id=m.reply_id where m.conversation_id=c.conversation_id and (r.status not in('sent','cancelled') or not exists(select 1 from public.crm_whatsapp_automation_releases ar where ar.conversation_id=c.conversation_id)))
  then raise exception 'SUPPORT_COMPETING_DELIVERY';end if;
 if not exists(select 1 from public.crm_whatsapp_menu_events m join public.whatsapp_outbox o on o.id=m.outbox_id where m.inbound_message_id=x.menu_inbound_id and m.conversation_id=c.conversation_id and o.status='sent')then raise exception 'SUPPORT_EXISTING_ACK_UNCONFIRMED';end if;
 reply:=gen_random_uuid();
 insert into public.crm_replies(id,conversation_id,body,operador,status)values(reply,c.conversation_id,e.payload->>'body','support_service:'||p.id::text,'pending');
 insert into public.crm_support_delivery_journal(effect_id,case_id,conversation_id,source_event_id,principal_id,tenant_id,channel_id,menu_revision,reply_id)
 values(e.id,c.id,c.conversation_id,c.source_event_id,p.id,p.tenant_id,p.channel_id,x.menu_revision,reply);
 select * into j from public.crm_support_delivery_journal where effect_id=e.id;
 return jsonb_build_object('journalId',j.id,'conversationId',c.conversation_id,'status',j.state,'duplicate',false,'sendEnabled',true,'channel',jsonb_build_object('id',p.channel_id,'meta_phone_number_id',p.phone_number_id,'credential_ref',p.credential_ref),'toWaId',regexp_replace(coalesce(v.identity_used,''),'[^0-9]','','g'),'body',e.payload->>'body','sourceEventId',c.source_event_id);
end$$;
revoke all on function public.crm_support_prepare_whatsapp_delivery(bigint,uuid)from public,anon,authenticated;
grant execute on function public.crm_support_prepare_whatsapp_delivery(bigint,uuid)to service_role;
create function public.crm_support_shared_delivery_guard()returns trigger
language plpgsql security definer set search_path=pg_catalog,public as $$
declare conv uuid;
begin
 if TG_TABLE_NAME='crm_whatsapp_manual_attempts' then conv:=NEW.conversation_id;
 else
  if NEW.status is distinct from 'sending' or OLD.status='sending' then return NEW;end if;
  select conversation_id into conv from public.crm_whatsapp_menu_events where outbox_id=NEW.id;
  if conv is null then return NEW;end if;
 end if;
 perform id from public.crm_conversations where id=conv for update;
 if exists(select 1 from public.crm_support_delivery_journal where conversation_id=conv and state in('claimed','uncertain'))then raise exception 'SUPPORT_DELIVERY_RESERVED';end if;
 return NEW;
end$$;
revoke all on function public.crm_support_shared_delivery_guard()from public,anon,authenticated,service_role;
create trigger support_guard_manual before insert on public.crm_whatsapp_manual_attempts for each row execute function public.crm_support_shared_delivery_guard();
create trigger support_guard_menu before update of status on public.whatsapp_outbox for each row execute function public.crm_support_shared_delivery_guard();
commit;
