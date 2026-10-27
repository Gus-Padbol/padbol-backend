-- Snapshot inmutable del contexto efectivo dentro del commit atómico del menú.
-- Requiere crm_support_preparation y el menú atómico existente. No modifica sender/gates.
begin;
create or replace function public.crm_support_context_immutable()returns trigger
language plpgsql set search_path=pg_catalog,public as $$begin raise exception 'SUPPORT_CONTEXT_IMMUTABLE';end$$;
revoke all on function public.crm_support_context_immutable()from public,anon,authenticated,service_role;
drop trigger if exists crm_support_context_no_update on public.crm_support_event_context;
create trigger crm_support_context_no_update before update on public.crm_support_event_context for each row execute function public.crm_support_context_immutable();

create or replace function public.crm_support_snapshot_menu_event()returns trigger
language plpgsql security definer set search_path=pg_catalog,public as $$
declare cfg public.crm_support_preparation_config%rowtype;
 i public.whatsapp_inbound_messages%rowtype;ch public.whatsapp_tenant_channels%rowtype;
 c public.crm_conversations%rowtype;e public.crm_inbound_events%rowtype;
 m jsonb;f jsonb;kind text:='unknown';topic text;confirmed boolean:=false;
begin
 select * into cfg from public.crm_support_preparation_config where singleton;
 if not coalesce(cfg.producer_enabled,false)then return NEW;end if;
 select * into i from public.whatsapp_inbound_messages where id=NEW.inbound_message_id;
 if not found then return NEW;end if;
 select * into ch from public.whatsapp_tenant_channels where id=i.channel_id and tenant_id=i.tenant_id;
 if not found or not ch.active then return NEW;end if;
 select * into c from public.crm_conversations where id=NEW.conversation_id for update;
 if not found or c.source_channel is distinct from 'whatsapp' or c.origin is distinct from ('whatsapp:'||ch.meta_phone_number_id)
  or c.origin is distinct from cfg.whatsapp_origin or NEW.menu_revision is null or NEW.menu_revision is distinct from c.test_visibility_version then return NEW;end if;
 select * into e from public.crm_inbound_events where conversation_id=c.id and source_channel='whatsapp' and origin=c.origin and source_ref=i.provider_message_id;
 if not found then return NEW;end if;
 -- NEW.menu_revision + inbound exacto acreditan la transición actual. No inferir desde un menú posterior ni exigir un lastEventId del followup que no existe en el contrato.
 m:=c.qualification_data->'whatsapp_menu';f:=m->'followup';
 if jsonb_typeof(f)='object'then
  kind:='followup';topic:=f->>'topic';
  confirmed:=(f->'stage'='null'::jsonb and length(trim(coalesce(f->>'detail','')))>0);
 elsif jsonb_typeof(m)='object'then
  kind:='primary';topic:=m->>'topic';confirmed:=(m->>'stage'='selected');
 end if;
 confirmed:=coalesce(confirmed,false) and topic in('sede','match','next_generation','academy','fipa','soporte','otros')
  and c.qualification_data#>>'{whatsapp_order_review,required}' is distinct from 'true'
  and c.qualification_data#>>'{whatsapp_message_order_review,required}' is distinct from 'true';
 insert into public.crm_support_event_context(event_id,conversation_id,menu_inbound_id,tenant_id,channel_id,origin,source_ref,menu_revision,context_kind,effective_topic,confirmed)
 values(e.id,c.id,i.id,i.tenant_id,i.channel_id,e.origin,e.source_ref,NEW.menu_revision,kind,topic,coalesce(confirmed,false))on conflict(event_id)do nothing;
 perform public.crm_capture_support_event(e.id);
 return NEW;
end$$;
revoke all on function public.crm_support_snapshot_menu_event()from public,anon,authenticated,service_role;
drop trigger if exists crm_support_snapshot_committed_menu on public.crm_whatsapp_menu_events;
create trigger crm_support_snapshot_committed_menu after insert on public.crm_whatsapp_menu_events for each row execute function public.crm_support_snapshot_menu_event();
commit;
