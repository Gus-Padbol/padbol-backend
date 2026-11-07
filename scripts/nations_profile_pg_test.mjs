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
let pass = 0; const total = 21;

try {
  await sql(`create extension if not exists pgcrypto;
    create schema if not exists auth;
    create table auth.users(id uuid primary key default gen_random_uuid(), email text, email_confirmed_at timestamptz);
    create or replace function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('test.actor', true),'')::uuid $$;
    create role anon; create role authenticated; create role service_role bypassrls;`);
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
  const PART2 = '00000000-0000-4000-8000-0000000000e5';
  await sql(`insert into auth.users(id,email,email_confirmed_at) values ('${A}','a@test.invalid',now()),('${ADM}','adm@test.invalid',now()),('${B}','b@test.invalid',now())`);
  await sql(`insert into public.user_roles(id,user_id,role) values (1,'${ADM}','super_admin')`);
  await sql(`insert into public.sedes(id,nombre,pais,ciudad,timezone,tipo_sede) values (9,'Sede Ficticia','Italia','Napoli','Europe/Rome','torneo')`);
  await sql(`insert into public.torneos(id,nombre,sede_id,deporte,modalidad_plantel,estado,fecha_inicio,fecha_fin,horas_revelar_equipos)
    values (57,'V Padbol Nations Cup',9,'padbol','selecciones','inscripcion','2026-11-20','2026-11-22',48)`);
  await sql(`insert into public.nations_activation_events(torneo_id,slug,title,enabled,roster_publication_approved)
    values (57,'nations-cup-napoli-2026','V Padbol Nations Cup',true,false)`);
  await sql(`insert into public.torneo_participantes(id,torneo_id,sede_id,nombre,tipo_identidad,origen,estado_vinculacion,creado_por)
    values ('${PART}',57,9,'Jugador Ficticio','generico','club','sin_cuenta','${ADM}'),
           ('${PART2}',57,9,'Jugador Ficticio Dos','generico','club','sin_cuenta','${ADM}')`);
  await sql(`insert into public.nations_activation_participants(participante_id,torneo_id,country,row_key,minor,age_status)
    values ('${PART}',57,'IT','rk-a',false,'desconocido'),
           ('${PART2}',57,'ES','rk-b',false,'desconocido')`);
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

  // ---------- Fase 1e: 8 grupos ----------
  const E = '00000000-0000-4000-8000-0000000000e6';
  const F = '00000000-0000-4000-8000-0000000000f7';
  const H = '00000000-0000-4000-8000-0000000000a9';
  const I = '00000000-0000-4000-8000-0000000000b9';
  const J = '00000000-0000-4000-8000-0000000000c9';
  const K = '00000000-0000-4000-8000-0000000000d9';
  const L = '00000000-0000-4000-8000-0000000000ea';
  await sql(`insert into auth.users(id,email,email_confirmed_at) values ('${E}','e@test.invalid',now()),('${F}','f@test.invalid',now()),('${H}','h@test.invalid',now()),('${I}','i@test.invalid',now()),('${J}','j@test.invalid',now()),('${K}','k@test.invalid',now()),('${L}','l@test.invalid',now())`);
  await sql(`insert into public.torneos(id,nombre,sede_id,deporte,modalidad_plantel,estado,fecha_inicio,fecha_fin,horas_revelar_equipos)
    values (58,'Evento Deshabilitado',9,'padbol','selecciones','inscripcion','2026-11-20','2026-11-22',48)
    on conflict (id) do nothing`);
  await sql(`insert into public.nations_activation_events(torneo_id,slug,title,enabled,roster_publication_approved)
    values (58,'evento-deshabilitado','Evento',false,false) on conflict (slug) do nothing`);

  const actorE = {id: E, email_confirmed_at: '2026-01-01'};
  const actorF = {id: F, email_confirmed_at: '2026-01-01'};
  const actorH = {id: H, email_confirmed_at: '2026-01-01'};
  const actorI = {id: I, email_confirmed_at: '2026-01-01'};
  const actorJ = {id: J, email_confirmed_at: '2026-01-01'};
  const S = 'nations-cup-napoli-2026';
  const P3 = '00000000-0000-4000-8000-0000000000f9';
  await sql(`insert into public.torneo_participantes(id,torneo_id,sede_id,nombre,tipo_identidad,origen,estado_vinculacion,creado_por)
    values ('${P3}',57,9,'Jugador Ficticio C','generico','club','sin_cuenta','${ADM}') on conflict (id) do nothing`);
  await sql(`insert into public.nations_activation_participants(participante_id,torneo_id,country,row_key,minor,age_status)
    values ('${P3}',57,'IT','rk-c',false,'adulto') on conflict (participante_id) do nothing`);
  const idOf = async (rid) => (await sql(`select id from public.nations_profile_requests where request_id='${rid}'`)).rows[0]?.id;
  const countRows = async () => (await sql(`select count(*)::int n from public.nations_profile_requests`)).rows[0].n;

  async function group(nombre, fn) {
    try { await fn(); console.log(`PASS | ${nombre}`); pass++; }
    catch (e) { console.log(`FAIL | ${nombre} | ${e.code || e.message} | ${(e.stack||'').split('\n')[1]?.trim()}`); }
  }

  // GRUPO 1: unknown approve => 409
  await group('G1 unknown approve => 409', async () => {
    const r = await svc.submit(S, actorE, {request_id:'g1-unknown1', declared_name:'Jugador Ficticio', declared_country:'IT', age_status:'desconocido', profile_consent:true});
    assert.equal(r.status, 'pendiente');
    const id = await idOf('g1-unknown1');
    await assert.rejects(svc.review(S, admin, id, {decision:'aprobar', identity_verified:true, note:'Revision central verificada del caso G1', matched_participante_id: PART}), /AGE_NOT_VERIFIED/);
  });

  // GRUPO 2: menor sin guardian central 409; con guardian+identidad+nota => exito
  await group('G2 menor sin guardian_verified => 409 y con revision => exito', async () => {
    await svc.submit(S, actorF, {request_id:'g2-menor01', declared_name:'Jugador Ficticio', declared_country:'ES', age_status:'menor', guardian_consent:true, profile_consent:true});
    const id = await idOf('g2-menor01');
    await assert.rejects(svc.review(S, admin, id, {decision:'aprobar', identity_verified:true, note:'Revision central de menor sin guardian verificado', matched_participante_id: PART2}), /GUARDIAN_CONSENT_REQUIRED/);
    const r = await svc.review(S, admin, id, {decision:'aprobar', identity_verified:true, guardian_verified:true, note:'Revision central de menor con guardian verificado', matched_participante_id: PART2});
    assert.equal(r.status, 'aprobada');
  });

  // GRUPO 3: mismo request mismo payload => receipt; payload cambiado => 409
  await group('G3 retry identico receipt y payload cambiado 409', async () => {
    const base3 = {request_id:'g3-stable01', declared_name:'Jugador Ficticio', declared_country:'IT', age_status:'adulto', profile_consent:true};
    const r1 = await svc.submit(S, actorH, base3);
    const r2 = await svc.submit(S, actorH, base3);
    assert.deepEqual(r1, r2);
    await assert.rejects(svc.submit(S, actorH, {...base3, declared_name:'Otro Nombre Ficticio'}), /REQUEST_CONFLICT/);
  });

  // GRUPO 4: UUID nuevo con solicitud activa => 409
  await group('G4 UUID nuevo con solicitud activa => 409 sin duplicar', async () => {
    const antes = await countRows();
    await assert.rejects(svc.submit(S, actorH, {request_id:'g4-nuevo001', declared_name:'Jugador Ficticio', declared_country:'IT', age_status:'adulto', profile_consent:true}), /REQUEST_CONFLICT/);
    assert.equal(await countRows(), antes);
  });

  // GRUPO 5: country ajeno y evento deshabilitado
  await group('G5 country mismatch y evento deshabilitado rechazan', async () => {
    await assert.rejects(svc.submit('evento-deshabilitado', actorI, {request_id:'g5-disabled1', declared_name:'Jugador Ficticio', declared_country:'IT', age_status:'adulto', profile_consent:true}), /EVENT_NOT_AVAILABLE/);
    const r = await svc.submit(S, actorJ, {request_id:'g5-country01', declared_name:'Jugador Ficticio C', declared_country:'ES', age_status:'adulto', profile_consent:true});
    assert.equal(r.status, 'pendiente');
    const id = await idOf('g5-country01');
    await assert.rejects(svc.review(S, admin, id, {decision:'aprobar', identity_verified:true, note:'Revision central con pais declarado distinto', matched_participante_id: P3}), /COUNTRY_MISMATCH/);
  });

  // GRUPO 6: carrera 2 actores 2 requests 1 participante (PART2 ya aprobado en G2 => usar PART? ya vinculado)
  await group('G6 carrera dos actores un participante: 1 exito y 1 conflicto', async () => {

    await sql(`insert into public.nations_profile_requests(torneo_id,actor_user_id,request_id,declared_name,declared_country,age_status,profile_consent,payload_hash,status)
      values (57,'${K}','g6-race-e1','Jugador Ficticio C','IT','adulto',true,'hash-e','pendiente'),
             (57,'${L}','g6-race-f1','Jugador Ficticio C','IT','adulto',true,'hash-f','pendiente')`);
    const idE = await idOf('g6-race-e1');
    const idF = await idOf('g6-race-f1');
    const res = await Promise.allSettled([
      svc.review(S, admin, idE, {decision:'aprobar', identity_verified:true, note:'Revision central carrera actor E valida', matched_participante_id: P3}),
      svc.review(S, admin, idF, {decision:'aprobar', identity_verified:true, note:'Revision central carrera actor F valida', matched_participante_id: P3}),
    ]);
    const ok = res.filter(x => x.status === 'fulfilled').length;
    assert.equal(ok, 1, 'debe haber exactamente un exito');
    const owner = (await sql(`select linked_user_id from public.torneo_participantes where id='${P3}'`)).rows[0].linked_user_id;
    assert.ok(owner === K || owner === L);
  });

  // G6b: carrera con 5 actores sobre el MISMO participante (determinista en cuanto a invariante)
  await group('G6b carrera 5 actores un participante: exactamente 1 vinculado', async () => {
    const P5 = '00000000-0000-4000-8000-0000000000fb';
    await sql(`insert into public.torneo_participantes(id,torneo_id,sede_id,nombre,tipo_identidad,origen,estado_vinculacion,creado_por)
      values ('${P5}',57,9,'Jugador Ficticio E','generico','club','sin_cuenta','${ADM}') on conflict (id) do nothing`);
    await sql(`insert into public.nations_activation_participants(participante_id,torneo_id,country,row_key,minor,age_status)
      values ('${P5}',57,'IT','rk-e',false,'adulto') on conflict (participante_id) do nothing`);
    const ids = [];
    for (let i = 0; i < 5; i++) {
      const uid = `00000000-0000-4000-8000-0000000000${i}1`;
      await sql(`insert into auth.users(id,email,email_confirmed_at) values ('${uid}','r${i}@test.invalid',now()) on conflict do nothing`);
      const rid = `g6b-race-${i}`;
      await sql(`insert into public.nations_profile_requests(torneo_id,actor_user_id,request_id,declared_name,declared_country,age_status,profile_consent,payload_hash,status)
        values (57,'${uid}','${rid}','Jugador Ficticio E','IT','adulto',true,'hash-${i}','pendiente')`);
      ids.push(rid);
    }
    const rowIds = [];
    for (const rid of ids) rowIds.push((await sql(`select id from public.nations_profile_requests where request_id='${rid}'`)).rows[0].id);
    const res = await Promise.allSettled(rowIds.map((rowId) => svc.review(S, admin, rowId, {
      decision: 'aprobar', identity_verified: true, note: 'Revision central carrera multiple valida', matched_participante_id: P5,
    })));
    const ok = res.filter((x) => x.status === 'fulfilled').length;
    const aprobadas = (await sql(`select count(*)::int n from public.nations_profile_requests where request_id like 'g6b-race-%' and status='aprobada'`)).rows[0].n;
    const dueños = (await sql(`select count(distinct linked_user_id)::int n from public.torneo_participantes where id='${P5}'`)).rows[0].n;
    assert.equal(ok, 1, 'exactamente una aprobacion debe tener exito');
    assert.equal(aprobadas, 1, 'exactamente una solicitud queda aprobada');
    assert.equal(dueños, 1, 'el participante queda con un unico dueño');
  });

  // GRUPO 10: edad canonica conocida distinta => AGE_MISMATCH (no sobreescribe)
  await group('G10 AGE_MISMATCH: canon adulto vs declarado menor', async () => {
    const P7 = '00000000-0000-4000-8000-0000000000fd';
    const H = '00000000-0000-4000-8000-0000000000e2';
    await sql(`insert into auth.users(id,email,email_confirmed_at) values ('${H}','h2@test.invalid',now()) on conflict do nothing`);
    await sql(`insert into public.torneo_participantes(id,torneo_id,sede_id,nombre,tipo_identidad,origen,estado_vinculacion,creado_por)
      values ('${P7}',57,9,'Jugador Ficticio H','generico','club','sin_cuenta','${ADM}') on conflict (id) do nothing`);
    await sql(`insert into public.nations_activation_participants(participante_id,torneo_id,country,row_key,minor,age_status)
      values ('${P7}',57,'IT','rk-h',false,'adulto') on conflict (participante_id) do nothing`);
    await sql(`insert into public.nations_profile_requests(torneo_id,actor_user_id,request_id,declared_name,declared_country,age_status,guardian_consent,profile_consent,payload_hash,status)
      values (57,'${H}','g10-edad-01','Jugador Ficticio H','IT','menor',true,true,'hash-edad','pendiente')`);
    const id = (await sql(`select id from public.nations_profile_requests where request_id='g10-edad-01'`)).rows[0].id;
    await assert.rejects(svc.review(S, admin, id, {decision:'aprobar', identity_verified:true, guardian_verified:true, note:'Revision central con edad contradictoria', matched_participante_id: P7}), /AGE_MISMATCH/);
    const age = (await sql(`select age_status from public.nations_activation_participants where participante_id='${P7}'`)).rows[0].age_status;
    assert.equal(age, 'adulto');
  });

  // GRUPO 9: BARRERA determinista de carrera (lock externo simula al primer actor)
  await group('G9 barrera: segundo actor con lock externo => PARTICIPANT_ALREADY_LINKED', async () => {
    const P6 = '00000000-0000-4000-8000-0000000000fc';
    const C = '00000000-0000-4000-8000-0000000000c1';
    const DD = '00000000-0000-4000-8000-0000000000d1';
    await sql(`insert into auth.users(id,email,email_confirmed_at) values ('${C}','c@test.invalid',now()),('${DD}','d@test.invalid',now()) on conflict do nothing`);
    await sql(`insert into public.torneo_participantes(id,torneo_id,sede_id,nombre,tipo_identidad,origen,estado_vinculacion,creado_por)
      values ('${P6}',57,9,'Jugador Ficticio F','generico','club','sin_cuenta','${ADM}') on conflict (id) do nothing`);
    await sql(`insert into public.nations_activation_participants(participante_id,torneo_id,country,row_key,minor,age_status)
      values ('${P6}',57,'IT','rk-f',false,'adulto') on conflict (participante_id) do nothing`);
    await sql(`insert into public.nations_profile_requests(torneo_id,actor_user_id,request_id,declared_name,declared_country,age_status,profile_consent,payload_hash,status)
      values (57,'${C}','g9-barrera','Jugador Ficticio F','IT','adulto',true,'hash-g9','pendiente')`);
    const rowId = (await sql(`select id from public.nations_profile_requests where request_id='g9-barrera'`)).rows[0].id;
    // Primer actor: mantiene el lock del participante y lo vincula a D antes de soltar.
    const holder = await pool.connect();
    await holder.query('BEGIN');
    await holder.query(`select id from public.torneo_participantes where id='${P6}' for update`);
    const actorC = {id: C, email_confirmed_at: '2026-01-01'};
    const pendiente = svc.review(S, admin, rowId, {decision:'aprobar', identity_verified:true, note:'Revision central bajo barrera determinista', matched_participante_id: P6});
    await holder.query(`update public.torneo_participantes set linked_user_id='${DD}', estado_vinculacion='vinculado' where id='${P6}'`);
    await holder.query('COMMIT');
    holder.release();
    await assert.rejects(pendiente, /PARTICIPANT_ALREADY_LINKED/);
    const aprobadas = (await sql(`select count(*)::int n from public.nations_profile_requests where request_id='g9-barrera' and status='aprobada'`)).rows[0].n;
    const dueno = (await sql(`select linked_user_id from public.torneo_participantes where id='${P6}'`)).rows[0].linked_user_id;
    assert.equal(aprobadas, 0);
    assert.equal(dueno, DD);
  });

  // GRUPO 9b: GRANT service_role permite operar; anon/auth siguen sin acceso
  await group('G9b service_role opera la tabla y anon/auth no', async () => {
    await sql(`insert into auth.users(id,email,email_confirmed_at) values ('00000000-0000-4000-8000-0000000000f1','svc@test.invalid',now()) on conflict do nothing`);
    const cliente = await pool.connect();
    try {
      await cliente.query('set role service_role');
      await cliente.query("insert into public.nations_profile_requests(torneo_id,actor_user_id,request_id,declared_name,declared_country,age_status,profile_consent,payload_hash,status) values (57,'00000000-0000-4000-8000-0000000000f1','g9b-svc-01','Jugador Ficticio G','IT','adulto',true,'hash-svc','pendiente')");
      const {rows} = await cliente.query("select count(*)::int n from public.nations_profile_requests where request_id='g9b-svc-01'");
      assert.equal(rows[0].n, 1);
    } finally { try { await cliente.query('reset role'); } catch {} cliente.release(); }
    for (const rol of ['anon','authenticated']) {
      const c2 = await pool.connect();
      try {
        await c2.query(`set role ${rol}`);
        await c2.query('select 1 from public.nations_profile_requests limit 1');
        assert.fail(`${rol} no deberia poder leer`);
      } catch (e) {
        assert.ok(e.code === '42501' || /permission denied/i.test(e.message));
      } finally { try { await c2.query('reset role'); } catch {} c2.release(); }
    }
  });

  // GRUPO 7: terminales no flipean (caso propio y determinista)
  await group('G7 approved/rejected terminales no flipean', async () => {
    const M = '00000000-0000-4000-8000-0000000000aa';
    const P4 = '00000000-0000-4000-8000-0000000000ba';
    await sql(`insert into auth.users(id,email,email_confirmed_at) values ('${M}','m@test.invalid',now()) on conflict do nothing`);
    await sql(`insert into public.torneo_participantes(id,torneo_id,sede_id,nombre,tipo_identidad,origen,estado_vinculacion,creado_por)
      values ('${P4}',57,9,'Jugador Ficticio D','generico','club','sin_cuenta','${ADM}') on conflict (id) do nothing`);
    await sql(`insert into public.nations_activation_participants(participante_id,torneo_id,country,row_key,minor,age_status)
      values ('${P4}',57,'IT','rk-d',false,'adulto') on conflict (participante_id) do nothing`);
    const actorM = {id: M, email_confirmed_at: '2026-01-01'};
    await svc.submit(S, actorM, {request_id:'g7-terminal', declared_name:'Jugador Ficticio D', declared_country:'IT', age_status:'adulto', profile_consent:true});
    const id = await idOf('g7-terminal');
    const ap = await svc.review(S, admin, id, {decision:'aprobar', identity_verified:true, note:'Revision central terminal del caso G7', matched_participante_id: P4});
    console.log('   G7 aprobada:', ap.status);
    await assert.rejects(svc.review(S, admin, id, {decision:'rechazar', note:'Intento de revertir aprobacion terminal'}), /REQUEST_ALREADY_REVIEWED/);
    await assert.rejects(svc.review(S, admin, id, {decision:'aprobar', identity_verified:true, note:'Intento de reaprobar terminal', matched_participante_id: P4}), /REQUEST_ALREADY_REVIEWED/);
    // rechazada terminal
    const M2 = '00000000-0000-4000-8000-0000000000ca';
    await sql(`insert into auth.users(id,email,email_confirmed_at) values ('${M2}','m2@test.invalid',now()) on conflict do nothing`);
    const actorM2 = {id: M2, email_confirmed_at: '2026-01-01'};
    await svc.submit(S, actorM2, {request_id:'g7-rechazo', declared_name:'Jugador Ficticio D', declared_country:'IT', age_status:'adulto', profile_consent:true});
    const id2 = await idOf('g7-rechazo'); console.log('   G7 id2:', Boolean(id2));
    await svc.review(S, admin, id2, {decision:'rechazar', note:'Rechazo terminal por identidad no coincidente'});
    // Terminal: no se revierte (el guard de estado o el de vinculacion lo impiden).
    await assert.rejects(svc.review(S, admin, id2, {decision:'aprobar', identity_verified:true, note:'Intento de aprobar rechazo terminal', matched_participante_id: P4}), /REQUEST_ALREADY_REVIEWED|PARTICIPANT_ALREADY_LINKED/);
  });

  // GRUPO 8: RLS directo denegado, API own funciona y DTO sin note
  await group('G8 RLS anon/auth denegado y DTO sin review_note', async () => {
    const deny = async (role) => {
      const client = await pool.connect();
      try { await client.query(`set role ${role}`); await client.query('select * from public.nations_profile_requests limit 1'); return false; }
      catch (e) { return e.code === '42501' || /permission denied/i.test(e.message); }
      finally { try { await client.query('reset role'); } catch {} client.release(); }
    };
    assert.equal(await deny('anon'), true, 'anon no debe leer la tabla');
    assert.equal(await deny('authenticated'), true, 'authenticated no debe leer la tabla');
    const own = await svc.ownStatus(S, actorE);
    assert.equal(JSON.stringify(own).includes('review_note'), false);
    assert.ok(Array.isArray(own.requests));
  });

  // ---------- INTEGRAL HTTP real (router + servicio + PG) ----------
  {
    const app = express(); app.use(express.json());
    registerNationsActivationRoutes(app, {pool, authUserFromBearer: async (req) => {
      const who = String(req.headers['x-fixture-user'] || '');
      if (who === 'a') return {id: A, email_confirmed_at: '2026-01-01'};
      if (who === 'b') return {id: B, email_confirmed_at: '2026-01-01'};
      if (who === 'adm') return {id: ADM, email_confirmed_at: '2026-01-01'};
      if (who === 'c') return {id: '00000000-0000-4000-8000-0000000000c5', email_confirmed_at: '2026-01-01'};
      if (who === 'c6') return {id: '00000000-0000-4000-8000-0000000000c6', email_confirmed_at: '2026-01-01'};
      if (who === 'c7') return {id: '00000000-0000-4000-8000-0000000000c7', email_confirmed_at: '2026-01-01'};
      return null;
    }});
    const server = http.createServer(app);
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const call = (path, opts = {}) => fetch(base + path, opts).then(async (res) => ({status: res.status, body: await res.json().catch(() => null)}));
    try {
      await group('I1 submit -> own -> cola ven (privacidad)', async () => {
        const C5 = '00000000-0000-4000-8000-0000000000c5';
        await sql(`insert into auth.users(id,email,email_confirmed_at) values ('${C5}','c5@test.invalid',now()) on conflict do nothing`);
        const post = await call('/api/nations-activation/events/nations-cup-napoli-2026/profile-request', {
          method: 'POST', headers: {'Content-Type': 'application/json', 'x-fixture-user': 'c'},
          body: JSON.stringify({request_id: 'i1-http-0001', declared_name: 'Jugador Ficticio I', declared_country: 'IT', age_status: 'adulto', profile_consent: true}),
        });
        assert.equal(post.status, 200); assert.equal(post.body.status, 'pendiente');
        const own = await call('/api/nations-activation/events/nations-cup-napoli-2026/profile-request', {headers: {'x-fixture-user': 'c'}});
        assert.equal(own.body.requests.length, 1);
        const otro = await call('/api/nations-activation/events/nations-cup-napoli-2026/profile-request', {headers: {'x-fixture-user': 'a'}});
        assert.ok(otro.body.requests.every(r => r.request_id !== 'i1-http-0001'));
        const cola = await call('/api/admin/nations-activation/events/nations-cup-napoli-2026/profile-requests', {headers: {'x-fixture-user': 'adm'}});
        assert.equal(cola.status, 200);
        assert.ok(cola.body.requests.some(r => r.request_id === 'i1-http-0001'));
      });

      await group('I2 approve HTTP y /me devuelve persona propia', async () => {
        const C5 = '00000000-0000-4000-8000-0000000000c5';
        const P8 = '00000000-0000-4000-8000-0000000000f8';
        await sql(`insert into public.torneo_participantes(id,torneo_id,sede_id,nombre,tipo_identidad,origen,estado_vinculacion,creado_por)
          values ('${P8}',57,9,'Jugador Ficticio I','generico','club','sin_cuenta','${ADM}') on conflict (id) do nothing`);
        await sql(`insert into public.nations_activation_participants(participante_id,torneo_id,country,row_key,minor,age_status)
          values ('${P8}',57,'IT','rk-i',false,'adulto') on conflict (participante_id) do nothing`);
        await sql(`insert into public.torneo_participante_equipos(torneo_id,participante_id,equipo_id) values (57,'${P8}',280) on conflict do nothing`);
        await sql(`update public.nations_profile_requests set declared_name='Jugador Ficticio I' where request_id='i1-http-0001'`);
        const id = (await sql(`select id from public.nations_profile_requests where request_id='i1-http-0001'`)).rows[0].id;
        const rev = await call(`/api/admin/nations-activation/events/nations-cup-napoli-2026/profile-requests/${id}/review`, {
          method: 'POST', headers: {'Content-Type': 'application/json', 'x-fixture-user': 'adm'},
          body: JSON.stringify({decision: 'aprobar', note: 'Evidencia suficiente verificada centralmente', identity_verified: true, matched_participante_id: P8}),
        });
        assert.equal(rev.status, 200);
        const me = await call('/api/nations-activation/events/nations-cup-napoli-2026/me', {headers: {'x-fixture-user': 'c'}});
        assert.equal(me.status, 200);
        assert.ok(me.body.profile, 'me debe devolver el perfil propio');
        assert.equal(String(me.body.profile.participantId), P8);
        const ajeno = await call('/api/nations-activation/events/nations-cup-napoli-2026/me', {headers: {'x-fixture-user': 'a'}});
        assert.equal(ajeno.body.profile, null, 'otro actor no ve perfil ajeno');
      });

      await group('I3 rechazo HTTP y nueva solicitud con id nuevo', async () => {
        const post = await call('/api/nations-activation/events/nations-cup-napoli-2026/profile-request', {
          method: 'POST', headers: {'Content-Type': 'application/json', 'x-fixture-user': 'c'},
          body: JSON.stringify({request_id: 'i3-rechaz-01', declared_name: 'Jugador Ficticio I', declared_country: 'IT', age_status: 'adulto', profile_consent: true}),
        });
        assert.equal(post.status, 200);
        const id = (await sql(`select id from public.nations_profile_requests where request_id='i3-rechaz-01'`)).rows[0].id;
        const rev = await call(`/api/admin/nations-activation/events/nations-cup-napoli-2026/profile-requests/${id}/review`, {
          method: 'POST', headers: {'Content-Type': 'application/json', 'x-fixture-user': 'adm'},
          body: JSON.stringify({decision: 'rechazar', note: 'Rechazo con evidencia insuficiente en nomina'}),
        });
        assert.equal(rev.status, 200);
        const nueva = await call('/api/nations-activation/events/nations-cup-napoli-2026/profile-request', {
          method: 'POST', headers: {'Content-Type': 'application/json', 'x-fixture-user': 'c'},
          body: JSON.stringify({request_id: 'i3-nueva-002', declared_name: 'Jugador Ficticio I', declared_country: 'IT', age_status: 'adulto', profile_consent: true}),
        });
        assert.equal(nueva.status, 200);
        assert.equal(nueva.body.status, 'pendiente');
      });

      await group('I4 unknown y menor por HTTP', async () => {
        const C6 = '00000000-0000-4000-8000-0000000000c6';
        await sql(`insert into auth.users(id,email,email_confirmed_at) values ('${C6}','c6@test.invalid',now()) on conflict do nothing`);
        const unk = await call('/api/nations-activation/events/nations-cup-napoli-2026/profile-request', {
          method: 'POST', headers: {'Content-Type': 'application/json', 'x-fixture-user': 'c6'},
          body: JSON.stringify({request_id: 'i4-unknown-1', declared_name: 'Jugador Ficticio U', declared_country: 'IT', age_status: 'desconocido', profile_consent: true}),
        });
        assert.equal(unk.status, 200);
        const idU = (await sql(`select id from public.nations_profile_requests where request_id='i4-unknown-1'`)).rows[0].id;
        const revU = await call(`/api/admin/nations-activation/events/nations-cup-napoli-2026/profile-requests/${idU}/review`, {
          method: 'POST', headers: {'Content-Type': 'application/json', 'x-fixture-user': 'adm'},
          body: JSON.stringify({decision: 'aprobar', note: 'Intento de aprobar edad desconocida', identity_verified: true, matched_participante_id: PART2}),
        });
        assert.equal(revU.status, 409);
        const C7 = '00000000-0000-4000-8000-0000000000c7';
        await sql(`insert into auth.users(id,email,email_confirmed_at) values ('${C7}','c7@test.invalid',now()) on conflict do nothing`);
        const men = await call('/api/nations-activation/events/nations-cup-napoli-2026/profile-request', {
          method: 'POST', headers: {'Content-Type': 'application/json', 'x-fixture-user': 'c7'},
          body: JSON.stringify({request_id: 'i4-menor-001', declared_name: 'Jugador Ficticio M', declared_country: 'IT', age_status: 'menor', guardian_consent: true, profile_consent: true}),
        });
        assert.equal(men.status, 200);
      });
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
