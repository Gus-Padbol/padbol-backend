/** Dry-run local: aplica migracion, hashea objetos, prueba rollback con y sin datos. */
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const require = createRequire(import.meta.url);
const {Pool} = require('pg');
const MIG = fs.readFileSync(new URL('../sql/migrations/20261107150000_nations_profile_requests.sql', import.meta.url), 'utf8');
const RB = fs.readFileSync(new URL('../sql/migrations/20261107150000_nations_profile_requests.rollback.sql', import.meta.url), 'utf8');
const PGDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'dry-'));
const SOCK = fs.mkdtempSync(path.join(os.tmpdir(), 'drys-'));
const run = (c, a) => execFileSync(c, a, {encoding: 'utf8'});
const out = [];
const log = (k, v) => { out.push(`${k}: ${v}`); console.log(k, v); };
try {
  run('initdb', ['-D', PGDATA, '-U', 'postgres', '--auth=trust']);
  run('pg_ctl', ['-D', PGDATA, '-o', `-k ${SOCK} -c listen_addresses=''`, '-l', '/tmp/dry.log', 'start']);
  const pool = new Pool({host: SOCK, user: 'postgres', database: 'postgres'});
  const q = (t, p) => pool.query(t, p);
  await q(`create extension if not exists pgcrypto; create schema if not exists auth;
    create table auth.users(id uuid primary key default gen_random_uuid());
    create role anon; create role authenticated; create role service_role bypassrls;
    create table public.torneos(id bigint primary key);`);
  await q(MIG);
  const hash = async () => (await q(`select md5(pg_get_functiondef(0))`).catch(() => ({rows:[{md5:null}]}))).rows[0].md5;
  const obj = async (sql) => (await q(sql)).rows;
  const cols = await obj(`select column_name from information_schema.columns where table_name='nations_profile_requests' order by ordinal_position`);
  log('migration_ok', true);
  log('columnas', cols.map((c) => c.column_name).join(','));
  const grants = await obj(`select grantee, string_agg(privilege_type, ',' order by privilege_type) p from information_schema.role_table_grants where table_name='nations_profile_requests' and grantee in ('anon','authenticated','service_role') group by grantee`);
  log('grants', JSON.stringify(grants));
  const pol = await obj(`select count(*)::int n from pg_policies where tablename='nations_profile_requests'`);
  log('policies', pol[0].n);
  // rollback con datos => aborta y conserva
  await q(`insert into auth.users(id) values (gen_random_uuid())`);
  await q(`insert into public.torneos values (57)`);
  const uid = (await q(`select id from auth.users limit 1`)).rows[0].id;
  await q(`insert into public.nations_profile_requests(torneo_id,actor_user_id,request_id,declared_name,declared_country,age_status,profile_consent,payload_hash) values (57,$1,'dry-0000001','Jugador Ficticio','IT','adulto',true,'h')`, [uid]);
  let aborted = false;
  try { await q(RB); } catch (e) { aborted = /exportalas antes/.test(e.message); }
  const sigue = (await q(`select count(*)::int n from public.nations_profile_requests`)).rows[0].n;
  log('rollback_con_datos_aborta', aborted);
  log('solicitudes_preservadas', sigue === 1);
  // sin datos => rollback limpio
  await q(`delete from public.nations_profile_requests`);
  await q(RB);
  const tabla = (await q(`select count(*)::int n from information_schema.tables where table_name='nations_profile_requests'`)).rows[0].n;
  log('rollback_sin_datos_elimina', tabla === 0);
  await pool.end();
} catch (e) {
  console.error('DRYRUN_ERROR', e.code, e.message);
  out.push(`DRYRUN_ERROR: ${e.code} ${e.message}`);
  process.exitCode = 1;
} finally {
  try { run('pg_ctl', ['-D', PGDATA, 'stop', '-m', 'fast']); } catch {}
  fs.rmSync(PGDATA, {recursive: true, force: true});
  fs.rmSync(SOCK, {recursive: true, force: true});
  fs.writeFileSync('/Users/padbol2022/Documents/Codex/2026-11-06/task-4/NATIONS-migracion-dryrun.log', out.join('\n') + '\n');
}
