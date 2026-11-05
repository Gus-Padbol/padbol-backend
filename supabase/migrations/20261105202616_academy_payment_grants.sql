-- Trusted, verified Stripe webhook relay only. No users or historical purchases
-- are imported. Pending payments can be claimed only by a confirmed matching email.
begin;

create table if not exists public.academy_payment_grants (
  session_id text primary key check (session_id ~ '^cs_live_[A-Za-z0-9]{1,240}$'),
  email text not null check (email=lower(btrim(email)) and length(email)<=320),
  product_code text not null check (product_code in ('coach_jugadores','coach_formador','modulo_infantil','masterclass_fide','arbitro_nacional','arbitro_internacional','formador_arbitros')),
  amount_total bigint not null check (amount_total>0),
  currency text not null check (currency='usd'),
  event_id text not null check (event_id ~ '^evt_[A-Za-z0-9]{1,240}$'),
  payment_status text not null check (payment_status='paid'),
  livemode boolean not null check (livemode=true),
  created_at timestamptz not null default now(),
  user_id uuid references auth.users(id) on delete set null
);
create index if not exists academy_payment_grants_email_idx on public.academy_payment_grants(email);
alter table public.academy_payment_grants enable row level security;
revoke all on public.academy_payment_grants from public,anon,authenticated;
do $private_grants$
declare policy_name text; columns_sql text;
begin
  for policy_name in select policyname from pg_policies where schemaname='public' and tablename='academy_payment_grants' loop
    execute format('drop policy %I on public.academy_payment_grants',policy_name);
  end loop;
  select string_agg(quote_ident(column_name),', ' order by ordinal_position) into columns_sql
    from information_schema.columns where table_schema='public' and table_name='academy_payment_grants';
  execute format('revoke all privileges (%s) on table public.academy_payment_grants from public,anon,authenticated',columns_sql);
end $private_grants$;
grant select,insert,update on public.academy_payment_grants to service_role;

create or replace function public.academy_payment_product(p_code text)
returns table(amount bigint,course_ids integer[])
language sql immutable set search_path=pg_catalog as $$
  select p.amount,p.courses from (values
    ('coach_jugadores',35000::bigint,array[94439,94411]),
    ('coach_formador',60000::bigint,array[94439,94411]),
    ('modulo_infantil',10000::bigint,array[94460,94446]),
    ('masterclass_fide',50000::bigint,array[95062,95064]),
    ('arbitro_nacional',10000::bigint,array[94436,94383]),
    ('arbitro_internacional',25000::bigint,array[94436,94383]),
    ('formador_arbitros',30000::bigint,array[94436,94383])
  ) p(code,amount,courses) where p.code=p_code;
$$;

create or replace function public.academy_record_payment_grant(
  p_session_id text,p_event_id text,p_product_code text,p_email text,
  p_amount_total bigint,p_currency text,p_payment_status text,p_livemode boolean
) returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare expected_amount bigint; courses integer[]; payment public.academy_payment_grants%rowtype; users uuid[]; owner_id uuid;
begin
  select * into payment from public.academy_payment_grants where session_id=p_session_id for update;
  if found and (payment.email,payment.product_code,payment.amount_total,payment.currency,payment.payment_status,payment.livemode)
    is distinct from (p_email,p_product_code,p_amount_total,p_currency,p_payment_status,p_livemode)
    then raise exception 'ACADEMY_PAYMENT_CONFLICT'; end if;
  select amount,course_ids into expected_amount,courses from public.academy_payment_product(p_product_code);
  if expected_amount is null or p_amount_total is distinct from expected_amount
    or p_session_id is null or p_session_id !~ '^cs_live_[A-Za-z0-9]{1,240}$'
    or p_event_id is null or p_event_id !~ '^evt_[A-Za-z0-9]{1,240}$'
    or p_email is null or length(p_email)>320 or p_email<>lower(btrim(p_email)) or p_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
    or p_currency is distinct from 'usd' or p_payment_status is distinct from 'paid' or p_livemode is distinct from true
    then raise exception 'ACADEMY_PAYMENT_INVALID'; end if;
  insert into public.academy_payment_grants(session_id,event_id,product_code,email,amount_total,currency,payment_status,livemode)
    values(p_session_id,p_event_id,p_product_code,p_email,p_amount_total,p_currency,p_payment_status,p_livemode)
    on conflict(session_id) do nothing;
  select * into strict payment from public.academy_payment_grants where session_id=p_session_id for update;
  if (payment.email,payment.product_code,payment.amount_total,payment.currency,payment.payment_status,payment.livemode)
    is distinct from (p_email,p_product_code,p_amount_total,p_currency,p_payment_status,p_livemode)
    then raise exception 'ACADEMY_PAYMENT_CONFLICT'; end if;
  -- Acknowledged grants are immutable receipts; retries must not undo a later
  -- manual entitlement revocation by recreating the enrollment.
  if payment.user_id is not null then return jsonb_build_object('status','granted'); end if;
  select array_agg(id) into users from auth.users where lower(btrim(email))=p_email and email_confirmed_at is not null;
  if coalesce(cardinality(users),0)>1 then raise exception 'ACADEMY_PAYMENT_CONFLICT'; end if;
  owner_id:=users[1];
  if owner_id is null then return jsonb_build_object('status','pending'); end if;
  insert into public.academy_enrollments(user_id,course_id)
    select owner_id,c from unnest(courses) c order by c on conflict(user_id,course_id) do nothing;
  update public.academy_payment_grants set user_id=owner_id where session_id=p_session_id;
  return jsonb_build_object('status','granted');
end $$;

create or replace function public.academy_claim_payment_grants(p_user_id uuid,p_email text)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare payment public.academy_payment_grants%rowtype; courses integer[]; expected_amount bigint; claimed integer:=0; all_courses integer[]:='{}';
begin
  if p_user_id is null or p_email is null or not exists(
    select 1 from auth.users where id=p_user_id and email_confirmed_at is not null and lower(btrim(email))=p_email
  ) then raise exception 'ACADEMY_IDENTITY_REQUIRED'; end if;
  if (select count(*) from auth.users where email_confirmed_at is not null and lower(btrim(email))=p_email)>1
    then raise exception 'ACADEMY_PAYMENT_CONFLICT'; end if;
  for payment in select * from public.academy_payment_grants
    where email=p_email and user_id is null order by session_id for update
  loop
    select amount,course_ids into expected_amount,courses from public.academy_payment_product(payment.product_code);
    if expected_amount is null or expected_amount<>payment.amount_total or payment.currency<>'usd'
      or payment.payment_status<>'paid' or payment.livemode is distinct from true then raise exception 'ACADEMY_PAYMENT_INVALID'; end if;
    insert into public.academy_enrollments(user_id,course_id)
      select p_user_id,c from unnest(courses) c order by c on conflict(user_id,course_id) do nothing;
    update public.academy_payment_grants set user_id=p_user_id where session_id=payment.session_id;
    claimed:=claimed+1;all_courses:=all_courses||courses;
  end loop;
  return jsonb_build_object('claimedPayments',claimed,'courseIds',coalesce((select jsonb_agg(c order by c) from(select distinct unnest(all_courses) c)s),'[]'::jsonb));
end $$;

revoke all on function public.academy_payment_product(text) from public,anon,authenticated;
revoke all on function public.academy_record_payment_grant(text,text,text,text,bigint,text,text,boolean) from public,anon,authenticated;
revoke all on function public.academy_claim_payment_grants(uuid,text) from public,anon,authenticated;
grant execute on function public.academy_payment_product(text),public.academy_record_payment_grant(text,text,text,text,bigint,text,text,boolean),public.academy_claim_payment_grants(uuid,text) to service_role;

commit;
