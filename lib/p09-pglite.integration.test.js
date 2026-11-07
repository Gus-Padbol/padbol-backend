import assert from 'node:assert/strict';
import test from 'node:test';
import {PGlite} from '@electric-sql/pglite';
import {readFileSync} from 'node:fs';
import {createLeadAlertNotifier} from './crmLeadAlertNotifier.js';

const MIG = readFileSync(new URL('../sql/candidates/20261107200000_p09_alert_cycle_delivery.sql', import.meta.url), 'utf8');
const ID = '11111111-1111-4111-8111-111111111111';
const ADV = '22222222-2222-4222-8222-222222222222';

async function db() {
  const pg = new PGlite();
  await pg.exec(`create role anon; create role authenticated; create role service_role bypassrls;
    create table crm_commercial_cases(id uuid primary key, status text, assigned_user_id uuid, created_at timestamptz, conversation_id uuid, next_contact_at timestamptz, reminder_hours integer[] default array[24,8]);
    create table crm_commercial_form_cases(conversation_id uuid primary key, assigned_user_id uuid, created_at timestamptz, next_contact_at timestamptz, reminder_hours integer[] default array[24,8]);
    create table crm_commercial_team_activities(case_id uuid, case_type text, created_at timestamptz);
    create table crm_contacts(id uuid primary key, nombre text, pais text);
    create table crm_conversations(id uuid primary key, contact_id uuid, qualification_data jsonb);`);
  await pg.exec(MIG);
  return pg;
}
const pool = (pg) => ({async query(sql, params = []) { const r = await pg.query(sql, params); return {rows: r.rows, rowCount: r.rows.length}; }});

test('P09 PGlite: 25h abre recordatorio y repetir el mismo at no vuelve a notificar (recibo durable)', async () => {
  const pg = await db();
  await pg.query(`insert into crm_contacts values ($1,'Ana','AR')`, ['44444444-4444-4444-8444-444444444444']);
  await pg.query(`insert into crm_conversations values ($1,$2,'{}'::jsonb)`, ['55555555-5555-4555-8555-555555555555','44444444-4444-4444-8444-444444444444']);
  await pg.query(`insert into crm_commercial_cases values ($1,'open',$2, now() - interval '25 hours', $3)`, [ID, ADV, '55555555-5555-4555-8555-555555555555']);
  const at = new Date().toISOString();
  const p = pool(pg);
  await p.query('select public.crm_lead_alerts_sweep($1)', [at]);
  const rows = (await p.query(`select id, state, advisor_id from crm_lead_alerts`)).rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].state, 'recordatorio');
  const alerts = {async sweep() { await p.query('select public.crm_lead_alerts_sweep($1)', [at]); return {at}; }};
  const notified = [];
  const webPush = {async notify({userId, payload}) { notified.push(userId); return {sent: 1}; }};
  const run = createLeadAlertNotifier({pool: p, alerts, webPush});
  await run(); await run();
  assert.equal(notified.length, 1, 'recibo durable impide doble notificacion del mismo at');
});

test('P09 PGlite: tras resolver, el siguiente barrido abre ciclo 2', async () => {
  const pg = await db();
  await pg.query(`insert into crm_commercial_cases values ($1,'open',$2, now() - interval '25 hours', $3)`, [ID, ADV, '55555555-5555-4555-8555-555555555555']);
  const p = pool(pg);
  const t1 = new Date(Date.now() - 3600e3).toISOString();
  await p.query('select public.crm_lead_alerts_sweep($1)', [t1]);
  await p.query(`update crm_lead_alerts set resolved_at=now(), state='resuelta' where case_id=$1`, [ID]);
  const at2 = new Date().toISOString();
  await p.query('select public.crm_lead_alerts_sweep($1)', [at2]);
  const rows = (await p.query('select cycle, resolved_at from crm_lead_alerts order by cycle')).rows;
  assert.deepEqual(rows.map((r) => r.cycle), [1, 2]);
});

test('P09 PGlite: reasignacion resuelve la alerta del asesor anterior y abre una nueva', async () => {
  const pg = await db();
  const ADV2 = '33333333-3333-4333-8333-333333333333';
  await pg.query(`insert into crm_commercial_cases values ($1,'open',$2, now() - interval '25 hours', $3)`, [ID, ADV, '55555555-5555-4555-8555-555555555555']);
  const p = pool(pg);
  await p.query('select public.crm_lead_alerts_sweep($1)', [new Date(Date.now() - 3600e3).toISOString()]);
  await p.query('update crm_commercial_cases set assigned_user_id=$1 where id=$2', [ADV2, ID]);
  await p.query('select public.crm_lead_alerts_sweep($1)', [new Date().toISOString()]);
  const rows = (await p.query('select advisor_id, resolved_at from crm_lead_alerts order by created_at')).rows;
  assert.equal(rows[0].advisor_id, ADV);
  assert.ok(rows[0].resolved_at);
  assert.equal(rows.at(-1).advisor_id, ADV2);
});

test('P09 PGlite: 0h abre pendiente y 49h abre escalada', async () => {
  for (const [hours, expected] of [[0, 'pendiente'], [49, 'escalada']]) {
    const pg = await db();
    await pg.query(`insert into crm_commercial_cases(id,status,assigned_user_id,created_at) values ($1,'open',$2, now() - ($3 || ' hours')::interval)`, [ID, ADV, String(hours)]);
    const p = pool(pg);
    await p.query('select public.crm_lead_alerts_sweep($1)', [new Date().toISOString()]);
    const row = (await p.query('select state from crm_lead_alerts')).rows[0];
    assert.equal(row.state, expected, `${hours}h => ${expected}`);
  }
});

test('P09 PGlite: dos notifier concurrentes mismo at => un solo envio', async () => {
  const pg = await db();
  await pg.query(`insert into crm_contacts values ('44444444-4444-4444-8444-444444444444','Ana','AR')`);
  await pg.query(`insert into crm_conversations values ('55555555-5555-4555-8555-555555555555','44444444-4444-4444-8444-444444444444','{}'::jsonb)`);
  await pg.query(`insert into crm_commercial_cases(id,status,assigned_user_id,created_at,conversation_id) values ($1,'open',$2, now() - interval '25 hours','55555555-5555-4555-8555-555555555555')`, [ID, ADV]);
  const p = pool(pg);
  const at = new Date().toISOString();
  await p.query('select public.crm_lead_alerts_sweep($1)', [at]);
  let sent = 0;
  const webPush = {async notify(){ sent += 1; return {sent:1}; }};
  const alerts = {async sweep(){ return {at}; }};
  const a = createLeadAlertNotifier({pool:p, alerts, webPush});
  const b = createLeadAlertNotifier({pool:p, alerts, webPush});
  await Promise.all([a(), b()]);
  assert.equal(sent, 1, 'el recibo durable deduplica entre instancias');
});

test('P09 PGlite: fallo de sender libera el recibo y permite un reintento', async () => {
  const pg = await db();
  await pg.query(`insert into crm_contacts values ('44444444-4444-4444-8444-444444444444','Ana','AR')`);
  await pg.query(`insert into crm_conversations values ('55555555-5555-4555-8555-555555555555','44444444-4444-4444-8444-444444444444','{}'::jsonb)`);
  await pg.query(`insert into crm_commercial_cases(id,status,assigned_user_id,created_at,conversation_id) values ($1,'open',$2, now() - interval '25 hours','55555555-5555-4555-8555-555555555555')`, [ID, ADV]);
  const p = pool(pg);
  const at = new Date().toISOString();
  await p.query('select public.crm_lead_alerts_sweep($1)', [at]);
  let attempts = 0;
  const webPush = {async notify(){ attempts += 1; if (attempts === 1) throw new Error('SEND_FAILED'); return {sent:1}; }};
  const alerts = {async sweep(){ return {at}; }};
  const run = createLeadAlertNotifier({pool:p, alerts, webPush, logger:{warn(){}}});
  await run(); await run();
  assert.equal(attempts, 2, 'el fallo libera el recibo y el reintento vuelve a intentar');
  assert.equal((await p.query('select count(*)::int n from crm_lead_alert_deliveries')).rows[0].n, 1);
});

test('P09 PGlite: 0 suscripciones no es exito y no marca sent', async () => {
  const pg = await db();
  await pg.query(`insert into crm_contacts values ('44444444-4444-4444-8444-444444444444','Ana','AR')`);
  await pg.query(`insert into crm_conversations values ('55555555-5555-4555-8555-555555555555','44444444-4444-4444-8444-444444444444','{}'::jsonb)`);
  await pg.query(`insert into crm_commercial_cases(id,status,assigned_user_id,created_at,conversation_id) values ($1,'open',$2, now() - interval '25 hours','55555555-5555-4555-8555-555555555555')`, [ID, ADV]);
  const p = pool(pg); const at = new Date().toISOString();
  await p.query('select public.crm_lead_alerts_sweep($1)', [at]);
  const webPush = {async notify(){ return {sent: 0}; }};
  const run = createLeadAlertNotifier({pool:p, alerts:{async sweep(){ return {at}; }}, webPush});
  const out = await run();
  assert.equal(out.notifications, 0);
  const row = (await p.query('select state, sent_at from crm_lead_alert_deliveries')).rows[0];
  assert.equal(row.state, 'no_subscription');
  assert.equal(row.sent_at, null);
});

test('P09 PGlite: throw ambiguo (timeout) no borra recibo ni duplica', async () => {
  const pg = await db();
  await pg.query(`insert into crm_contacts values ('44444444-4444-4444-8444-444444444444','Ana','AR')`);
  await pg.query(`insert into crm_conversations values ('55555555-5555-4555-8555-555555555555','44444444-4444-4444-8444-444444444444','{}'::jsonb)`);
  await pg.query(`insert into crm_commercial_cases(id,status,assigned_user_id,created_at,conversation_id) values ($1,'open',$2, now() - interval '25 hours','55555555-5555-4555-8555-555555555555')`, [ID, ADV]);
  const p = pool(pg); const at = new Date().toISOString();
  await p.query('select public.crm_lead_alerts_sweep($1)', [at]);
  let calls = 0;
  const webPush = {async notify(){ calls += 1; const e = new Error('timeout'); e.code='ETIMEDOUT'; throw e; }};
  const run = createLeadAlertNotifier({pool:p, alerts:{async sweep(){ return {at}; }}, webPush, logger:{warn(){}}});
  await run(); await run();
  const row = (await p.query('select state from crm_lead_alert_deliveries')).rows[0];
  assert.equal(row.state, 'ambiguous');
  assert.equal(calls, 1, 'no se reintenta un ambiguo');
});

test('P09 PGlite: permisos fail-closed en tablas nuevas (anon/auth denegados, service_role opera)', async () => {
  const pg = await db();
  for (const rol of ['anon', 'authenticated']) {
    let denied = false;
    try { await pg.exec(`set role ${rol}`); await pg.query('select * from public.crm_lead_alert_deliveries'); }
    catch (e) { denied = /permission denied/i.test(e.message); }
    finally { try { await pg.exec('reset role'); } catch {} }
    assert.equal(denied, true, `${rol} no debe leer entregas`);
  }
  await pg.exec('set role service_role');
  const r = await pg.query('select count(*)::int n from public.crm_lead_alert_deliveries');
  assert.equal(r.rows[0].n, 0);
  await pg.exec('reset role');
});

test('P09 PGlite: fallo determinista queda failed y el siguiente run reintenta y envia una vez', async () => {
  const pg = await db();
  await pg.query(`insert into crm_contacts values ('44444444-4444-4444-8444-444444444444','Ana','AR')`);
  await pg.query(`insert into crm_conversations values ('55555555-5555-4555-8555-555555555555','44444444-4444-4444-8444-444444444444','{}'::jsonb)`);
  await pg.query(`insert into crm_commercial_cases(id,status,assigned_user_id,created_at,conversation_id) values ($1,'open',$2, now() - interval '25 hours','55555555-5555-4555-8555-555555555555')`, [ID, ADV]);
  const p = pool(pg); const at = new Date().toISOString();
  await p.query('select public.crm_lead_alerts_sweep($1)', [at]);
  let attempts = 0;
  const webPush = {async notify(){ attempts += 1; if (attempts === 1) { const e=new Error('bad request'); e.status=400; throw e; } return {sent:1}; }};
  const run = createLeadAlertNotifier({pool:p, alerts:{async sweep(){ return {at}; }}, webPush, logger:{warn(){}}});
  await run();
  let row = (await p.query('select state from crm_lead_alert_deliveries')).rows[0];
  assert.equal(row.state, 'failed');
  await run();
  row = (await p.query('select state from crm_lead_alert_deliveries')).rows[0];
  assert.equal(row.state, 'sent');
  assert.equal(attempts, 2);
});

test('P09 PGlite: si falla el UPDATE de sent, no se declara exito (DELIVERY_MARK_FAILED)', async () => {
  const pg = await db();
  await pg.query(`insert into crm_contacts values ('44444444-4444-4444-8444-444444444444','Ana','AR')`);
  await pg.query(`insert into crm_conversations values ('55555555-5555-4555-8555-555555555555','44444444-4444-4444-8444-444444444444','{}'::jsonb)`);
  await pg.query(`insert into crm_commercial_cases(id,status,assigned_user_id,created_at,conversation_id) values ($1,'open',$2, now() - interval '25 hours','55555555-5555-4555-8555-555555555555')`, [ID, ADV]);
  const p = pool(pg); const at = new Date().toISOString();
  await p.query('select public.crm_lead_alerts_sweep($1)', [at]);
  const badPool = {query(sql, params){ if (/sent_at=now\(\)/i.test(sql)) return Promise.resolve({rows: [], rowCount: 0}); return p.query(sql, params); }};
  const webPush = {async notify(){ return {sent: 1}; }};
  const run = createLeadAlertNotifier({pool:badPool, alerts:{async sweep(){ return {at}; }}, webPush, logger:{warn(){}}});
  const out = await run();
  assert.equal(out.notifications, 0, 'un UPDATE fallido no cuenta como envio');
  const row = (await p.query('select state from crm_lead_alert_deliveries')).rows[0];
  assert.notEqual(row.state, 'sent');
});
