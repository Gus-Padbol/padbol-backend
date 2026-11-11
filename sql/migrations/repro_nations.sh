#!/bin/bash
set -u
J="/Users/padbol2022/PADBOL-LAB-DEEPSEEK/padbol-backend-canonical/.worktrees/nations-roster-privacy-20261107"
D="/Users/padbol2022/Documents/Codex/2026-11-06/task-4"
PGDATA=/tmp/npgR_$$; SOCK=/tmp/nskR_$$; mkdir -p "$SOCK"; trap 'pg_ctl -D "$PGDATA" stop -m fast >/dev/null 2>&1; rm -rf "$PGDATA" "$SOCK"' EXIT
initdb -D "$PGDATA" -U postgres --auth=trust >/tmp/r_init.log 2>&1 || { echo "INITDB FAIL"; exit 1; }
pg_ctl -D "$PGDATA" -o "-k $SOCK -c listen_addresses=''" -l /tmp/r_pg.log start >/dev/null 2>&1 || { echo "START FAIL"; tail -3 /tmp/r_pg.log; exit 1; }
export PGHOST="$SOCK" PGUSER=postgres
createdb nats_repro || { echo "CREATEDB FAIL"; exit 1; }
psql -q -d nats_repro -v ON_ERROR_STOP=1 >/tmp/r_prep.log 2>&1 <<'SQL'
create extension if not exists pgcrypto;
create or replace function public.uuid_generate_v4() returns uuid language sql volatile as $$ select gen_random_uuid() $$;
create schema if not exists auth;
create table if not exists auth.users(id uuid primary key default gen_random_uuid(), email text, raw_app_meta_data jsonb default '{}');
create or replace function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('test.actor',true),'')::uuid $$;
create role anon; create role authenticated; create role service_role;
SQL
[ $? -ne 0 ] && { echo "PREP FAIL"; tail -5 /tmp/r_prep.log; exit 1; }
psql -q -d nats_repro -v ON_ERROR_STOP=1 -f "$J/sql/migrations/rpc_schema_real.sql" >/tmp/r_ddl.log 2>&1 || { echo "DDL FAIL"; tail -5 /tmp/r_ddl.log; exit 1; }
psql -q -d nats_repro -v ON_ERROR_STOP=1 -f "$J/sql/migrations/rpc_participantes_real.sql" >/tmp/r_rpc.log 2>&1 || { echo "RPC FAIL"; tail -5 /tmp/r_rpc.log; exit 1; }
psql -q -d nats_repro -v ON_ERROR_STOP=1 >/tmp/r_h.log 2>&1 <<'SQL'
create or replace function public.torneo_inscripcion_fecha_vigente(date,bigint,jsonb) returns boolean language sql stable as $$ select true $$;
create or replace function public.participante_plantel_congelado(uuid) returns boolean language sql stable as $$ select false $$;
SQL
psql -q -d nats_repro -v ON_ERROR_STOP=1 -f "$J/sql/migrations/20261107010000_nations_roster_privacy.sql" >/tmp/r_fwd.log 2>&1 || { echo "FWD FAIL"; tail -5 /tmp/r_fwd.log; exit 1; }
psql -q -d nats_repro -v ON_ERROR_STOP=1 -f /tmp/repro_seed.sql >/tmp/r_seed.log 2>&1 || { echo "SEED FAIL"; tail -5 /tmp/r_seed.log; exit 1; }
COUNTS=$(psql -d nats_repro -At -c "select (select count(*) from public.torneos),(select count(*) from public.torneo_participantes),(select count(*) from public.equipos),(select count(*) from public.torneo_participante_equipos),(select count(*) from public.nations_activation_events)")
echo "COUNTS torneos|participantes|equipos|vinculos|eventos = $COUNTS"
psql -d nats_repro -f /tmp/repro_cases.sql > "$D/NATS-rpc-compat-pg.log" 2>&1
RC=$?
echo "casos exit=$RC"
grep -E "CASO|ERROR|RESULTADO" "$D/NATS-rpc-compat-pg.log" | head -10
exit $RC
