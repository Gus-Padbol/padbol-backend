-- Durable opt-in welcome delivery; service-role only. Runtime remains gated.
create table if not exists public.crm_welcome_dispatch_candidate (
  conversation_id uuid primary key references public.crm_conversations(id),
  status text not null check(status in ('claimed','accepted','unknown','suppressed')),
  consent_version text not null,
  consent_phone text not null,
  language text not null check(language in ('es','en')),
  provider_message_id text,
  revocation_requested_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.crm_welcome_dispatch_candidate enable row level security;
revoke all on public.crm_welcome_dispatch_candidate from public, anon, authenticated;
grant select, insert, update on public.crm_welcome_dispatch_candidate to service_role;

create or replace function public.crm_claim_welcome_candidate(p_conversation uuid, p_phone text, p_consent_version text)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare c public.crm_conversations%rowtype; v jsonb; added uuid;
begin
  select * into c from public.crm_conversations where id=p_conversation for update;
  if not found or c.source_channel <> 'email' or c.test_hidden_at is not null or not public.crm_commercial_form_is_allowed(c.id) or coalesce(c.qualification_data->'routing'->>'workflow','commercial_lead') <> 'commercial_lead' then return jsonb_build_object('status','ineligible'); end if;
  v:=c.qualification_data->'whatsapp_contact_consent';
  if v->>'accepted' is distinct from 'true' or v->>'version' is distinct from 'contacto-whatsapp-consulta-v1'
     or v->>'purpose' is distinct from 'consultation_followup' or v->>'phone' is distinct from p_phone or v->>'version' is distinct from p_consent_version or coalesce(v->>'language','') not in ('es','en')
     or coalesce(v->>'phone','') !~ '^\+[1-9][0-9]{7,14}$' or coalesce(v->>'acceptedAt','') = '' then
    return jsonb_build_object('status','ineligible');
  end if;
  insert into public.crm_welcome_dispatch_candidate(conversation_id,status,consent_version,consent_phone,language)
   values(c.id,'claimed',v->>'version',v->>'phone',v->>'language') on conflict do nothing returning conversation_id into added;
  if added is null then return jsonb_build_object('status','already_claimed'); end if;
  return jsonb_build_object('status','claimed','conversation_id',added,'phone',v->>'phone','language',v->>'language');
end $$;
revoke all on function public.crm_claim_welcome_candidate(uuid,text,text) from public,anon,authenticated;
grant execute on function public.crm_claim_welcome_candidate(uuid,text,text) to service_role;

create or replace function public.crm_revoke_welcome_candidate(p_conversation uuid)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare c public.crm_conversations%rowtype; v jsonb;
begin
  select * into c from public.crm_conversations where id=p_conversation for update;
  if not found then return jsonb_build_object('status','not_found'); end if;
  v:=c.qualification_data->'whatsapp_contact_consent';
  if v is null then return jsonb_build_object('status','no_consent'); end if;
  v:=jsonb_set(jsonb_set(v,'{accepted}','false'::jsonb,true),'{revokedAt}',to_jsonb(now()),true);
  update public.crm_conversations set qualification_data=jsonb_set(qualification_data,'{whatsapp_contact_consent}',v,true) where id=p_conversation;
  update public.crm_welcome_dispatch_candidate set revocation_requested_at=now(),updated_at=now() where conversation_id=p_conversation;
  return jsonb_build_object('status','revoked');
end $$;
revoke all on function public.crm_revoke_welcome_candidate(uuid) from public,anon,authenticated;
grant execute on function public.crm_revoke_welcome_candidate(uuid) to service_role;

-- Durable discovery: works again after a crash before the reservation.
create or replace function public.crm_list_welcome_pending_candidate(p_limit integer default 20,p_since timestamptz default null)
returns table(conversation_id uuid) language sql security definer set search_path=public,pg_temp as $$
 select c.id from public.crm_conversations c
 where p_since is not null and c.created_at >= p_since and c.test_hidden_at is null
 and c.source_channel='email'
 and public.crm_commercial_form_is_allowed(c.id)
 and coalesce(c.qualification_data->'routing'->>'workflow','commercial_lead')='commercial_lead'
 and c.qualification_data->'whatsapp_contact_consent'->>'revokedAt' is null
 and c.qualification_data->'whatsapp_contact_consent'->>'accepted'='true'
 and c.qualification_data->'whatsapp_contact_consent'->>'version'='contacto-whatsapp-consulta-v1'
 and c.qualification_data->'whatsapp_contact_consent'->>'purpose'='consultation_followup'
 and c.qualification_data->'whatsapp_contact_consent'->>'language' in ('es','en')
 and c.qualification_data->'whatsapp_contact_consent'->>'phone' ~ '^\+[1-9][0-9]{7,14}$'
 and exists(select 1 from public.crm_contacts ct where ct.id=c.contact_id and length(trim(coalesce(ct.nombre,'')))>0)
 and not exists(select 1 from public.crm_welcome_dispatch_candidate d where d.conversation_id=c.id)
 order by c.id limit greatest(1,least(coalesce(p_limit,20),100));
$$;
revoke all on function public.crm_list_welcome_pending_candidate(integer,timestamptz) from public,anon,authenticated;
grant execute on function public.crm_list_welcome_pending_candidate(integer,timestamptz) to service_role;

-- Candidate only: a link associates two existing records, never merges them.
create table if not exists public.crm_welcome_links_candidate(
 whatsapp_conversation_id uuid primary key references public.crm_conversations(id),
 lead_conversation_id uuid not null references public.crm_conversations(id),
 created_at timestamptz not null default now()
);
alter table public.crm_welcome_links_candidate enable row level security;
revoke all on public.crm_welcome_links_candidate from public,anon,authenticated;
grant select,insert on public.crm_welcome_links_candidate to service_role;
create or replace function public.crm_link_welcome_inbound_candidate(p_whatsapp uuid,p_phone text)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare incoming public.crm_conversations%rowtype; match_count integer; lead_id uuid; existing uuid;
begin
 select * into incoming from public.crm_conversations where id=p_whatsapp for update;
 if not found or incoming.source_channel<>'whatsapp' or p_phone !~ '^\+[1-9][0-9]{7,14}$' or regexp_replace(coalesce(incoming.identity_used,''),'[^0-9]','','g')<>substring(p_phone from 2) then
  return jsonb_build_object('status','ineligible');
 end if;
 select count(*),min(c.id::text)::uuid into match_count,lead_id
 from public.crm_conversations c join public.crm_welcome_dispatch_candidate d on d.conversation_id=c.id
 where d.consent_phone=p_phone and d.status='accepted' and d.revocation_requested_at is null
 and public.crm_commercial_form_is_allowed(c.id) and c.source_channel='email' and c.test_hidden_at is null and incoming.test_hidden_at is null and coalesce(c.estado,'')<>'cerrado'
 and c.qualification_data->'whatsapp_contact_consent'->>'accepted'='true'
 and c.qualification_data->'whatsapp_contact_consent'->>'phone'=p_phone;
 if match_count=0 then return jsonb_build_object('status','no_match');end if;
 if match_count>1 then return jsonb_build_object('status','ambiguous');end if;
 select lead_conversation_id into existing from public.crm_welcome_links_candidate where whatsapp_conversation_id=p_whatsapp;
 if existing is not null then
  if existing<>lead_id then return jsonb_build_object('status','ambiguous');end if;
  return jsonb_build_object('status','already_linked','lead_conversation_id',existing,'language',(select qualification_data->'whatsapp_contact_consent'->>'language' from public.crm_conversations where id=existing));
 end if;
 insert into public.crm_welcome_links_candidate(whatsapp_conversation_id,lead_conversation_id) values(p_whatsapp,lead_id);
 return jsonb_build_object('status','linked','lead_conversation_id',lead_id,'language',(select qualification_data->'whatsapp_contact_consent'->>'language' from public.crm_conversations where id=lead_id));
end $$;
revoke all on function public.crm_link_welcome_inbound_candidate(uuid,text) from public,anon,authenticated;
grant execute on function public.crm_link_welcome_inbound_candidate(uuid,text) to service_role;

-- Candidate: require an actually persisted provider event from the Padbol
-- production WhatsApp channel before correlating it with a welcome.
create or replace function public.crm_link_welcome_verified_inbound_candidate(p_whatsapp uuid,p_phone text,p_provider_id text)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
begin
 if p_provider_id is null or length(p_provider_id)=0 or length(p_provider_id)>512 or not exists (
  select 1 from public.crm_inbound_events e join public.crm_conversations c on c.id=e.conversation_id
  where e.conversation_id=p_whatsapp and e.source_channel='whatsapp'
   and e.origin='whatsapp:1376102838911694' and e.source_ref=p_provider_id
   and c.source_channel='whatsapp' and c.origin=e.origin
   and c.identity_used=substring(p_phone from 2)
 ) then return jsonb_build_object('status','unverified_event'); end if;
 return public.crm_link_welcome_inbound_candidate(p_whatsapp,p_phone);
end $$;
revoke all on function public.crm_link_welcome_verified_inbound_candidate(uuid,text,text) from public,anon,authenticated;
grant execute on function public.crm_link_welcome_verified_inbound_candidate(uuid,text,text) to service_role;
