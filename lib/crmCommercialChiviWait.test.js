import test from 'node:test';
import assert from 'node:assert/strict';
import {
  COMMERCIAL_CHIVI_WAIT_NOTICE_ES,
  createCommercialChiviWait,
} from './crmCommercialChiviWait.js';

function conversation(overrides = {}) {
  return {
    id: 'conversation-id', source_channel: 'whatsapp', estado: 'nuevo', operador: null, derivado: false,
    qualification_data: { whatsapp_menu: { topic: 'sede', stage: 'selected', language: 'es' } },
    ...overrides,
  };
}

test('only an explicitly invoked Chivi can answer an unclaimed commercial WhatsApp lead', async () => {
  let calls = 0;
  const bridge = createCommercialChiviWait({ enabled: true, reply: async () => { calls += 1; return 'Padbol es un deporte de equipo.'; } });
  assert.match(bridge.notice(conversation()), /Chivi/);
  assert.equal(await bridge.respond({ conversation: conversation(), body: '¿Cómo funciona Padbol?' }), null);
  const result = await bridge.respond({ conversation: conversation(), body: 'Chivi: ¿Cómo funciona Padbol?' });
  assert.equal(result.kind, 'answer');
  assert.equal(calls, 1);
  assert.match(result.response, /Padbol es un deporte/);
  assert.match(result.response, /asesor/i);
});

test('commercial terms are never passed to Chivi and lead directly to the advisor', async () => {
  let calls = 0;
  const bridge = createCommercialChiviWait({ enabled: true, reply: async () => { calls += 1; return 'unexpected'; } });
  const result = await bridge.respond({ conversation: conversation(), body: 'Chivi, ¿cuál es el precio de una cancha?' });
  assert.equal(result.kind, 'commercial_handoff');
  assert.equal(calls, 0);
  assert.match(result.response, /precios/i);
});

test('advisor command and a claimed conversation never trigger an AI answer', async () => {
  let calls = 0;
  const bridge = createCommercialChiviWait({ enabled: true, reply: async () => { calls += 1; return 'unexpected'; } });
  assert.equal((await bridge.respond({ conversation: conversation(), body: 'ASESOR' })).kind, 'advisor');
  assert.equal(await bridge.respond({ conversation: conversation({ operador: 'sm@padbol.com' }), body: 'Chivi: reglas' }), null);
  assert.equal(calls, 0);
});

test('provider failure or restricted model output falls back to human assistance', async () => {
  const failure = createCommercialChiviWait({ enabled: true, reply: async () => { throw Error('provider unavailable'); } });
  assert.equal((await failure.respond({ conversation: conversation(), body: 'Chivi: ¿qué es Padbol?' })).kind, 'advisor_fallback');
  const unsafe = createCommercialChiviWait({ enabled: true, reply: async () => 'El precio es USD 1000.' });
  assert.equal((await unsafe.respond({ conversation: conversation(), body: 'Chivi: ¿qué es Padbol?' })).kind, 'advisor_fallback');
});

test('notice is available only for an enabled, not-yet-claimed commercial lead', () => {
  assert.equal(createCommercialChiviWait({ enabled: false, reply: async () => 'x' }).notice(conversation()), null);
  assert.equal(createCommercialChiviWait({ enabled: true, reply: async () => 'x' }).notice(conversation({ derivado: true })), null);
  assert.equal(COMMERCIAL_CHIVI_WAIT_NOTICE_ES.includes('precios'), true);
});
