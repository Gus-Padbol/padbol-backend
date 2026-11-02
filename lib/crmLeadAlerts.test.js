import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {PGlite} from '/Users/padbol2022/PADBOL-LAB-DEEPSEEK/padbol-backend-canonical/node_modules/@electric-sql/pglite/dist/index.js';
import {createCrmLeadAlerts, validateCompletion} from './crmLeadAlerts.js';

const migration = await fs.readFile(new URL('../sql/candidates/20261102190000_crm_lead_alerts.sql', import.meta.url), 'utf8');
const fixture = `
create role anon; create role authenticated;
create table public.crm_commercial_cases(id uuid primary key, conversation_id uuid, assigned_user_id uuid, status text default 'open', progress_state text, next_contact_at timestamptz, created_at timestamptz default now());
create table public.crm_commercial_form_cases(id uuid primary key, conversation_id uuid, assigned_user_id uuid, created_at timestamptz default now());
create table public.crm_commercial_team_activities(id uuid primary key default gen_random_uuid(), case_id uuid, case_type text, actor_id uuid, body text, created_at timestamptz default now());
`;

const ID = '11111111-1111-4111-8111-111111111111';
const ADVISOR = '22222222-2222-4222-8222-222222222222';

async function fixtureDb() {
  const db = new PGlite();
  await db.exec(fixture);
  await db.exec(migration);
  const pool = { query: (...args) => db.query(...args) };
  return { db, pool };
}

test('abre alerta a las 24 h, escala a las 48 h y no duplica', async () => {
  const { db, pool } = await fixtureDb();
  await db.exec(`insert into public.crm_commercial_cases(id,conversation_id,assigned_user_id,created_at) values ('${ID}','${ADVISOR}','${ADVISOR}', now() - interval '25 hours')`);
  const alerts = createCrmLeadAlerts({ pool, now: () => new Date() });
  const first = await alerts.sweep();
  assert.equal(Number(first.opened), 1);
  assert.equal(Number(first.reminded), 1);
  const second = await alerts.sweep();
  assert.equal(Number(second.opened), 0, 'no debe abrir una segunda alerta');
  await db.exec(`update public.crm_lead_alerts set due_escalation_at = now() - interval '1 minute'`);
  const third = await alerts.sweep();
  assert.equal(Number(third.escalated), 1);
  assert.equal(Number((await db.query('select count(*)::int n from public.crm_lead_alerts')).rows[0].n), 1);
});

test('una actividad reciente reinicia el reloj de la alerta', async () => {
  const { db, pool } = await fixtureDb();
  await db.exec(`insert into public.crm_commercial_cases(id,conversation_id,assigned_user_id,created_at) values ('${ID}','${ADVISOR}','${ADVISOR}', now() - interval '60 hours')`);
  await db.exec(`insert into public.crm_commercial_team_activities(case_id,case_type,body,created_at) values ('${ID}','whatsapp','llamada realizada', now() - interval '2 hours')`);
  const alerts = createCrmLeadAlerts({ pool });
  const res = await alerts.sweep();
  assert.equal(Number(res.opened), 1);
  const row = (await db.query('select state from public.crm_lead_alerts')).rows[0];
  assert.equal(row.state, 'pendiente');
});

test('resuelve la alerta cuando el caso se cierra', async () => {
  const { db, pool } = await fixtureDb();
  await db.exec(`insert into public.crm_commercial_cases(id,conversation_id,assigned_user_id,created_at) values ('${ID}','${ADVISOR}','${ADVISOR}', now())`);
  const alerts = createCrmLeadAlerts({ pool });
  await alerts.sweep();
  await db.exec(`update public.crm_commercial_cases set status='closed' where id='${ID}'`);
  const res = await alerts.sweep();
  assert.equal(Number(res.resolved), 1);
  await alerts.sweep();
  assert.equal(Number((await db.query("select count(*)::int n from public.crm_lead_alerts where resolved_at is null")).rows[0].n), 0);
});

test('el panel separa pendientes, vencidas y sin proxima accion', async () => {
  const { db, pool } = await fixtureDb();
  await db.exec(`insert into public.crm_commercial_cases(id,conversation_id,assigned_user_id,created_at) values ('${ID}','${ADVISOR}','${ADVISOR}', now() - interval '30 hours')`);
  const alerts = createCrmLeadAlerts({ pool });
  await alerts.sweep();
  const panel = await alerts.panel();
  assert.equal(panel.pending.length, 1);
  assert.equal(panel.overdue.length, 0);
  assert.equal(panel.withoutNextAction.length, 1);
  await db.exec(`update public.crm_lead_alerts set state='escalada'`);
  const escalated = await alerts.panel();
  assert.equal(escalated.overdue.length, 1);
  assert.equal((await alerts.panel({ onlyOverdue: true })).overdue.length, 1);
});

test('notifica una sola vez por etapa y escala al responsable', async () => {
  const { db, pool } = await fixtureDb();
  await db.exec(`insert into public.crm_commercial_cases(id,conversation_id,assigned_user_id,created_at) values ('${ID}','${ADVISOR}','${ADVISOR}', now() - interval '25 hours')`);
  const sent = [];
  const alerts = createCrmLeadAlerts({ pool, deliver: async (m) => sent.push(m) });
  await alerts.sweep();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].stage, 'recordatorio');
  assert.equal(sent[0].escalateToManager, false);
  await alerts.sweep();
  assert.equal(sent.length, 1, 'no repite la notificacion en la misma etapa');
  await db.exec(`update public.crm_lead_alerts set due_escalation_at = now() - interval '1 minute'`);
  await alerts.sweep();
  assert.equal(sent.length, 2);
  assert.equal(sent[1].escalateToManager, true);
});

test('cierre incompleto rechazado y cliente sin respuesta no puede marcarse atendido', () => {
  const base = { contact_at: new Date().toISOString(), channel: 'whatsapp', outcome: 'Interesado', summary: 'Hablo sobre precios y horarios del club.', commercial_state: 'en_atencion' };
  assert.throws(() => validateCompletion({ ...base, summary: 'corto' }), (e) => e.code === 'SUMMARY_REQUIRED');
  assert.throws(() => validateCompletion({ ...base, channel: 'paloma' }), (e) => e.code === 'CONTACT_CHANNEL_REQUIRED');
  assert.throws(() => validateCompletion({ ...base, commercial_state: 'cerrado' }), (e) => e.code === 'CLOSURE_REASON_REQUIRED');
  assert.throws(() => validateCompletion({ ...base, client_responded: false, attended: true }), (e) => e.code === 'UNANSWERED_CANNOT_BE_ATTENDED');
  assert.throws(() => validateCompletion({ ...base, client_responded: false }), (e) => e.code === 'NEXT_ACTION_REQUIRED');
  const ok = validateCompletion({ ...base, next_action: 'Llamar manana', next_action_at: new Date(Date.now() + 86400000).toISOString() });
  assert.equal(ok.attended, true);
  const retry = validateCompletion({ ...base, client_responded: false, next_action: 'Reintentar WhatsApp', next_action_at: new Date(Date.now() + 86400000).toISOString() });
  assert.equal(retry.attended, false);
  const closed = validateCompletion({ ...base, commercial_state: 'cerrado', closure_reason: 'Cliente sin presupuesto este trimestre.' });
  assert.equal(closed.attended, true);
});
