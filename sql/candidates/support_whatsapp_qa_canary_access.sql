-- QA private run-once control. Empty by default; no user/phone/key is seeded.
-- Requires support_whatsapp_qa_canary.sql and dispatcher/lifecycle candidates.
begin;
create table public.crm_support_qa_canary_access (
 singleton boolean primary key default true check(singleton),
 token_sha256 text not null unique check(token_sha256 ~ '^[0-9a-f]{64}$'),
 enabled boolean not null default false,
 security_approved boolean not null default false,
 effect_id bigint references public.crm_support_lifecycle_effects(id),
 principal_id uuid references public.crm_support_delivery_principals(id),
 authorized_recipient text check(authorized_recipient ~ '^[1-9][0-9]{7,14}$'),
 check(not enabled or (security_approved and effect_id is not null and principal_id is not null and authorized_recipient is not null))
);
alter table public.crm_support_qa_canary_access enable row level security;
revoke all on public.crm_support_qa_canary_access from public,anon,authenticated,service_role;
grant select on public.crm_support_qa_canary_access to service_role;
commit;
