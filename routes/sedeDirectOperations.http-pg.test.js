// LOCAL ONLY: owned PG17 Unix-socket cluster from the accepted QA026 fixture.
// Actual mounted HTTP handler + real pgPool; Auth/Twilio are explicit fakes.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import {once} from 'node:events';
import express from 'express';
import pg from 'pg';
import {start} from '../lib/nextGenerationUuid026.fixture.mjs';
import {mountCommercialReleaseRoutes} from './commercialRelease.js';
const A='00000000-0000-4000-8000-0000000000a1';
const B='00000000-0000-4000-8000-0000000000b2';
const KEY1='11111111-1111-4111-8111-111111111111';
const KEY2='22222222-2222-4222-8222-222222222222';
const KEY3='33333333-3333-4333-8333-333333333333';
const KEY4='44444444-4444-4444-8444-444444444444';
const body=(over={})=>({nombre:'Synthetic Direct',cantidad_canchas:2,direccion:'Fixture 123',ciudad:'Rosario',provincia:'Santa Fe',pais:'Argentina',horario_apertura:'09:00',horario_cierre:'22:00',precio_base:1000,moneda:'ARS',whatsapp:'+5493415550000',email_contacto:'club@fixture.invalid',licenciatario_nombre:'Synthetic Owner',licenciatario_email:'owner@fixture.invalid',licenciatario_telefono:'+5493415550001',licenciatario_pais:'Argentina',operation_key:KEY1,...over});
test('keyed direct alta: durable replay, cancel, concurrency and fail-closed boundaries', {timeout:120000}, async () => {
 let fx, pool, server, serverNoPool, serverNoSchema, poolNoSchema, authCalls = 0, authGate = null, authEntered = null;
 let authMode = 'new';
 const auth = async ({email}) => {
   authCalls += 1;
   if (authEntered) authEntered();
   if (authGate) await authGate;
   if (authMode === 'existing') return {data: null, error: {code: 'email_exists', message: 'exists'}};
   return {data: {user: {id: crypto.randomUUID(), email}}, error: null};
 };
 const supabase = {auth: {admin: {createUser: auth}}};
 const appFor = (p) => {
   const app = express(); app.use(express.json({limit: '1mb'}));
   mountCommercialReleaseRoutes(app, {supabaseAdmin: supabase, runtime: {outboundDeliveryEnabled: false},
     authUserFromBearer: async (req) => {
       const token = String(req.headers.authorization || '').replace('Bearer ', '');
       if (token === 'A') return {id: A, email: 'actor@fixture.invalid'};
       if (token === 'B') return {id: B, email: 'other@fixture.invalid'};
       return null;
     }, assertSuperAdminReq: async () => {}, adminListScopeFromRequest: async () => null,
     sedesPermitidasPorScope: async () => ({sedes: []}), pgPool: p});
   return app;
 };
 const call = async (base, method, path, actor, payload) => {
   const response = await fetch(`${base}${path}`, {method, headers: {'content-type': 'application/json', authorization: `Bearer ${actor}`}, ...(payload ? {body: JSON.stringify(payload)} : {})});
   return {status: response.status, body: await response.json()};
 };
 const reset = async () => {
   await pool.query('delete from public.sede_direct_operations');
   await pool.query('delete from public.user_roles');
   await pool.query('delete from public.organizacion_sedes');
   await pool.query('delete from public.sedes where id > 3');
   await pool.query('insert into auth.users(id) values($1),($2) on conflict (id) do nothing', [A, B]);
   await pool.query("insert into public.user_roles(user_id,email,role,alcance) values($1,'actor@fixture.invalid','super_admin','global'),($2,'other@fixture.invalid','super_admin','global')", [A, B]);
   authCalls = 0; authGate = null; authEntered = null; authMode = 'new';
 };
 const holdAuth = () => {
   let entered; const wait = new Promise((resolve) => { entered = resolve; });
   let release; authGate = new Promise((resolve) => { release = resolve; });
   authEntered = () => entered();
   return {wait, release: () => { authGate = null; authEntered = null; release(); }};
 };
 const sedes = async (name) => Number((await pool.query('select count(*)::int n from public.sedes where nombre=$1', [name])).rows[0].n);
 try {
   fx = await start({install: false});
   pool = fx.pool;
   await pool.query(fs.readFileSync(new URL('../sql/candidates/20261124_sede_direct_operations056.sql', import.meta.url), 'utf8'));
   await pool.query(`create table public.organizacion_sedes(
     organizacion_id uuid not null references public.organizaciones(id) on delete cascade,
     sede_id bigint not null references public.sedes(id) on delete cascade,
     created_at timestamptz not null default now(),
     primary key (organizacion_id, sede_id), unique (sede_id))`);
   await pool.query("select setval('sedes_id_seq', coalesce((select max(id) from public.sedes),0)+1, false)");
   const app = appFor(pool); server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
   const base = `http://127.0.0.1:${server.address().port}`;

   // 1) create + replayed POST + status: same seat, no second auth.
   await reset();
   const created = await call(base, 'POST', '/api/admin/sedes-directa', 'A', body());
   assert.equal(created.status, 200, JSON.stringify(created.body));
   assert.equal(created.body.state, 'completed'); assert.equal(created.body.replayed, false);
   assert.equal(created.body.operation_key, KEY1); assert.ok(created.body.sede_id);
   assert.equal(authCalls, 1);
   const replay = await call(base, 'POST', '/api/admin/sedes-directa', 'A', body());
   assert.equal(replay.status, 200); assert.equal(replay.body.sede_id, created.body.sede_id);
   assert.equal(replay.body.replayed, true); assert.equal(authCalls, 1);
   assert.equal(await sedes('Synthetic Direct'), 1);
   const status = await call(base, 'GET', `/api/admin/sedes-directa/operaciones/${KEY1}`, 'A');
   assert.equal(status.status, 200); assert.equal(status.body.state, 'completed');
   assert.equal(status.body.receipt.sede_id, created.body.sede_id);
   const ledger = await pool.query('select receipt::text r, payload_digest d from public.sede_direct_operations');
   assert.equal(ledger.rowCount, 1);
   for (const secret of ['owner@fixture.invalid', '+5493415550001', 'Synthetic Owner', 'mp_access_token', 'temp_password']) assert.equal(ledger.rows[0].r.includes(secret), false, secret);
   assert.match(ledger.rows[0].d, /^[0-9a-f]{64}$/);

   // 2) invalid key / changed digest / distinct keys.
   await reset();
   const invalid = await call(base, 'POST', '/api/admin/sedes-directa', 'A', body({operation_key: 'not-a-uuid'}));
   assert.equal(invalid.status, 400); assert.equal(invalid.body.code, 'DIRECT_OPERATION_KEY_INVALID'); assert.equal(authCalls, 0);
   const first = await call(base, 'POST', '/api/admin/sedes-directa', 'A', body({operation_key: KEY2}));
   assert.equal(first.status, 200); assert.equal(authCalls, 1);
   const changed = await call(base, 'POST', '/api/admin/sedes-directa', 'A', body({operation_key: KEY2, precio_base: 2000}));
   assert.equal(changed.status, 409); assert.equal(changed.body.code, 'DIRECT_OPERATION_DIGEST_MISMATCH'); assert.equal(authCalls, 1);
   const distinct = await call(base, 'POST', '/api/admin/sedes-directa', 'A', body({operation_key: KEY3, nombre: 'Second Direct'}));
   assert.equal(distinct.status, 200); assert.notEqual(distinct.body.sede_id, first.body.sede_id);
   assert.equal(await sedes('Synthetic Direct'), 1); assert.equal(await sedes('Second Direct'), 1);

   // 3) unknown/foreign/revoked.
   await reset();
   const createdA = await call(base, 'POST', '/api/admin/sedes-directa', 'A', body());
   assert.equal(createdA.status, 200);
   assert.equal((await call(base, 'GET', `/api/admin/sedes-directa/operaciones/${crypto.randomUUID()}`, 'A')).status, 404);
   assert.equal((await call(base, 'GET', `/api/admin/sedes-directa/operaciones/${KEY1}`, 'B')).status, 404);
   await pool.query("update public.user_roles set role='admin_club' where user_id=$1", [A]);
   assert.equal((await call(base, 'GET', `/api/admin/sedes-directa/operaciones/${KEY1}`, 'A')).status, 403);
   assert.equal((await call(base, 'POST', '/api/admin/sedes-directa/operaciones/' + KEY1 + '/cancelar', 'A')).status, 403);
   await pool.query("update public.user_roles set role='super_admin', alcance='global' where user_id=$1", [A]);

   // 4) actor=licenciatario conflict and ambiguous role rows, before Auth.
   await reset();
   const conflict = await call(base, 'POST', '/api/admin/sedes-directa', 'A', body({operation_key: KEY3, licenciatario_email: 'actor@fixture.invalid'}));
   assert.equal(conflict.status, 409); assert.equal(conflict.body.code, 'DIRECT_ACTOR_ROLE_CONFLICT'); assert.equal(authCalls, 0);
   await pool.query("insert into public.user_roles(email,role,alcance) values('dup@fixture.invalid','admin_club','sede'),('dup@fixture.invalid','admin_club','sede')");
   const ambiguous = await call(base, 'POST', '/api/admin/sedes-directa', 'A', body({operation_key: KEY4, licenciatario_email: 'dup@fixture.invalid'}));
   assert.equal(ambiguous.status, 409); assert.equal(ambiguous.body.code, 'DIRECT_OPERATION_ROLE_AMBIGUOUS'); assert.equal(authCalls, 0);

   // 5) cancel while Auth awaits: late complete refuses and creates no seat.
   await reset();
   const gateCancel = holdAuth();
   const pendingCreate = call(base, 'POST', '/api/admin/sedes-directa', 'A', body({operation_key: KEY2, nombre: 'Cancel Held'}));
   await gateCancel.wait;
   const cancelled = await call(base, 'POST', `/api/admin/sedes-directa/operaciones/${KEY2}/cancelar`, 'A');
   assert.equal(cancelled.status, 200); assert.equal(cancelled.body.state, 'cancelled');
   gateCancel.release();
   const late = await pendingCreate;
   assert.equal(late.status, 409); assert.equal(late.body.code, 'DIRECT_OPERATION_CANCELLED');
   assert.equal(await sedes('Cancel Held'), 0);
   const cancelledStatus = await call(base, 'GET', `/api/admin/sedes-directa/operaciones/${KEY2}`, 'A');
   assert.equal(cancelledStatus.body.state, 'cancelled'); assert.equal(cancelledStatus.body.receipt, null);

   // 6) role revoked while Auth awaits: final complete 403, no business writes.
   await reset();
   const gateRevoke = holdAuth();
   const pendingRevoked = call(base, 'POST', '/api/admin/sedes-directa', 'A', body({operation_key: KEY3, nombre: 'Revoked Held'}));
   await gateRevoke.wait;
   await pool.query("update public.user_roles set role='admin_club' where user_id=$1", [A]);
   gateRevoke.release();
   const revoked = await pendingRevoked;
   assert.equal(revoked.status, 403); assert.equal(revoked.body.code, 'DIRECT_OPERATION_FORBIDDEN');
   assert.equal(await sedes('Revoked Held'), 0);
   const kept = await pool.query("select state from public.sede_direct_operations where actor_id=$1 and operation_key=$2", [A, KEY3]);
   assert.equal(kept.rows[0].state, 'prepared');
   await pool.query("update public.user_roles set role='super_admin', alcance='global' where user_id=$1", [A]);

   // 7) concurrent same key/digest: one seat, same id, observed PG lock wait.
   await reset();
   await pool.query(`create or replace function public.qa056_slow_seat() returns trigger language plpgsql as $$begin if new.nombre like 'Slow %' then perform pg_sleep(0.6); end if; return new; end$$;
     create trigger qa056_slow_seat before insert on public.sedes for each row execute function public.qa056_slow_seat();`);
   authMode = 'existing';
   const concurrentBody = body({operation_key: KEY1, nombre: 'Slow Concurrent'});
   const p1 = call(base, 'POST', '/api/admin/sedes-directa', 'A', concurrentBody);
   const p2 = call(base, 'POST', '/api/admin/sedes-directa', 'A', concurrentBody);
   let observedWait = false;
   for (let i = 0; i < 300; i += 1) {
     const waiting = (await pool.query("select count(*)::int n from pg_stat_activity where wait_event_type='Lock' and state='active' and query ilike '%sede_direct_operations%'")).rows[0].n;
     if (waiting > 0) { observedWait = true; break; }
     await new Promise((resolve) => setTimeout(resolve, 10));
   }
   const [c1, c2] = await Promise.all([p1, p2]);
   assert.equal(c1.status, 200, JSON.stringify(c1.body)); assert.equal(c2.status, 200, JSON.stringify(c2.body));
   assert.equal(c1.body.sede_id, c2.body.sede_id);
   assert.equal(await sedes('Slow Concurrent'), 1);
   assert.equal(observedWait, true, 'observed real PG row-lock wait');
   await pool.query('drop trigger qa056_slow_seat on public.sedes; drop function public.qa056_slow_seat();');

   // 8) pool unavailable / schema unavailable: typed 503 before Auth.
   await reset();
   serverNoPool = appFor(null).listen(0, '127.0.0.1'); await once(serverNoPool, 'listening');
   const noPool = await call(`http://127.0.0.1:${serverNoPool.address().port}`, 'POST', '/api/admin/sedes-directa', 'A', body());
   assert.equal(noPool.status, 503); assert.equal(noPool.body.code, 'DIRECT_DB_UNAVAILABLE'); assert.equal(authCalls, 0);
   await pool.query('create database no_ledger056');
   poolNoSchema = new pg.Pool({host: fx.pool.options.host, port: fx.pool.options.port, user: 'postgres', database: 'no_ledger056'});
   serverNoSchema = appFor(poolNoSchema).listen(0, '127.0.0.1'); await once(serverNoSchema, 'listening');
   const noSchema = await call(`http://127.0.0.1:${serverNoSchema.address().port}`, 'POST', '/api/admin/sedes-directa', 'A', body());
   assert.equal(noSchema.status, 503); assert.equal(noSchema.body.code, 'DIRECT_DB_UNAVAILABLE'); assert.equal(authCalls, 0);

   // 9) late DB failure rolls back seat/link/role; prepared row survives and retry commits once.
   await reset();
   await pool.query(`create or replace function public.qa056_late_fail() returns trigger language plpgsql as $$begin raise exception 'QA056_LATE_FAILURE'; end$$;
     create trigger qa056_late_fail before insert on public.sedes for each row execute function public.qa056_late_fail();`);
   const failed = await call(base, 'POST', '/api/admin/sedes-directa', 'A', body({operation_key: KEY4, nombre: 'Late Failed'}));
   assert.equal(failed.status, 500); assert.equal(await sedes('Late Failed'), 0);
   const held = await pool.query("select state from public.sede_direct_operations where actor_id=$1 and operation_key=$2", [A, KEY4]);
   assert.equal(held.rows[0].state, 'prepared');
   await pool.query('drop trigger qa056_late_fail on public.sedes; drop function public.qa056_late_fail();');
   const retried = await call(base, 'POST', '/api/admin/sedes-directa', 'A', body({operation_key: KEY4, nombre: 'Late Failed'}));
   assert.equal(retried.status, 200); assert.equal(retried.body.replayed, false);
   assert.equal(await sedes('Late Failed'), 1);
   console.log('PASS KEYED_DIRECT_ALTA_DURABLE');
 } finally {
   try { if (server) await new Promise((resolve) => { server.close(resolve); server.closeAllConnections?.(); }); } catch {}
   try { if (serverNoPool) await new Promise((resolve) => { serverNoPool.close(resolve); serverNoPool.closeAllConnections?.(); }); } catch {}
   try { if (serverNoSchema) await new Promise((resolve) => { serverNoSchema.close(resolve); serverNoSchema.closeAllConnections?.(); }); } catch {}
   try { if (poolNoSchema) await poolNoSchema.end(); } catch {}
   if (fx) await fx.stop();
 }
});
