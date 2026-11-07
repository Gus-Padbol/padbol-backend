import assert from 'node:assert/strict';
import test from 'node:test';
import {createLeadAlertNotifier} from './crmLeadAlertNotifier.js';

function fixture({rowsByAt}) {
  const calls = {queries: [], notified: []};
  const pool = {async query(sql, params) {
    calls.queries.push({sql, params});
    if (!/where a\.resolved_at is null and a\.updated_at = \$1/i.test(sql)) throw new Error('unexpected query');
    if (params.length !== 1) throw new Error('at parameter required');
    return {rows: rowsByAt[params[0]] || []};
  }};
  const webPush = {async notify({userId, payload}) { calls.notified.push({userId, payload}); return {sent: 1}; }};
  return {calls, pool, webPush};
}

test('snake_case de SQL se traduce a URL correcta (form y whatsapp)', async () => {
  const at = '2026-11-07T12:00:00.000Z';
  const rows = [
    {id: 'a1', case_type: 'form', case_id: 'f1', advisor_id: 'u1', state: 'nuevo', nombre: 'Ana', pais: 'AR'},
    {id: 'a2', case_type: 'whatsapp', case_id: 'w1', advisor_id: 'u1', state: 'recordatorio', nombre: 'Beto', pais: 'ES'},
  ];
  const f = fixture({rowsByAt: {[at]: rows}});
  const run = createLeadAlertNotifier({pool: f.pool, alerts: {sweep: async () => ({at, notified: 0})}, webPush: f.webPush});
  await run();
  const urls = f.calls.notified.map((n) => n.payload?.url ?? n.payload?.caseUrl).filter(Boolean);
  assert.ok(JSON.stringify(f.calls.notified).includes('/admin/crm/formulario/f1'));
  assert.ok(JSON.stringify(f.calls.notified).includes('/admin/crm/whatsapp/w1'));
});

test('reloj: el WHERE usa EXACTAMENTE el at devuelto por sweep', async () => {
  const at = '2026-11-07T12:00:00.000Z';
  const f = fixture({rowsByAt: {[at]: []}});
  let sawNow = false;
  const run = createLeadAlertNotifier({pool: f.pool, alerts: {sweep: async () => ({at})}, webPush: f.webPush, now: () => { sawNow = true; return new Date('2030-01-01T00:00:00Z'); }});
  await run();
  assert.equal(f.calls.queries[0].params[0], at);
  assert.equal(sawNow, false, 'no debe calcular now() propio');
});

test('fail-closed: sweep sin at no consulta ni notifica', async () => {
  const f = fixture({rowsByAt: {}});
  const run = createLeadAlertNotifier({pool: f.pool, alerts: {sweep: async () => ({})}, webPush: f.webPush});
  await assert.rejects(run(), /CRM_SWEEP_CYCLE_REQUIRED/);
  assert.equal(f.calls.queries.length, 0);
  assert.equal(f.calls.notified.length, 0);
});

test('RIESGO DOCUMENTADO: repetir el mismo at vuelve a seleccionar y notificar (sin dedup durable)', async () => {
  const at = '2026-11-07T12:00:00.000Z';
  const rows = [{id: 'a1', case_type: 'form', case_id: 'f1', advisor_id: 'u1', state: 'nuevo', nombre: 'Ana', pais: 'AR'}];
  const f = fixture({rowsByAt: {[at]: rows}});
  let sweeps = 0;
  const run = createLeadAlertNotifier({pool: f.pool, alerts: {sweep: async () => { sweeps += 1; return {at, notified: 0}; }}, webPush: f.webPush});
  await run(); await run();
  assert.equal(sweeps, 2);
  assert.equal(f.calls.notified.length, 2, 'hoy duplica: falta dedup durable por evento/ciclo');
});
