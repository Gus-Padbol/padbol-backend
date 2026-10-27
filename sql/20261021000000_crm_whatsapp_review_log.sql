-- Audit-only: never updates, releases or retries a WhatsApp attempt.
begin;
create table if not exists public.crm_whatsapp_review_log (
  id uuid primary key,
  reply_id uuid not null references public.crm_whatsapp_manual_attempts(reply_id) on delete restrict,
  reviewer_id uuid not null,
  evidence_kind text not null check (evidence_kind in ('provider_receipt', 'provider_status', 'no_conclusive_evidence')),
  evidence_sha256 text check (evidence_sha256 is null or evidence_sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  check ((evidence_kind = 'no_conclusive_evidence' and evidence_sha256 is null) or (evidence_kind <> 'no_conclusive_evidence' and evidence_sha256 is not null))
);
alter table public.crm_whatsapp_review_log enable row level security;
revoke all on table public.crm_whatsapp_review_log from public, anon, authenticated, service_role;
grant select on table public.crm_whatsapp_review_log to service_role;
create or replace function public.crm_log_whatsapp_review(p_id uuid,p_reply_id uuid,p_reviewer_id uuid,p_kind text,p_evidence_sha256 text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare r public.crm_replies%rowtype; existing public.crm_whatsapp_review_log%rowtype;
begin
  select * into r from public.crm_replies where id=p_reply_id for update;
  if not found or r.status <> 'pending' or not exists (select 1 from public.crm_whatsapp_manual_attempts where reply_id=p_reply_id) then
    raise exception 'attempt not pending';
  end if;
  insert into public.crm_whatsapp_review_log (id,reply_id,reviewer_id,evidence_kind,evidence_sha256)
  values (p_id,p_reply_id,p_reviewer_id,p_kind,p_evidence_sha256) on conflict (id) do nothing;
  select * into existing from public.crm_whatsapp_review_log where id=p_id;
  if existing.reply_id is distinct from p_reply_id or existing.reviewer_id is distinct from p_reviewer_id or existing.evidence_kind is distinct from p_kind or existing.evidence_sha256 is distinct from p_evidence_sha256 then
    raise exception 'review reference conflict';
  end if;
  return jsonb_build_object('id', existing.id, 'status', 'pending', 'released', false);
end $$;
revoke all on function public.crm_log_whatsapp_review(uuid,uuid,uuid,text,text) from public, anon, authenticated;
grant execute on function public.crm_log_whatsapp_review(uuid,uuid,uuid,text,text) to service_role;
commit;
