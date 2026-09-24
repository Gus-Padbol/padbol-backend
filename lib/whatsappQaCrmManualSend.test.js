import assert from 'node:assert/strict';
import test from 'node:test';
import { createWhatsappQaCrmManualSender } from './whatsappQaCrmManualSend.js';

const NOW = new Date('2026-09-23T15:00:00.000Z');
const URL = 'https://graph.facebook.com/v26.0/1376102838911694/messages';
const environment = () => ({
  WHATSAPP_QA_CRM_MANUAL_SEND_ENABLED: 'true',
  BACKEND_RUNTIME_MODE: 'staging',
  STAGING_SUPABASE_PROJECT_REF: 'vxikhdulhuvghfqeutnp',
  SUPABASE_URL: 'https://vxikhdulhuvghfqeutnp.supabase.co',
  RENDER_SERVICE_ID: 'srv-dahbs0dbedkc73a0kf4g',
  RENDER_EXTERNAL_URL: 'https://padbol-backend-qa.onrender.com',
  WHATSAPP_META_GRAPH_VERSION: 'v26.0',
  WHATSAPP_CLOUD_SEND_ENABLED: 'true',
  WHATSAPP_CLOUD_MAX_SEND_ATTEMPTS: '1',
  OUTBOUND_DELIVERY_ENABLED: 'false',
  BACKGROUND_JOBS_ENABLED: 'false',
  PUSH_SEND_ENABLED: 'false',
  WHATSAPP_META_TOKEN_TEST: 'secret-not-logged',
});

function database() {
  const channel = { id: '81bba438-eb65-4f70-bdf9-32f6c113d5bf' };
  return { from() {
    const q = { select() { return q; }, eq() { return q; }, maybeSingle: async () => ({ data: channel, error: null }) };
    return q;
  } };
}

function conversation(overrides = {}) {
  return {
    source_channel: 'whatsapp',
    origin: 'whatsapp:1376102838911694',
    identity_used: '5492213032019',
    source_ref: 'wamid.inbound',
    received_at: '2026-09-23T14:00:00.000Z',
    ...overrides,
  };
}

test('manual QA sender is opt-in and exact', () => {
  assert.equal(createWhatsappQaCrmManualSender({ env: { ...environment(), WHATSAPP_QA_CRM_MANUAL_SEND_ENABLED: 'false' } }), null);
  const automaticQaEnvironment = environment();
  delete automaticQaEnvironment.WHATSAPP_QA_CRM_MANUAL_SEND_ENABLED;
  assert.equal(typeof createWhatsappQaCrmManualSender({ env: automaticQaEnvironment }), 'function');
  assert.equal(createWhatsappQaCrmManualSender({ env: { ...automaticQaEnvironment, RENDER_SERVICE_ID: 'other' } }), null);
  for (const [key, value] of [
    ['BACKEND_RUNTIME_MODE', 'production'], ['STAGING_SUPABASE_PROJECT_REF', 'other'],
    ['OUTBOUND_DELIVERY_ENABLED', 'true'], ['BACKGROUND_JOBS_ENABLED', 'true'],
    ['PUSH_SEND_ENABLED', 'true'], ['WHATSAPP_CLOUD_SEND_ENABLED', 'false'],
    ['WHATSAPP_META_TOKEN_TEST', ''],
  ]) {
    assert.throws(() => createWhatsappQaCrmManualSender({ env: { ...environment(), [key]: value } }), {
      code: 'WHATSAPP_QA_CRM_MANUAL_CONFIGURATION_INVALID',
    });
  }
});

test('manual QA sender sends one text reply to the inbound identity', async () => {
  const calls = [];
  const factory = createWhatsappQaCrmManualSender({ env: environment(), now: () => NOW,
    logger: { info() {}, warn() {} }, fetchImpl: async (...args) => {
      calls.push(args);
      return { ok: true, status: 200, redirected: false, url: URL,
        json: async () => ({ messages: [{ id: 'wamid.outbound' }] }) };
    } });
  const send = factory({ supabaseAdmin: database() });
  const result = await send({ conversation: conversation(), body: 'Hola, ¿en qué puedo ayudarte?' });
  assert.equal(result.providerMessageId, 'wamid.outbound');
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], URL);
  const payload = JSON.parse(calls[0][1].body);
  assert.equal(payload.to, '5492213032019');
  assert.equal(payload.context, undefined);
  assert.equal(payload.text.body, 'Hola, ¿en qué puedo ayudarte?');
});

test('manual QA sender rejects email, foreign origin and expired conversations before I/O', async () => {
  let calls = 0;
  const factory = createWhatsappQaCrmManualSender({ env: environment(), now: () => NOW,
    fetchImpl: async () => { calls += 1; } });
  const send = factory({ supabaseAdmin: database() });
  for (const row of [
    conversation({ source_channel: 'email' }),
    conversation({ origin: 'whatsapp:other' }),
    conversation({ received_at: '2026-09-20T00:00:00.000Z' }),
    conversation({ identity_used: 'not-a-phone' }),
  ]) {
    await assert.rejects(() => send({ conversation: row, body: 'Hola' }), { code: 'WHATSAPP_QA_CRM_MANUAL_SCOPE_REQUIRED' });
  }
  assert.equal(calls, 0);
});

test('manual QA sender exposes only safe Meta diagnostic codes on rejection', async () => {
  const warnings = [];
  const factory = createWhatsappQaCrmManualSender({ env: environment(), now: () => NOW,
    logger: { info() {}, warn(label, detail) { warnings.push({ label, detail }); } }, fetchImpl: async () => ({
      ok: false, status: 400, redirected: false, url: URL,
      json: async () => ({ error: { code: 131030, error_subcode: 2494010,
        type: 'OAuthException', message: 'Provider detail\nwithout secrets',
        fbtrace_id: 'A-safe-trace-id', access_token: 'must-never-be-logged' } }),
    }) });
  const send = factory({ supabaseAdmin: database() });
  await assert.rejects(() => send({ conversation: conversation(), body: 'Hola' }), {
    code: 'WHATSAPP_QA_CRM_SEND_FAILED',
    message: 'Meta no aceptó la respuesta de WhatsApp (código 131030, subcódigo 2494010).',
  });
  assert.deepEqual(warnings, [{
    label: '[whatsapp-qa-crm] provider rejected',
    detail: {
      code: 'WHATSAPP_QA_CRM_PROVIDER_REJECTED',
      httpStatus: 400,
      providerCode: 131030,
      providerSubcode: 2494010,
      providerType: 'OAuthException',
      providerMessage: 'Provider detail without secrets',
      fbtraceId: 'A-safe-trace-id',
    },
  }]);
  assert(!JSON.stringify(warnings).includes('must-never-be-logged'));
  assert(!JSON.stringify(warnings).includes(environment().WHATSAPP_META_TOKEN_TEST));
});
