import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import {
  canReadNextGenerationRegistration,
  mountNextGenerationStatusRoutes,
  serializeNextGenerationRegistrationStatus,
} from './nextGenerationStatus.js';

const registrationId = '11111111-1111-4111-8111-111111111111';
const sessionId = '22222222-2222-4222-8222-222222222222';
const token = '33333333-3333-4333-8333-333333333333';
const row = {
  id: registrationId,
  sesion_id: sessionId,
  contacto_email: 'familia@example.com',
  estado: 'en_espera',
  posicion_espera: 2,
  cancelacion_token_hash: crypto.createHash('md5').update(token).digest('hex'),
  updated_at: '2026-10-02T00:00:00.000Z',
};

function routeHarness({ data = row, error = null, user = null } = {}) {
  let handler;
  const query = {
    select() { return this; },
    eq() { return this; },
    async maybeSingle() { return { data, error }; },
  };
  mountNextGenerationStatusRoutes({
    get(path, next) {
      assert.equal(path, '/api/next-generation/registrations/status');
      handler = next;
    },
  }, {
    supabaseAdmin: { from(table) { assert.equal(table, 'ng_inscripciones'); return query; } },
    getAuthenticatedUser: async () => ({ user }),
  });
  return handler;
}

function responseHarness() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    status(code) { this.statusCode = code; return this; },
    set(name, value) { this.headers[String(name).toLowerCase()] = value; return this; },
    json(body) { this.body = body; return this; },
  };
}

test('autoriza al contacto autenticado o al token UUID en header', () => {
  assert.equal(canReadNextGenerationRegistration(row, { user: { email: 'FAMILIA@example.com' } }), true);
  assert.equal(canReadNextGenerationRegistration(row, { cancellationToken: token }), true);
  assert.equal(canReadNextGenerationRegistration(row, { cancellationToken: token.toUpperCase() }), true);
  assert.equal(canReadNextGenerationRegistration(row, { user: { email: 'otra@example.com' } }), false);
  assert.equal(canReadNextGenerationRegistration(row, { cancellationToken: 'no-es-un-token' }), false);
});

test('serializa el contrato top-level que consume la app sin PII', () => {
  const payload = serializeNextGenerationRegistrationStatus(row);
  assert.deepEqual({
    inscripcion_id: payload.inscripcion_id,
    session_id: payload.session_id,
    estado: payload.estado,
    posicion_espera: payload.posicion_espera,
  }, {
    inscripcion_id: registrationId,
    session_id: sessionId,
    estado: 'en_espera',
    posicion_espera: 2,
  });
  assert.equal(payload.referencia, 'NGI-11111111');
  assert.equal(payload.inscripcion.estado, 'en_espera');
  assert.equal('contacto_email' in payload, false);
  assert.equal('cancelacion_token_hash' in payload, false);
});

test('GET status acepta Bearer del titular aunque no haya token de cancelación', async () => {
  const handler = routeHarness({ user: { email: 'familia@example.com' } });
  const req = {
    query: { registration_id: registrationId, session_id: sessionId },
    get: () => undefined,
  };
  const res = responseHarness();
  await handler(req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.estado, 'en_espera');
  assert.equal(res.headers['cache-control'], 'private, no-store');
});

test('GET status acepta token sólo desde X-NG-Cancellation-Token', async () => {
  const handler = routeHarness();
  const req = {
    query: { registration_id: registrationId, session_id: sessionId, cancellation_token: token },
    get: () => undefined,
  };
  const denied = responseHarness();
  await handler(req, denied);
  assert.equal(denied.statusCode, 403);

  req.get = (name) => name.toLowerCase() === 'x-ng-cancellation-token' ? token : undefined;
  const allowed = responseHarness();
  await handler(req, allowed);
  assert.equal(allowed.statusCode, 200);
});

test('GET status valida ambos UUID y no revela registros ajenos o inexistentes', async () => {
  const handler = routeHarness({ user: { email: 'otra@example.com' } });
  const invalid = responseHarness();
  await handler({ query: { registration_id: 'x', session_id: sessionId }, get: () => token }, invalid);
  assert.equal(invalid.statusCode, 400);

  const forbidden = responseHarness();
  await handler({ query: { registration_id: registrationId, session_id: sessionId }, get: () => undefined }, forbidden);
  assert.equal(forbidden.statusCode, 403);

  const missingHandler = routeHarness({ data: null });
  const missing = responseHarness();
  await missingHandler({ query: { registration_id: registrationId, session_id: sessionId }, get: () => token }, missing);
  assert.equal(missing.statusCode, 404);
});
