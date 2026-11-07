import test from 'node:test';
import assert from 'node:assert/strict';
import {payloadFor, caseUrl, createLeadAlertNotifier} from './crmLeadAlertNotifier.js';

test('arma el enlace directo al caso segun el tipo', () => {
  assert.equal(caseUrl('form', 'abc'), '/admin/crm/formulario/abc');
  assert.equal(caseUrl('whatsapp', 'abc'), '/admin/crm/whatsapp/abc');
});

test('adapta el texto al estado de la alerta sin duplicar reglas', () => {
  const nuevo = payloadFor({state: 'pendiente', nombre: 'Juan Pérez', pais: 'Italia', caseType: 'form', caseId: 'c1'});
  assert.match(nuevo.title, /NUEVO LEAD/);
  assert.match(nuevo.body, /Juan Pérez/);
  assert.match(nuevo.body, /Italia/);
  assert.equal(nuevo.url, '/admin/crm/formulario/c1');
  const r = payloadFor({state: 'recordatorio', nombre: 'Ana', caseType: 'whatsapp', caseId: 'c2'});
  assert.match(r.title, /RECORDATORIO/);
  const c = payloadFor({state: 'escalada', nombre: 'Ana', caseType: 'whatsapp', caseId: 'c2'});
  assert.match(c.title, /CRÍTICA/);
});

test('notifica al asesor y escala tambien al responsable sin repetir destinatario', async () => {
  const sentTo = [];
  const alerts = { sweep: async () => ({ opened: 1, reminded: 0, escalated: 1, at: new Date().toISOString() }) };
  const pool = {
    query: async () => ({ rows: [
      { id: 'a1', case_type: 'form', case_id: 'c1', advisor_id: 'asesor-1', state: 'escalada', nombre: 'Juan', pais: 'Italia' },
      { id: 'a2', case_type: 'whatsapp', case_id: 'c2', advisor_id: 'jefe-1', state: 'escalada', nombre: 'Ana', pais: null },
    ] }),
  };
  const webPush = { notify: async ({ userId, payload }) => { sentTo.push([userId, payload.title]); return { sent: 1 }; } };
  const run = createLeadAlertNotifier({ pool, alerts, webPush, managerId: 'jefe-1', now: () => new Date('2026-11-02T18:00:00Z'), logger: { warn() {} } });
  const out = await run();
  assert.equal(out.notifications, 3);
  const T = 'ALERTA CRÍTICA — LEAD SIN ATENDER';
  assert.deepEqual(sentTo, [['asesor-1', T], ['jefe-1', T], ['jefe-1', T]]);
  assert.equal(out.escalated, 1);
});
