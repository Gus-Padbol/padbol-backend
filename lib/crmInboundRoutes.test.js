import assert from 'node:assert/strict';
import test from 'node:test';

import { registerCrmInboundRoutes } from './crmInboundRoutes.js';

function setup({ secret = 'qa-secret', ingestInbound = async () => ({ status: 'accepted', conversation: { id: 'c-1' } }) } = {}) {
  const routes = new Map();
  const app = { post(path, handler) { routes.set(path, handler); } };
  registerCrmInboundRoutes(app, {
    crmService: { ingestInbound },
    emailInboundSecret: secret,
    logger: { warn() {} },
  });
  return routes;
}

function response() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

test('formulario autenticado entra al CRM con contrato canónico', async () => {
  let received;
  const routes = setup({ ingestInbound: async (payload) => {
    received = payload;
    return { status: 'accepted', conversation: { id: 'crm-7' } };
  } });
  const res = response();
  await routes.get('/api/inbound/crm/form')({
    headers: { authorization: 'Bearer qa-secret' },
    body: {
      id: 'lead-7', form: 'web_contact', email: 'Persona@Example.com', phone: '+54 11 4444 5555',
      name: 'Persona', subject: 'Consulta', message: 'Quiero una cancha.',
    },
  }, res);

  assert.equal(res.statusCode, 201);
  assert.deepEqual(res.body, { ok: true, status: 'accepted', conversationId: 'crm-7' });
  assert.equal(received.source, 'form');
  assert.equal(received.channel, 'email');
  assert.equal(received.email, 'persona@example.com');
  assert.equal(received.origin, 'web_form:web_contact');
});

test('formulario CRM falla cerrado sin secreto o con credencial incorrecta', async () => {
  for (const [secret, authorization, expected] of [
    ['', 'Bearer qa-secret', 503],
    ['qa-secret', 'Bearer incorrecto', 401],
  ]) {
    const routes = setup({ secret });
    const res = response();
    await routes.get('/api/inbound/crm/form')({ headers: { authorization }, body: {} }, res);
    assert.equal(res.statusCode, expected);
  }
});

test('formulario inválido no llama a la ingesta', async () => {
  let calls = 0;
  const routes = setup({ ingestInbound: async () => { calls += 1; } });
  const res = response();
  await routes.get('/api/inbound/crm/form')({
    headers: { authorization: 'Bearer qa-secret' },
    body: { id: 'lead-8' },
  }, res);
  assert.equal(res.statusCode, 400);
  assert.equal(calls, 0);
});
