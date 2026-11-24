-- Dependencia: NG solicitudes/sedes/user_roles existentes (QA017 base).
create table public.ng_cuentas_programa (
 id uuid primary key default gen_random_uuid(),
 venue_request_id uuid not null references public.ng_solicitudes_sede(id),
 currency char(3) not null check (currency ~ '^[A-Z]{3}$'),
 canonical_sede_id bigint not null references public.sedes(id),
 created_by uuid not null,
 created_at timestamptz not null default now(),
 unique (venue_request_id, currency)
);
create table public.ng_cuenta_movimientos (
 id uuid primary key default gen_random_uuid(),
 account_id uuid not null references public.ng_cuentas_programa(id),
 operation_key text not null check (length(operation_key) between 1 and 160),
 type text not null check (type in ('sponsor_cobrado','gasto','apartar_fondo','liberar_fondo','reversion')),
 amount numeric(14,2) not null check (amount > 0),
 original_id uuid references public.ng_cuenta_movimientos(id),
 payload_hash text not null,
 actor_id uuid not null,
 created_at timestamptz not null default now(),
 unique (account_id, operation_key),
 unique (original_id),
 check ((type='reversion' and original_id is not null) or (type<>'reversion' and original_id is null))
);
create index ng_cuenta_movimientos_account_idx on public.ng_cuenta_movimientos(account_id, created_at, id);
alter table public.ng_cuentas_programa enable row level security;
alter table public.ng_cuenta_movimientos enable row level security;
revoke all on public.ng_cuentas_programa, public.ng_cuenta_movimientos from public,anon,authenticated;
grant select on public.ng_cuentas_programa, public.ng_cuenta_movimientos to service_role;
create function public.ng_ledger_immutable() returns trigger language plpgsql set search_path=pg_catalog as $$begin raise exception 'NG_LEDGER_IMMUTABLE';end$$;
create trigger ng_cuentas_no_update before update or delete on public.ng_cuentas_programa for each row execute function public.ng_ledger_immutable();
create trigger ng_movimientos_no_update before update or delete on public.ng_cuenta_movimientos for each row execute function public.ng_ledger_immutable();
revoke all on function public.ng_ledger_immutable() from public,anon,authenticated;
grant execute on function public.ng_ledger_immutable() to service_role;

create or replace function public.nextgen_ledger_command(
 p_actor uuid, p_operation text, p_venue_request_id uuid, p_currency text,
 p_operation_key text default null, p_type text default null, p_amount numeric default null, p_original_id uuid default null
) returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare req public.ng_solicitudes_sede; acct public.ng_cuentas_programa; mov public.ng_cuenta_movimientos; existing public.ng_cuenta_movimientos;
 v_currency text:=upper(trim(coalesce(p_currency,''))); v_hash text; v_income numeric; v_expense numeric; v_fund numeric; v_available numeric; v_reversed uuid;
begin
 if p_actor is null or not exists(select 1 from public.user_roles where user_id=p_actor and role='super_admin') then raise exception 'FORBIDDEN'; end if;
 if v_currency !~ '^[A-Z]{3}$' or p_operation not in ('read','move') then raise exception 'INVALID'; end if;
 select * into req from public.ng_solicitudes_sede where id=p_venue_request_id for update;
 if not found then raise exception 'REQUEST_NOT_FOUND'; end if;
 if lower(coalesce(req.estado,''))<>'aprobada' or req.canonical_sede_id is null then raise exception 'REQUEST_NOT_APPROVED'; end if;
 select * into acct from public.ng_cuentas_programa where venue_request_id=p_venue_request_id and currency=v_currency for update;
 if found and acct.canonical_sede_id is distinct from req.canonical_sede_id then raise exception 'MAPPING_CHANGED'; end if;
 if p_operation='move' then
  if not found then
   insert into public.ng_cuentas_programa(venue_request_id,currency,canonical_sede_id,created_by)
   values(p_venue_request_id,v_currency,req.canonical_sede_id,p_actor) returning * into acct;
  end if;
  if p_operation_key is null or length(trim(p_operation_key)) not between 1 and 160 then raise exception 'INVALID'; end if;
  if p_type not in ('sponsor_cobrado','gasto','apartar_fondo','liberar_fondo','reversion') or p_amount is null or p_amount<=0 or p_amount<>round(p_amount,2) or p_amount>999999999999.99 then raise exception 'INVALID_AMOUNT'; end if;
  v_hash:=md5(coalesce(p_type,'')||'|'||to_char(p_amount,'FM9999999999999990.00')||'|'||coalesce(p_original_id::text,''));
  select * into existing from public.ng_cuenta_movimientos where account_id=acct.id and operation_key=trim(p_operation_key);
  if found then
   if existing.payload_hash<>v_hash then raise exception 'IDEMPOTENCY_CONFLICT'; end if;
  else
   if p_type='reversion' then
    if p_original_id is null then raise exception 'INVALID'; end if;
    select * into mov from public.ng_cuenta_movimientos where id=p_original_id and account_id=acct.id;
    if not found or mov.type='reversion' or mov.amount<>p_amount then raise exception 'REVERSAL_INVALID'; end if;
    if exists(select 1 from public.ng_cuenta_movimientos where original_id=p_original_id) then raise exception 'REVERSAL_ALREADY'; end if;
   elsif p_original_id is not null then raise exception 'INVALID'; end if;
   begin
    insert into public.ng_cuenta_movimientos(account_id,operation_key,type,amount,original_id,payload_hash,actor_id)
    values(acct.id,trim(p_operation_key),p_type,p_amount,p_original_id,v_hash,p_actor) returning * into mov;
   exception when unique_violation then raise exception 'IDEMPOTENCY_CONFLICT'; end;
  end if;
  select coalesce(sum(amount),0) into v_income from public.ng_cuenta_movimientos m where m.account_id=acct.id and m.type='sponsor_cobrado' and not exists(select 1 from public.ng_cuenta_movimientos r where r.original_id=m.id);
  select coalesce(sum(amount),0) into v_expense from public.ng_cuenta_movimientos m where m.account_id=acct.id and m.type='gasto' and not exists(select 1 from public.ng_cuenta_movimientos r where r.original_id=m.id);
  select coalesce(sum(case when type='apartar_fondo' then amount when type='liberar_fondo' then -amount else 0 end),0) into v_fund from public.ng_cuenta_movimientos m where m.account_id=acct.id and type in ('apartar_fondo','liberar_fondo') and not exists(select 1 from public.ng_cuenta_movimientos r where r.original_id=m.id);
  v_available:=v_income-v_expense-v_fund;
  if v_fund<0 or v_available<0 then raise exception 'NEGATIVE_BALANCE'; end if;
 end if;
 return jsonb_build_object(
  'account', case when acct.id is null then null else jsonb_build_object('id',acct.id,'venue_request_id',acct.venue_request_id,'currency',acct.currency,'canonical_sede_id',acct.canonical_sede_id) end,
  'summary', jsonb_build_object('collected_income',to_char(coalesce((select sum(amount) from public.ng_cuenta_movimientos m where m.account_id=acct.id and m.type='sponsor_cobrado' and not exists(select 1 from public.ng_cuenta_movimientos r where r.original_id=m.id)),0),'FM9999999999999990.00'),'expense',to_char(coalesce((select sum(amount) from public.ng_cuenta_movimientos m where m.account_id=acct.id and m.type='gasto' and not exists(select 1 from public.ng_cuenta_movimientos r where r.original_id=m.id)),0),'FM9999999999999990.00'),'reserved_fund',to_char(coalesce((select sum(case when type='apartar_fondo' then amount when type='liberar_fondo' then -amount else 0 end) from public.ng_cuenta_movimientos m where m.account_id=acct.id and type in ('apartar_fondo','liberar_fondo') and not exists(select 1 from public.ng_cuenta_movimientos r where r.original_id=m.id)),0),'FM9999999999999990.00'),'available',to_char(coalesce((select sum(amount) from public.ng_cuenta_movimientos m where m.account_id=acct.id and m.type='sponsor_cobrado' and not exists(select 1 from public.ng_cuenta_movimientos r where r.original_id=m.id)),0)-coalesce((select sum(amount) from public.ng_cuenta_movimientos m where m.account_id=acct.id and m.type='gasto' and not exists(select 1 from public.ng_cuenta_movimientos r where r.original_id=m.id)),0)-coalesce((select sum(case when type='apartar_fondo' then amount when type='liberar_fondo' then -amount else 0 end) from public.ng_cuenta_movimientos m where m.account_id=acct.id and type in ('apartar_fondo','liberar_fondo') and not exists(select 1 from public.ng_cuenta_movimientos r where r.original_id=m.id)),0),'FM9999999999999990.00')),
  'movements', case when acct.id is null then '[]'::jsonb else coalesce((select jsonb_agg(jsonb_build_object('id',m.id,'operation_key',m.operation_key,'type',m.type,'amount',to_char(m.amount,'FM9999999999999990.00'),'original_id',m.original_id,'created_at',m.created_at) order by m.created_at,m.id) from public.ng_cuenta_movimientos m where m.account_id=acct.id),'[]'::jsonb) end,
  'replayed', coalesce(existing.id is not null and p_operation='move',false)
 );
exception when unique_violation then raise exception 'IDEMPOTENCY_CONFLICT';
end $$;
revoke all on function public.nextgen_ledger_command(uuid,text,uuid,text,text,text,numeric,uuid) from public,anon,authenticated;
grant execute on function public.nextgen_ledger_command(uuid,text,uuid,text,text,text,numeric,uuid) to service_role;
