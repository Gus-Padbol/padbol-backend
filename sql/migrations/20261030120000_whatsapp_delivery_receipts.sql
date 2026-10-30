begin;
create table public.whatsapp_delivery_receipts(
 tenant_id uuid not null,channel_id uuid not null,
 provider_message_id text not null check(length(provider_message_id) between 7 and 506 and provider_message_id ~ '^wamid\.[A-Za-z0-9_+/=-]+$'),
 recipient_id text not null check(recipient_id ~ '^[1-9][0-9]{5,31}$'),
 delivery_status text not null check(delivery_status in ('sent','delivered','read','failed')),
 provider_at timestamptz not null,error_code integer,received_at timestamptz not null default now(),
 primary key(tenant_id,channel_id,provider_message_id,recipient_id,delivery_status,provider_at),
 foreign key(tenant_id,channel_id) references public.whatsapp_tenant_channels(tenant_id,id)
);
alter table public.whatsapp_delivery_receipts enable row level security;
revoke all on public.whatsapp_delivery_receipts from public,anon,authenticated;
grant select,insert on public.whatsapp_delivery_receipts to service_role;
create function public.whatsapp_record_delivery_receipt(p_phone text,p_waba text,p_provider text,p_recipient text,p_status text,p_at timestamptz,p_error integer) returns boolean
language plpgsql security definer set search_path=pg_catalog,public as $$
declare ch public.whatsapp_tenant_channels%rowtype;
begin
 if p_at is null or p_at<'2020-01-01'::timestamptz or p_at>now()+interval '5 minutes' then raise exception 'invalid receipt timestamp';end if;
 select c.* into ch from public.whatsapp_tenant_channels c join public.whatsapp_tenants t on t.id=c.tenant_id
 where c.meta_phone_number_id=p_phone and c.meta_waba_id=p_waba and c.active and t.status='active';
 if not found then return false;end if;
 insert into public.whatsapp_delivery_receipts(tenant_id,channel_id,provider_message_id,recipient_id,delivery_status,provider_at,error_code)
 values(ch.tenant_id,ch.id,p_provider,p_recipient,p_status,p_at,case when p_status='failed' then p_error else null end) on conflict do nothing;
 return true;
end$$;
create function public.crm_whatsapp_delivery_summary(p_conversation uuid) returns jsonb
language sql stable security definer set search_path=pg_catalog,public as $$
 select coalesce(jsonb_agg(jsonb_build_object('replyId',id,'deliveryStatus',delivery_status,'deliveryAt',provider_at,'deliveryErrorCode',error_code)),'[]'::jsonb) from (
 select distinct on(r.id) r.id,d.delivery_status,d.provider_at,d.error_code
 from public.crm_replies r join public.crm_conversations c on c.id=r.conversation_id and c.source_channel='whatsapp'
 join public.crm_contacts ct on ct.id=c.contact_id
 join public.whatsapp_tenant_channels ch on c.origin='whatsapp:'||ch.meta_phone_number_id
 join public.whatsapp_delivery_receipts d on d.tenant_id=ch.tenant_id and d.channel_id=ch.id and d.provider_message_id=r.provider_message_id
 and d.recipient_id=regexp_replace(ct.phone_normalized,'[^0-9]','','g')
 where c.id=p_conversation and r.status='sent'
 order by r.id,case d.delivery_status when 'read' then 4 when 'delivered' then 3 when 'failed' then 2 else 1 end desc,d.provider_at desc
 ) evidence
$$;
revoke all on function public.whatsapp_record_delivery_receipt(text,text,text,text,text,timestamptz,integer),public.crm_whatsapp_delivery_summary(uuid) from public,anon,authenticated;
grant execute on function public.whatsapp_record_delivery_receipt(text,text,text,text,text,timestamptz,integer),public.crm_whatsapp_delivery_summary(uuid) to service_role;
commit;
