begin;
alter table public.crm_conversations add column email_return_linked_to uuid references public.crm_conversations(id);
create index crm_email_return_fallback_lookup on public.crm_conversations(source_channel,source_ref,origin);
create table public.crm_email_return_pending (
 id text primary key check(id ~ '^[a-f0-9]{64}$'),
 external_id text not null unique,sender text not null,recipient text not null,
 message_refs text[] not null,raw_event jsonb not null,payload_hash text not null,
 fallback_origin text not null check(fallback_origin='institutional_email'),
 status text not null default 'pending' check(status in ('pending','matched','needs_review')),
 linked_conversation_id uuid references public.crm_conversations(id),
 fallback_conversation_id uuid references public.crm_conversations(id),
 review_reason text,last_checked_at timestamptz,created_at timestamptz not null default now(),
 check(jsonb_typeof(raw_event)='object')
);
create index crm_email_return_pending_refs on public.crm_email_return_pending using gin(message_refs);
create index crm_email_return_pending_work on public.crm_email_return_pending(status,last_checked_at);
create table public.crm_email_return_queue_audit (
 id bigint generated always as identity primary key,queue_id text not null references public.crm_email_return_pending(id),
 event_type text not null check(event_type in ('queued','payload_conflict','matched','needs_review','fallback_linked')),
 details jsonb not null,created_at timestamptz not null default now()
);
create index crm_email_return_queue_audit_lookup on public.crm_email_return_queue_audit(queue_id,event_type);
alter table public.crm_email_return_pending enable row level security;
alter table public.crm_email_return_queue_audit enable row level security;
revoke all on public.crm_email_return_pending,public.crm_email_return_queue_audit from public,anon,authenticated;
grant select,insert,update on public.crm_email_return_pending to service_role;
grant select,insert on public.crm_email_return_queue_audit to service_role;
grant usage,select on sequence public.crm_email_return_queue_audit_id_seq to service_role;
create function public.crm_email_return_queue_immutable() returns trigger language plpgsql set search_path=pg_catalog,public as $$begin raise exception 'IMMUTABLE';end$$;
create trigger crm_email_return_queue_audit_immutable before update or delete on public.crm_email_return_queue_audit for each row execute function public.crm_email_return_queue_immutable();
create function public.crm_email_return_pending_preserve() returns trigger language plpgsql set search_path=pg_catalog,public as $$begin
 if tg_op='DELETE' then raise exception 'IMMUTABLE';end if;
 if (to_jsonb(new)-'status'-'linked_conversation_id'-'fallback_conversation_id'-'review_reason'-'last_checked_at') is distinct from (to_jsonb(old)-'status'-'linked_conversation_id'-'fallback_conversation_id'-'review_reason'-'last_checked_at') then raise exception 'IMMUTABLE';end if;
 return new;
end$$;
create trigger crm_email_return_pending_preserve before update or delete on public.crm_email_return_pending for each row execute function public.crm_email_return_pending_preserve();
-- Only an internal service can invoke this function. It independently checks
-- provider-authenticated RFC references, identity, source and absence of human work.
create function public.crm_email_return_link_fallback(p_queue text,p_target uuid,p_fallback uuid) returns text
language plpgsql security definer set search_path=pg_catalog,public as $$
declare q public.crm_email_return_pending%rowtype;f public.crm_conversations%rowtype;target_count integer;target_id uuid;
begin
 select * into q from public.crm_email_return_pending where id=p_queue for update;
 if not found or q.status<>'matched' or q.linked_conversation_id is distinct from p_target or p_target=p_fallback then raise exception 'EMAIL_RETURN_LINK_INVALID';end if;
 select count(distinct c.id),min(c.id::text)::uuid into target_count,target_id
 from public.crm_email_provider_receipts e join public.crm_replies r on r.id=e.reply_id
 join public.crm_conversations c on c.id=r.conversation_id join public.crm_contacts p on p.id=c.contact_id
 where e.rfc_message_id=any(q.message_refs) and c.source_channel='email' and c.test_hidden_at is null and c.email_return_linked_to is null;
 if target_count<>1 or target_id<>p_target or not exists(select 1 from public.crm_conversations c join public.crm_contacts p on p.id=c.contact_id where c.id=p_target and p.email_normalized=q.sender) then raise exception 'EMAIL_RETURN_IDENTITY_INVALID';end if;
 if not exists(select 1 from public.crm_inbound_events e where e.conversation_id=p_target and e.source_channel='email' and e.source_ref='email-message:'||q.id and e.body=left(q.raw_event->>'body',4000)) then raise exception 'EMAIL_RETURN_TARGET_MESSAGE_MISSING';end if;
 select * into f from public.crm_conversations where id=p_fallback for update;
 if not found or f.source_channel<>'email' or f.origin<>q.fallback_origin or f.source_ref<>q.external_id or f.inbound_body is distinct from left(q.raw_event->>'body',4000)
 or not exists(select 1 from public.crm_contacts p where p.id=f.contact_id and p.email_normalized=q.sender) then raise exception 'EMAIL_RETURN_FALLBACK_INVALID';end if;
 if f.email_return_linked_to=p_target then return 'already_linked';end if;
 if f.email_return_linked_to is not null then raise exception 'EMAIL_RETURN_FALLBACK_CONFLICT';end if;
 if f.estado<>'nuevo' or f.operador is not null or coalesce(f.derivado,false)
 or exists(select 1 from public.crm_replies r where r.conversation_id=f.id)
 or exists(select 1 from public.crm_activities a where a.conversation_id=f.id and coalesce(a.author,'') not like 'system:%') then return 'human_review';end if;
 insert into public.crm_email_return_queue_audit(queue_id,event_type,details) values(q.id,'fallback_linked',jsonb_build_object('targetConversationId',p_target,'fallbackConversationId',p_fallback));
 update public.crm_conversations set email_return_linked_to=p_target where id=p_fallback;
 update public.crm_email_return_pending set fallback_conversation_id=p_fallback where id=q.id;
 insert into public.crm_activities(contact_id,conversation_id,activity_type,summary,author) values(f.contact_id,p_target,'note','Correo institucional duplicado vinculado al historial original. Referencia: '||p_fallback::text,'system:email-return');
 return 'linked';
end$$;
revoke all on function public.crm_email_return_link_fallback(text,uuid,uuid),public.crm_email_return_queue_immutable(),public.crm_email_return_pending_preserve() from public,anon,authenticated;
grant execute on function public.crm_email_return_link_fallback(text,uuid,uuid) to service_role;
create function public.crm_email_return_link_guard() returns trigger language plpgsql set search_path=pg_catalog,public as $$begin
 if tg_op='INSERT' then if new.email_return_linked_to is not null then raise exception 'EMAIL_RETURN_LINK_INTERNAL_ONLY';end if;return new;end if;
 if new.email_return_linked_to is distinct from old.email_return_linked_to then
  if old.email_return_linked_to is not null or not exists(select 1 from public.crm_email_return_queue_audit a join public.crm_email_return_pending q on q.id=a.queue_id where a.event_type='fallback_linked' and a.details->>'fallbackConversationId'=new.id::text and a.details->>'targetConversationId'=new.email_return_linked_to::text and q.status='matched' and q.linked_conversation_id=new.email_return_linked_to) then raise exception 'EMAIL_RETURN_LINK_INTERNAL_ONLY';end if;
 end if;return new;
end$$;
create trigger crm_email_return_link_guard before insert or update on public.crm_conversations for each row execute function public.crm_email_return_link_guard();
revoke all on function public.crm_email_return_link_guard() from public,anon,authenticated;

-- Serialize human reply/note claims with fallback linking. A winning send claim
-- makes the fallback ineligible; a winning link rejects the claim before send.
create function public.crm_email_return_reject_linked_work() returns trigger language plpgsql security definer set search_path=pg_catalog,public as $$
declare linked uuid;
begin
 if tg_table_name='crm_activities' then
  if coalesce(new.author,'') like 'system:%' then return new;end if;
 end if;
 select email_return_linked_to into linked from public.crm_conversations where id=new.conversation_id for key share;
 if linked is not null then raise exception 'CRM_EMAIL_ALREADY_LINKED';end if;
 return new;
end$$;
create trigger crm_email_return_reply_claim_guard before insert on public.crm_replies for each row execute function public.crm_email_return_reject_linked_work();
create trigger crm_email_return_activity_guard before insert on public.crm_activities for each row execute function public.crm_email_return_reject_linked_work();
revoke all on function public.crm_email_return_reject_linked_work() from public,anon,authenticated;
notify pgrst,'reload schema';
commit;
