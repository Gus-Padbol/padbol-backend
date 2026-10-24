-- Candidate only. Requires crm_commercial_cases.sql and the production atomic
-- menu schema. It assigns ONLY menu transitions with a verifiable revision and
-- exact inbound-event binding. It never backfills old conversations and never
-- assigns post-handoff messages lacking a menu transition.
begin;
create function public.crm_commercial_case_route_menu_event() returns trigger
language plpgsql set search_path=pg_catalog,public as $$
declare
 v_conversation public.crm_conversations%rowtype;
 v_provider text; v_event uuid; v_origin text; v_menu jsonb; v_effective jsonb;
 v_case uuid; v_commercial boolean;
 v_assignee constant uuid := '7225442b-defd-42c1-a5a2-b9c1c339fa69';
begin
 -- No transition revision means a stale/ambiguous inbound: never classify it.
 if new.menu_revision is null then return new; end if;
 select * into v_conversation from public.crm_conversations where id=new.conversation_id for update;
 if not found or v_conversation.source_channel <> 'whatsapp' or v_conversation.origin <> 'whatsapp:1376102838911694' then return new; end if;
 select i.provider_message_id, 'whatsapp:'||c.meta_phone_number_id into v_provider,v_origin
 from public.whatsapp_inbound_messages i join public.whatsapp_tenant_channels c on c.id=i.channel_id and c.tenant_id=i.tenant_id
 where i.id=new.inbound_message_id;
 if v_provider is null or v_origin is distinct from v_conversation.origin then return new; end if;
 v_menu:=v_conversation.qualification_data->'whatsapp_menu';
 if v_menu->>'lastEventId' is distinct from v_provider then return new; end if;
 select e.id into v_event from public.crm_inbound_events e where e.conversation_id=new.conversation_id
  and e.source_channel='whatsapp' and e.origin=v_origin and e.source_ref=v_provider;
 if v_event is null then return new; end if;
 -- Once a followup flow exists, use only its explicit topic; never inherit the
 -- previous case topic when the new flow is still unclassified.
 v_effective:=case when jsonb_typeof(v_menu->'followup')='object' then v_menu->'followup' else v_menu end;
 v_commercial:=coalesce(v_effective->>'topic'='sede' and v_effective->>'stage' in ('subtopic','details','selected'),false);
 select id into v_case from public.crm_commercial_cases where conversation_id=new.conversation_id and status in ('open','suspended') for update;
 if not v_commercial and coalesce(v_effective->>'topic','') not in ('match','next_generation','academy','fipa','soporte','otros') then return new; end if;
 if not v_commercial then
   if v_case is not null then update public.crm_commercial_cases set status='closed' where id=v_case; end if;
   return new;
 end if;
 if v_case is null then
   insert into public.crm_commercial_cases(conversation_id,assigned_user_id) values(new.conversation_id,v_assignee) returning id into v_case;
 else
   update public.crm_commercial_cases set status='open' where id=v_case;
 end if;
 insert into public.crm_commercial_case_inbound(case_id,conversation_id,inbound_event_id)
 values(v_case,new.conversation_id,v_event) on conflict(inbound_event_id) do nothing;
 if new.reply_id is not null then
   insert into public.crm_commercial_case_replies(case_id,conversation_id,reply_id)
   values(v_case,new.conversation_id,new.reply_id) on conflict(reply_id) do nothing;
 end if;
 return new;
end $$;
revoke all on function public.crm_commercial_case_route_menu_event() from public,anon,authenticated;
create trigger crm_commercial_case_route_menu_event after insert on public.crm_whatsapp_menu_events
for each row execute function public.crm_commercial_case_route_menu_event();
-- Ingress is recorded before menu classification. Suspend the prior case in
-- that transaction; do not expose or reply against it while the new message
-- could concern another topic. A verified transition can reopen it.
create function public.crm_commercial_case_suspend_on_inbound() returns trigger
language plpgsql set search_path=pg_catalog,public as $$
begin
 if new.source_channel='whatsapp' then
   update public.crm_commercial_cases set status='suspended'
   where conversation_id=new.conversation_id and status in ('open','suspended');
 end if;
 return new;
end $$;
revoke all on function public.crm_commercial_case_suspend_on_inbound() from public,anon,authenticated;
create trigger crm_commercial_case_suspend_on_inbound after insert on public.crm_inbound_events
for each row execute function public.crm_commercial_case_suspend_on_inbound();
commit;
