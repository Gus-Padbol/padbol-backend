begin;
create table public.crm_whatsapp_automation_releases (
 conversation_id uuid primary key references public.crm_conversations(id) on delete restrict,
 released_by uuid not null, released_at timestamptz not null default clock_timestamp()
);
create table public.crm_whatsapp_automation_release_audit (
 id bigint generated always as identity primary key,
 conversation_id uuid not null references public.crm_conversations(id) on delete restrict,
 released_by uuid not null, released_at timestamptz not null default clock_timestamp()
);
alter table public.crm_whatsapp_automation_releases enable row level security;
alter table public.crm_whatsapp_automation_release_audit enable row level security;
revoke all on public.crm_whatsapp_automation_releases,public.crm_whatsapp_automation_release_audit from public,anon,authenticated,service_role;
grant select on public.crm_whatsapp_automation_releases to service_role;
create function public.crm_revoke_whatsapp_automation_release() returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
begin
 perform 1 from public.crm_conversations where id=new.conversation_id for update;
 delete from public.crm_whatsapp_automation_releases where conversation_id=new.conversation_id;
 return new;
end $$;
revoke all on function public.crm_revoke_whatsapp_automation_release() from public,anon,authenticated;
create trigger crm_revoke_whatsapp_automation_release after insert on public.crm_whatsapp_manual_attempts
 for each row execute function public.crm_revoke_whatsapp_automation_release();
create function public.crm_resume_whatsapp_automation(p_conversation_id uuid,p_actor_id uuid) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare c public.crm_conversations%rowtype;
begin
 if p_actor_id is null then raise exception 'actor required'; end if;
 select * into c from public.crm_conversations where id=p_conversation_id for update;
 if not found or c.source_channel<>'whatsapp' or c.origin<>'whatsapp:1376102838911694'
    or c.estado<>'nuevo' or c.operador is not null or c.sede_id is not null or c.assigned_by is not null
    or coalesce(c.derivado,false) or coalesce(c.handoff_ready,false)
    or coalesce((c.qualification_data #>> '{whatsapp_order_review,required}')::boolean,false)
    or coalesce((c.qualification_data #>> '{whatsapp_message_order_review,required}')::boolean,false)
 then raise exception 'conversation not eligible for automation'; end if;
 if exists(select 1 from public.crm_whatsapp_manual_attempts a join public.crm_replies r on r.id=a.reply_id
     where a.conversation_id=p_conversation_id and r.status<>'sent')
    or exists(select 1 from public.crm_whatsapp_menu_events e join public.whatsapp_outbox o on o.id=e.outbox_id
       where e.conversation_id=p_conversation_id and (o.status='sending' or o.last_error='WHATSAPP_SEND_UNCERTAIN_NO_RETRY'))
 then raise exception 'unresolved delivery'; end if;
 insert into public.crm_whatsapp_automation_releases(conversation_id,released_by,released_at)
 values(p_conversation_id,p_actor_id,clock_timestamp()) on conflict(conversation_id)
 do update set released_by=excluded.released_by,released_at=excluded.released_at;
 insert into public.crm_whatsapp_automation_release_audit(conversation_id,released_by) values(p_conversation_id,p_actor_id);
 return jsonb_build_object('resumed',true);
end $$;
revoke all on function public.crm_resume_whatsapp_automation(uuid,uuid) from public,anon,authenticated;
grant execute on function public.crm_resume_whatsapp_automation(uuid,uuid) to service_role;
commit;
