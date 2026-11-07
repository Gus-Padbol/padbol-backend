#!/bin/bash
set -u
J="/Users/padbol2022/PADBOL-LAB-DEEPSEEK/padbol-backend-canonical/.worktrees/nations-roster-privacy-20261107"
PGDATA=/tmp/rls_$$; SOCK=/tmp/rlsk_$$; mkdir -p "$SOCK"; trap 'pg_ctl -D "$PGDATA" stop -m fast >/dev/null 2>&1; rm -rf "$PGDATA" "$SOCK"' EXIT
initdb -D "$PGDATA" -U postgres --auth=trust >/tmp/rls_i.log 2>&1 || exit 1
pg_ctl -D "$PGDATA" -o "-k $SOCK -c listen_addresses=''" -l /tmp/rls_pg.log start >/dev/null 2>&1 || exit 1
export PGHOST="$SOCK" PGUSER=postgres; createdb rls
psql -q -d rls >/dev/null 2>&1 <<'SQL'
create extension if not exists pgcrypto;
create or replace function public.uuid_generate_v4() returns uuid language sql volatile as $$ select gen_random_uuid() $$;
create schema if not exists auth;
create table if not exists auth.users(id uuid primary key default gen_random_uuid(), email text, raw_app_meta_data jsonb default '{}');
create or replace function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('test.actor',true),'')::uuid $$;
create role anon; create role authenticated; create role service_role;
SQL
psql -q -d rls -v ON_ERROR_STOP=1 -f "$J/sql/migrations/rpc_schema_real.sql" >/tmp/rls_ddl.log 2>&1 || { echo "DDL FAIL"; exit 1; }
psql -q -d rls -v ON_ERROR_STOP=1 -f "$J/sql/migrations/rpc_participantes_real.sql" >/tmp/rls_rpc.log 2>&1 || { echo "RPC FAIL"; exit 1; }
psql -q -d rls >/dev/null 2>&1 <<'SQL'
create or replace function public.torneo_inscripcion_fecha_vigente(date,bigint,jsonb) returns boolean language sql stable as $$ select true $$;
create or replace function public.participante_plantel_congelado(uuid) returns boolean language sql stable as $$ select false $$;
SQL
psql -q -d rls -v ON_ERROR_STOP=1 -f "$J/sql/migrations/20261107010000_nations_roster_privacy.sql" >/tmp/rls_fwd1.log 2>&1 || { echo "FWD1 FAIL"; exit 1; }
H1=$(psql -d rls -At -c "select md5(pg_get_functiondef(oid)) from pg_proc where proname='gestionar_participantes_torneo'")
psql -q -d rls -v ON_ERROR_STOP=1 -f "$J/sql/migrations/20261107010000_nations_roster_privacy.sql" >/tmp/rls_fwd2.log 2>&1 || { echo "FWD2 FAIL"; exit 1; }
H2=$(psql -d rls -At -c "select md5(pg_get_functiondef(oid)) from pg_proc where proname='gestionar_participantes_torneo'")
echo "HASH_Idempotencia $([ "$H1" = "$H2" ] && echo IGUAL || echo DISTINTO)"
psql -q -d rls -v ON_ERROR_STOP=1 -f /tmp/rls_seed.sql >/tmp/rls_seed.log 2>&1 || { echo "SEED FAIL"; tail -3 /tmp/rls_seed.log; exit 1; }
psql -d rls -f /tmp/rls_cases.sql
