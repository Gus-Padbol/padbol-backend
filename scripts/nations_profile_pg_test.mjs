/** Fase 1c (2 casos): servicio REAL sobre PostgreSQL local aislado. */
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createNationsProfileRequestsService} from '../lib/nationsProfileRequests.js';
import express from 'express';
import http from 'node:http';
import {registerNationsActivationRoutes} from '../routes/nationsActivation.js';

const require = createRequire(import.meta.url);
const {Pool} = require('pg');

const PGDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'npg-'));
const SOCK = fs.mkdtempSync(path.join(os.tmpdir(), 'nsk-'));
const run = (cmd, args) => execFileSync(cmd, args, {encoding: 'utf8'});
function cleanup() {
  try { run('pg_ctl', ['-D', PGDATA, 'stop', '-m', 'fast']); } catch {}
  fs.rmSync(PGDATA, {recursive: true, force: true});
  fs.rmSync(SOCK, {recursive: true, force: true});
}

run('initdb', ['-D', PGDATA, '-U', 'postgres', '--auth=trust']);
run('pg_ctl', ['-D', PGDATA, '-o', `-k ${SOCK} -c listen_addresses=''`, '-l', '/tmp/npg1c.log', 'start']);

const pool = new Pool({host: SOCK, user: 'postgres', database: 'postgres', max: 4});
const sql = (t) => pool.query(t);
let pass = 0; const total = 5;

try {
  await sql(`create extension if not exists pgcrypto;
    create schema if not exists auth;
    create table auth.users(id uuid primary key default gen_random_uuid(), email text, email_confirmed_at timestamptz);
    create or replace function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('test.actor', true),'')::uuid $$;
    create role anon; create role authenticated; create role service_role;`);
  await sql(`create or replace function public.uuid_generate_v4() returns uuid language sql volatile as $$ select gen_random_uuid() $$;
    create or replace function public.participante_plantel_congelado(uuid) returns boolean language sql stable as $$ select false $$;
    create or replace function public.torneo_inscripcion_fecha_vigente(date,bigint,jsonb) returns boolean language sql stable as $$ select true $$;`);
  await sql(fs.readFileSync(new URL('../sql/migrations/rpc_schema_real.sql', import.meta.url), 'utf8'));
  await sql(fs.readFileSync(new URL('../sql/migrations/20261016140000_tournament_generic_participants.sql', import.meta.url), 'utf8'));
  await sql(fs.readFileSync(new URL('../sql/migrations/20261107150000_nations_profile_requests.sql', import.meta.url), 'utf8'));

  const A = '00000000-0000-4000-8000-0000000000a1';
  const ADM = '00000000-0000-4000-8000-0000000000c3';
  const B = '00000000-0000-4000-8000-0000000000b2';
  const PART = '00000000-0000-4000-8000-0000000000d4';
  await sql(`insert into auth.users(id,email,email_confirmed_at) values ('${A}','a@test.invalid',now()),('${ADM}','adm@test.invalid',now()),('${B}','b@test.invalid',now())`);
  await sql(`insert into public.user_roles(id,user_id,role) values (1,'${ADM}','super_admin')`);
  await sql(`insert into public.sedes(id,nombre,pais,ciudad,timezone,tipo_sede) values (9,'Sede Ficticia','Italia','Napoli','Europe/Rome','torneo')`);
  await sql(`insert into public.torneos(id,nombre,sede_id,deporte,modalidad_plantel,estado,fecha_inicio,fecha_fin,horas_revelar_equipos)
    values (57,'V Padbol Nations Cup',9,'padbol','selecciones','inscripcion','2026-11-20','2026-11-22',48)`);
  await sql(`insert into public.nations_activation_events(torneo_id,slug,title,enabled,roster_publication_approved)
    values (57,'nations-cup-napoli-2026','V Padbol Nations Cup',true,false)`);
  await sql(`insert into public.torneo_participantes(id,torneo_id,sede_id,nombre,tipo_identidad,origen,estado_vinculacion,creado_por)
    values ('${PART}',57,9,'Jugador Ficticio','generico','club','sin_cuenta','${ADM}')`);
  await sql(`insert into public.nations_activation_participants(participante_id,torneo_id,country,row_key,minor,age_status)
    values ('${PART}',57,'IT','rk-a',false,'desconocido')`);
  await sql(`insert into public.equipos(id,torneo_id,sede_id,nombre,jugadores,cupo_maximo,inscripcion_estado)
    values (280,57,9,'Italia','[]'::jsonb,8,'confirmado')`);
  await sql(`insert into public.torneo_participante_equipos(torneo_id,participante_id,equipo_id) values (57,'${PART}',280)`);

  const svc = createNationsProfileRequestsService({pool});
  const actor = {id: A, email_confirmed_at: '2026-01-01'};
  const admin = {id: ADM, email_confirmed_at: '2026-01-01'};
  const actorB = {id: B, email_confirmed_at: '2026-01-01'};

  await s1();
  async function s1() {
    const r = await svc.submit('nations-cup-napoli-2026', actor, {
      request_id: 'req-unknown01', declared_name: 'Jugador Ficticio', declared_country: 'IT',
      age_status: 'desconocido', profile_consent: true});
    const canon = (await sql(`select linked_user_id, estado_vinculacion from public.torneo_participantes where id='${PART}'`)).rows[0];
    assert.equal(r.status, 'pendiente');
    assert.equal(canon.linked_user_id, null);
    assert.equal(canon.estado_vinculacion, 'sin_cuenta');
    console.log('PASS | 1) submit desconocido => pendiente, canon intacto'); pass++;
  }

  {
    const r2 = await svc.submit('nations-cup-napoli-2026', actorB, {
      request_id: 'req-adult01', declared_name: 'Jugador Ficticio', declared_country: 'IT',
      age_status: 'adulto', profile_consent: true});
    const rowId = (await sql(`select id from public.nations_profile_requests where request_id='req-adult01'`)).rows[0].id;
    await svc.review('nations-cup-napoli-2026', admin, rowId, {
      decision: 'aprobar', identity_verified: true, note: 'Verificado contra nomina oficial del evento',
      matched_participante_id: PART});
    const canon = (await sql(`select linked_user_id, estado_vinculacion from public.torneo_participantes where id='${PART}'`)).rows[0];
    const link = (await sql(`select cuenta_user_id from public.torneo_participante_equipos where participante_id='${PART}' and torneo_id=57`)).rows[0];
    const age = (await sql(`select age_status, minor from public.nations_activation_participants where participante_id='${PART}'`)).rows[0];
    const req = (await sql(`select status, matched_participante_id from public.nations_profile_requests where request_id='req-adult01'`)).rows[0];
    assert.equal(r2.status, 'pendiente');
    assert.equal(canon.linked_user_id, B);
    assert.equal(canon.estado_vinculacion, 'vinculado');
    assert.equal(link.cuenta_user_id, B);
    assert.equal(age.age_status, 'adulto'); assert.equal(age.minor, false);
    assert.equal(req.status, 'aprobada'); assert.equal(req.matched_participante_id, PART);
    console.log('PASS | 2) review adulto => canon+equipo+age atomicos'); pass++;
  }

  {
    const app = express(); app.use(express.json());
    registerNationsActivationRoutes(app, {pool, authUserFromBearer: async (req) => {
      const who = String(req.headers['x-fixture-user'] || '');
      if (who === 'a') return {id: A, email_confirmed_at: '2026-01-01'};
      if (who === 'b') return {id: B, email_confirmed_at: '2026-01-01'};
      if (who === 'adm') return {id: ADM, email_confirmed_at: '2026-01-01'};
      return null;
    }});
    const server = http.createServer(app);
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      // actor proviene de auth, no del body (body intenta suplantar a B)
      const r = await fetch(`${base}/api/nations-activation/events/nations-cup-napoli-2026/profile-request`, {
        method: 'POST', headers: {'Content-Type': 'application/json', 'x-fixture-user': 'b'},
        body: JSON.stringify({request_id: 'req-http0001', declared_name: 'Jugador Ficticio', declared_country: 'IT', age_status: 'desconocido', profile_consent: true, actor_user_id: A})
      });
      const body = await r.json();
      const reqRow = (await sql(`select actor_user_id from public.nations_profile_requests where request_id='req-http0001'`)).rows[0];
      assert.equal(r.status, 200);
      assert.equal(reqRow.actor_user_id, B, 'el actor debe salir de auth, no del body');
      assert.equal(JSON.stringify(body).includes('Jugador'), false);
      console.log('PASS | 3) HTTP actor desde auth, body ignorado'); pass++;

      // own-only: A no ve la solicitud de B
      const own = await fetch(`${base}/api/nations-activation/events/nations-cup-napoli-2026/profile-request`, {headers: {'x-fixture-user': 'a'}});
      const ownBody = await own.json();
      const ids = ownBody.requests.map(x => x.request_id);
      assert.equal(ids.includes('req-http0001'), false, 'A no debe ver la solicitud de B');
      assert.equal(ids.every(id => id === 'req-unknown01'), true);
      console.log('PASS | 4) own-only: A solo ve su solicitud'); pass++;

      // no admin => 403 en la cola central
      const deny = await fetch(`${base}/api/admin/nations-activation/events/nations-cup-napoli-2026/profile-requests`, {headers: {'x-fixture-user': 'a'}});
      assert.equal(deny.status, 403);
      console.log('PASS | 5) no-admin 403 en cola central'); pass++;
    } finally { server.close(); }
  }
} catch (error) {
  console.error('FAIL |', error.code, error.message, '|', (error.where||'').slice(0,120));
} finally {
  await pool.end().catch(() => {});
  cleanup();
  console.log(`RESUMEN ${pass}/${total}`);
  process.exit(pass === total ? 0 : 1);
}
