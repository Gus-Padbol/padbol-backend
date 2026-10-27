-- Private QA-only one-time permit. Apply only to independent QA after review.
-- No rows, principals, recipients or outbound flags are seeded.
begin;
create table public.crm_support_qa_canary_permits (
 singleton boolean primary key default true check(singleton),
 effect_id bigint not null unique references public.crm_support_lifecycle_effects(id),
 principal_id uuid not null references public.crm_support_delivery_principals(id),
 authorized_recipient text not null check(authorized_recipient ~ '^[1-9][0-9]{7,14}$'),
 reserved_at timestamptz not null default clock_timestamp()
);
alter table public.crm_support_qa_canary_permits enable row level security;
revoke all on public.crm_support_qa_canary_permits from public,anon,authenticated,service_role;
create function public.crm_support_reserve_qa_canary(p_effect_id bigint,p_principal_id uuid,p_recipient text)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare p public.crm_support_delivery_principals%rowtype;c public.crm_support_cases%rowtype;e public.crm_support_lifecycle_effects%rowtype;v public.crm_conversations%rowtype;inserted boolean;
begin
 if p_effect_id is null or p_principal_id is null or p_recipient is null or p_recipient !~ '^[1-9][0-9]{7,14}$'then raise exception 'SUPPORT_QA_CANARY_INVALID';end if;
 select * into p from public.crm_support_delivery_principals where id=p_principal_id and active and capability='support.whatsapp.send'
  and tenant_id='3a2e5306-e1fc-4b24-b03b-fe965fc37e97' and channel_id='81bba438-eb65-4f70-bdf9-32f6c113d5bf'
  and organization_id='067d7269-27e3-4aaf-9da4-c80ba56e1d2a' and phone_number_id='1376102838911694'
  and waba_id='928900479733370' and origin='whatsapp:1376102838911694' and credential_ref='TEST';
 if not found then raise exception 'SUPPORT_QA_CANARY_PRINCIPAL_DENIED';end if;
 select * into e from public.crm_support_lifecycle_effects where id=p_effect_id and effect_type='response_draft' and disposition='draft_only';
 if not found then raise exception 'SUPPORT_QA_CANARY_APPROVAL_REQUIRED';end if;
 select * into c from public.crm_support_cases where id=e.case_id for update;
 select * into v from public.crm_conversations where id=c.conversation_id for update;
 if c.source_channel is distinct from 'whatsapp' or c.lifecycle_state is distinct from 'response_draft_ready' or c.tenant_id is distinct from p.tenant_id or c.channel_id is distinct from p.channel_id
  or v.origin is distinct from p.origin or regexp_replace(coalesce(v.identity_used,''),'[^0-9]','','g')is distinct from p_recipient
  or exists(select 1 from public.crm_support_delivery_journal where effect_id=p_effect_id)
  then raise exception 'SUPPORT_QA_CANARY_SCOPE_DENIED';end if;
 insert into public.crm_support_qa_canary_permits(singleton,effect_id,principal_id,authorized_recipient)values(true,p_effect_id,p_principal_id,p_recipient)on conflict do nothing;
 inserted:=FOUND;
 -- An existing or uncertain permit is never a fresh authorization to dispatch.
 return jsonb_build_object('reserved',inserted,'retryAllowed',false);
end$$;
revoke all on function public.crm_support_reserve_qa_canary(bigint,uuid,text)from public,anon,authenticated;
grant execute on function public.crm_support_reserve_qa_canary(bigint,uuid,text)to service_role;
commit;
