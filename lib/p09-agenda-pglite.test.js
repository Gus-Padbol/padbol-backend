import assert from 'node:assert/strict';
import test from 'node:test';
import {PGlite} from '@electric-sql/pglite';
import {readFileSync} from 'node:fs';
import {createAgendaReminderNotifier} from './crmAgendaReminderNotifier.js';

const MIG = readFileSync(new URL('../sql/candidates/20261107200000_p09_alert_cycle_delivery.sql', import.meta.url), 'utf8');
const CASE = '11111111-1111-4111-8111-111111111111';
const ADV = '22222222-2222-4222-8222-222222222222';
const ADV2 = '33333333-3333-4333-8333-333333333333';
const T = '2026-11-10T12:00:00.000Z';

async function db() {
  const pg = new PGlite();
  await pg.exec(`create role anon; create role authenticated; create role service_role;
    create table crm_commercial_cases(id uuid primary key, status text, assigned_user_id uuid, created_at timestamptz default now(), conversation_id uuid, next_contact_at timestamptz, reminder_hours integer[] default array[24,8], progress_state text);
    create table crm_commercial_form_cases(conversation_id uuid primary key, assigned_user_id uuid, created_at timestamptz default now(), next_contact_at timestamptz, reminder_hours integer[] default array[24,8], progress_state text);
    create table crm_commercial_team_activities(case_id uuid, case_type text, created_at timestamptz);
    create table crm_contacts(id uuid primary key, nombre text, pais text);
    create table crm_conversations(id uuid primary key, contact_id uuid, qualification_data jsonb);`);
  await pg.exec(MIG);
  return pg;
}
const pool = (pg) => ({async query(sql, params = []) { const r = await pg.query(sql, params); return {rows: r.rows, rowCount: r.rows.length}; }});

test('agenda: avisos T-24 y T-8, sin duplicar; reprogramar/cerrar/reasignar reconcilia; historicos sin fecha no entran', async () => {
  const pg = await db();
  await pg.query(`insert into crm_commercial_cases(id,status,assigned_user_id,next_contact_at) values ($1,'open',$2,$3)`, [CASE, ADV, T]);
  await pg.query(`insert into crm_commercial_cases(id,status,assigned_user_id,next_contact_at) values ('44444444-4444-4444-8444-444444444444','open',$1,null)`, [ADV]);
  const p = pool(pg);
  const sent = [];
  const run = createAgendaReminderNotifier({pool: p, webPush: {async notify({userId, payload}) { sent.push({userId, stage: payload.anticipationHours}); return {sent: 1}; }}, now: () => new Date('2026-11-09T11:00:00.000Z')});
  await run(); // T-25h => nada
  assert.equal(sent.length, 0);
  const run24 = createAgendaReminderNotifier({pool: p, webPush: {async notify({userId, payload}) { sent.push({userId, stage: payload.anticipationHours}); return {sent: 1}; }}, now: () => new Date('2026-11-09T12:00:00.000Z')});
  await run24(); await run24(); // T-24h => uno, repetido no duplica
  assert.equal(sent.length, 1);
  const run8 = createAgendaReminderNotifier({pool: p, webPush: {async notify({userId, payload}) { sent.push({userId, stage: payload.anticipationHours}); return {sent: 1}; }}, now: () => new Date('2026-11-10T04:00:00.000Z')});
  await run8(); // T-8h => segundo
  assert.equal(sent.length, 2);
  // reprogramar: la agenda vieja se cancela y no se avisa de la anterior
  await pg.query(`update crm_commercial_cases set next_contact_at='2026-11-12T12:00:00Z' where id=$1`, [CASE]);
  await run8();
  assert.equal((await p.query('select count(*)::int n from crm_agenda_reminders')).rows[0].n, 0);
  // cerrar: no genera
  await pg.query(`update crm_commercial_cases set status='closed' where id=$1`, [CASE]);
  await run8();
  assert.equal((await p.query('select count(*)::int n from crm_agenda_reminders')).rows[0].n, 0);
  // reasignar: el aviso va al nuevo asesor
  await pg.query(`update crm_commercial_cases set status='open', assigned_user_id=$1, next_contact_at=$2 where id=$3`, [ADV2, '2026-11-10T12:00:00Z', CASE]);
  await run24();
  const rows = (await p.query('select advisor_id from crm_agenda_reminders')).rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].advisor_id, ADV2);
});

test('Agenda entrega: timeout ambiguo sin reenvio, 0 unconfirmed, 400 failed con retry, mark fallido', async () => {
  const {createAgendaReminderNotifier} = await import('./crmAgendaReminderNotifier.js');
  const CASE2 = '66666666-6666-4666-8666-666666666666';
  async function base() {
    const pg = await db();
    await pg.query(`insert into crm_commercial_cases(id,status,assigned_user_id,next_contact_at) values ($1,'open',$2,$3)`, [CASE2, ADV, '2026-11-10T12:00:00Z']);
    const p = pool(pg);
    return {pg, p, at: '2026-11-09T12:00:00.000Z'};
  }
  // timeout => ambiguous y no reenvia
  {
    const {p} = await base(); let calls = 0;
    const webPush = {async notify(){ calls += 1; const e = new Error('timeout'); e.code='ETIMEDOUT'; throw e; }};
    const run = createAgendaReminderNotifier({pool:p, webPush, now: () => new Date('2026-11-09T12:00:00Z'), logger:{warn(){}}});
    await run(); await run();
    const row = (await p.query('select state from crm_lead_alert_deliveries')).rows[0];
    assert.equal(row.state, 'ambiguous'); assert.equal(calls, 1);
  }
  // sent 0 => unconfirmed, sin sent_at
  {
    const {p} = await base();
    const run = createAgendaReminderNotifier({pool:p, webPush:{async notify(){ return {sent:0}; }}, now: () => new Date('2026-11-09T12:00:00Z')});
    const out = await run();
    assert.equal(out.notifications, 0);
    const row = (await p.query('select state, sent_at from crm_lead_alert_deliveries')).rows[0];
    assert.equal(row.state, 'unconfirmed'); assert.equal(row.sent_at, null);
  }
  // 400 definitivo => failed y el siguiente run reintenta
  {
    const {p} = await base(); let calls = 0;
    const webPush = {async notify(){ calls += 1; if (calls === 1) { const e=new Error('bad'); e.status=400; throw e; } return {sent:1}; }};
    const run = createAgendaReminderNotifier({pool:p, webPush, now: () => new Date('2026-11-09T12:00:00Z'), logger:{warn(){}}});
    await run();
    assert.equal((await p.query('select state from crm_lead_alert_deliveries')).rows[0].state, 'failed');
    await run();
    assert.equal((await p.query('select state from crm_lead_alert_deliveries')).rows[0].state, 'sent');
    assert.equal(calls, 2);
  }
  // claim colgado => ambiguous sin reenvio (crash tras INSERT)
  {
    const {p, pg} = await base();
    await p.query('select public.crm_agenda_reminders_sweep($1)', ['2026-11-09T12:00:00.000Z']);
    const rem = (await p.query('select id, advisor_id, anticipation_hours from crm_agenda_reminders')).rows[0];
    await pg.query(`insert into crm_lead_alert_deliveries (alert_id,stage,recipient_id,state,claimed_at) values ($1,$2,$3,'claimed', now() - interval '10 minutes')`, [rem.id, `agenda_${rem.anticipation_hours}`, rem.advisor_id]);
    let calls = 0;
    const run = createAgendaReminderNotifier({pool:p, webPush:{async notify(){ calls += 1; return {sent:1}; }}, now: () => new Date('2026-11-09T12:00:00Z')});
    await run();
    assert.equal((await p.query('select state from crm_lead_alert_deliveries')).rows[0].state, 'ambiguous');
    assert.equal(calls, 0, 'un claim colgado no se reenvia');
  }
});

test('Agenda: reasignacion con la MISMA fecha reconcilia antes del sweep y avisa al nuevo', async () => {
  const {createAgendaReminderNotifier} = await import('./crmAgendaReminderNotifier.js');
  const pg = await db();
  const C = '77777777-7777-4777-8777-777777777777';
  await pg.query("insert into crm_commercial_cases(id,status,assigned_user_id,next_contact_at) values ($1,'open',$2,'2026-11-10T12:00:00Z')", [C, ADV]);
  const p = pool(pg);
  const sent = [];
  const webPush = {async notify({userId}) { sent.push(userId); return {sent:1}; }};
  const run = createAgendaReminderNotifier({pool:p, webPush, now: () => new Date('2026-11-09T12:00:00Z')});
  await run();
  assert.deepEqual(sent, [ADV]);
  await pg.query('update crm_commercial_cases set assigned_user_id=$1 where id=$2', [ADV2, C]);
  await run();
  const rows = (await p.query('select advisor_id from crm_agenda_reminders')).rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].advisor_id, ADV2);
  assert.deepEqual(sent, [ADV, ADV2]);
});

test('Agenda: form cerrado no genera recordatorios', async () => {
  const {createAgendaReminderNotifier} = await import('./crmAgendaReminderNotifier.js');
  const pg = await db();
  await pg.query("insert into crm_commercial_form_cases(conversation_id, assigned_user_id, next_contact_at, progress_state) values ($1,$2,'2026-11-10T12:00:00Z','cerrado')", ['88888888-8888-4888-8888-888888888888', ADV]);
  const p = pool(pg);
  const run = createAgendaReminderNotifier({pool:p, webPush:{async notify(){ return {sent:1}; }}, now: () => new Date('2026-11-09T12:00:00Z')});
  await run();
  assert.equal((await p.query('select count(*)::int n from crm_agenda_reminders')).rows[0].n, 0);
});
