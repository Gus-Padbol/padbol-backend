import assert from 'node:assert/strict';
import test from 'node:test';

import { registerCrmInboundRoutes } from './crmInboundRoutes.js';

function setup({
  secret = 'qa-secret',
  ingestInbound = async () => ({ status: 'accepted', conversation: { id: 'c-1' } }),
  attachLeadAnalysis = async () => ({ status: 'accepted', conversation: { id: 'c-1' } }),
  leadAnalyzer = null,
} = {}) {
  const routes = new Map();
  const app = { post(path, handler) { routes.set(path, handler); } };
  registerCrmInboundRoutes(app, {
    crmService: { ingestInbound, attachLeadAnalysis },
    leadAnalyzer,
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
      fields: { País: 'Argentina', Ciudad: 'La Plata' },
    },
  }, res);

  assert.equal(res.statusCode, 201);
  assert.deepEqual(res.body, { ok: true, status: 'accepted', conversationId: 'crm-7' });
  assert.equal(received.source, 'form');
  assert.equal(received.channel, 'email');
  assert.equal(received.email, 'persona@example.com');
  assert.equal(received.origin, 'web_form:web_contact');
  assert.deepEqual(received.qualificationData.form_submission.fields, { País: 'Argentina', Ciudad: 'La Plata' });
});

test('formulario aceptado dispara el análisis automático sobre la misma ingesta', async () => {
  let analyzed;
  let release;
  const completed = new Promise((resolve) => { release = resolve; });
  const routes = setup({ leadAnalyzer: async (payload) => { analyzed = payload; release(); } });
  const res = response();
  await routes.get('/api/inbound/crm/form')({
    headers: { authorization: 'Bearer qa-secret' },
    body: { id: 'lead-auto-1', email: 'auto@example.com', phone: '+54 11 5555 0000', name: 'Auto' },
  }, res);
  await completed;

  assert.equal(res.statusCode, 201);
  assert.equal(analyzed.ingest.sourceId, 'lead-auto-1');
  assert.equal(analyzed.conversation.id, 'c-1');
});

test('inscripción de campaña queda enrutada al club sin mezclarse con leads comerciales', async () => {
  let received;
  const routes = setup({ ingestInbound: async (payload) => {
    received = payload;
    return { status: 'accepted', conversation: { id: 'registration-1' } };
  } });
  const res = response();
  await routes.get('/api/inbound/crm/form')({
    headers: { authorization: 'Bearer qa-secret' },
    body: {
      id: 'nextgen-2027-001',
      form: 'next_generation_registration',
      email: 'adulto@example.com',
      phone: '+54 221 555 0000',
      name: 'Participante QA',
      workflow: 'program_registration',
      campaignId: 'next-generation-2027',
      eventId: 'laplata-open-day-01',
      clubId: 'club-44',
      clubName: 'Club QA',
      country: 'Argentina',
      participantType: 'minor',
      registrationMode: 'walk_in',
      guardian: {
        name: 'Adulto Responsable',
        email: 'adulto@example.com',
        phone: '+54 221 555 0000',
        consent: true,
      },
    },
  }, res);

  assert.equal(res.statusCode, 201);
  assert.deepEqual(received.qualificationData.routing, {
    workflow: 'program_registration',
    campaign_id: 'next-generation-2027',
    event_id: 'laplata-open-day-01',
    club_id: 'club-44',
    club_name: 'Club QA',
    country: 'Argentina',
  });
  assert.deepEqual(received.qualificationData.participant, {
    type: 'minor',
    registration_mode: 'walk_in',
    guardian: {
      name: 'Adulto Responsable',
      email: 'adulto@example.com',
      phone: '+54 221 555 0000',
      consent: true,
    },
  });
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

test('análisis autenticado vuelve a la ficha CRM existente', async () => {
  let received;
  const routes = setup({ attachLeadAnalysis: async (payload) => {
    received = payload;
    return { status: 'accepted', conversation: { id: 'crm-9' } };
  } });
  const res = response();
  await routes.get('/api/inbound/crm/analysis')({
    headers: { authorization: 'Bearer qa-secret' },
    body: { analysisId: 'analysis-9', email: 'club@example.com', score: 91, priority: 'A' },
  }, res);

  assert.equal(res.statusCode, 201);
  assert.equal(received.analysisId, 'analysis-9');
  assert.deepEqual(res.body, { ok: true, status: 'accepted', conversationId: 'crm-9' });
});
