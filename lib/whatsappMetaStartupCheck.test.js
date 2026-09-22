import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createWhatsappMetaQaStartupCheck, META_QA_STARTUP_FLAG } from './whatsappMetaStartupCheck.js';
import { EXPECTED } from './verify-meta-sandbox-v26.mjs';
import { installStagingFetchGuard } from './backendRuntime.js';

const env = {
  [META_QA_STARTUP_FLAG]: 'true', BACKEND_RUNTIME_MODE: 'staging',
  STAGING_SUPABASE_PROJECT_REF: 'vxikhdulhuvghfqeutnp', SUPABASE_URL: 'https://vxikhdulhuvghfqeutnp.supabase.co',
  RENDER_SERVICE_ID: 'srv-dahbs0dbedkc73a0kf4g', RENDER_EXTERNAL_URL: EXPECTED.origin,
  WHATSAPP_META_APP_SECRET: 'fake-app-secret-do-not-log', WHATSAPP_META_TOKEN_TEST: 'fake-access-token-do-not-log',
  WHATSAPP_META_VERIFY_TOKEN: 'fake-verify-token-do-not-log', WHATSAPP_META_GRAPH_VERSION: 'v26.0',
  OUTBOUND_DELIVERY_ENABLED: 'false', WHATSAPP_CLOUD_SEND_ENABLED: 'false',
  BACKGROUND_JOBS_ENABLED: 'false', PUSH_SEND_ENABLED: 'false', WHATSAPP_CLOUD_MAX_SEND_ATTEMPTS: '1',
};
const response = (body, status = 200) => ({ ok: status === 200, status, json: async () => body });
function harness(overrides = {}) {
  const requests = [], logs = [];
  const runner = createWhatsappMetaQaStartupCheck({ env, logger: line => logs.push(line),
    fetchImpl: async (url, options) => {
      requests.push({ url: new URL(url), options });
      if (url.pathname.endsWith(`/${EXPECTED.appId}/subscriptions`)) return response({ data: [{ object: 'whatsapp_business_account',
        callback_url: EXPECTED.callbackUrl, fields: [{ name: 'messages' }] }] });
      return url.pathname.endsWith('/subscribed_apps')
        ? response({ data: [{ whatsapp_business_api_data: { id: EXPECTED.appId } }] })
        : response({ id: EXPECTED.phoneNumberId, display_phone_number: '+1 555 671 1531' });
    }, ...overrides });
  return { runner, requests, logs };
}

test('disabled by default and non-exact opt-in never reads Meta or emits a diagnostic', async () => {
  for (const value of [undefined, '', 'false', 'TRUE', '1']) {
    const h = harness({ env: { ...env, [META_QA_STARTUP_FLAG]: value } });
    assert.equal(await h.runner(), null); assert.equal(h.requests.length, 0); assert.equal(h.logs.length, 0);
  }
});
test('only exact QA runtime, project, origin and Render service can run', async () => {
  for (const key of ['BACKEND_RUNTIME_MODE', 'STAGING_SUPABASE_PROJECT_REF', 'SUPABASE_URL', 'RENDER_SERVICE_ID', 'RENDER_EXTERNAL_URL']) {
    const h = harness({ env: { ...env, [key]: 'wrong-target' } });
    assert.equal((await h.runner()).code, 'META_QA_SCOPE_REQUIRED'); assert.equal(h.requests.length, 0);
  }
});
test('effective delivery and background controls must remain disabled', async () => {
  for (const key of ['BACKGROUND_JOBS_ENABLED', 'PUSH_SEND_ENABLED']) {
    for (const value of ['true', undefined]) {
      const h = harness({ env: { ...env, [key]: value } });
      assert.equal((await h.runner()).code, 'META_QA_DELIVERY_MUST_BE_DISABLED'); assert.equal(h.requests.length, 0);
    }
  }
  const activeDelivery = harness({ env: {
    ...env, OUTBOUND_DELIVERY_ENABLED: 'true', WHATSAPP_CLOUD_SEND_ENABLED: 'true',
  } });
  assert.equal((await activeDelivery.runner()).code, 'META_QA_DELIVERY_MUST_BE_DISABLED');
  assert.equal(activeDelivery.requests.length, 0);
});
test('diagnostic may read Meta when the global outbound gate keeps delivery disabled', async () => {
  const h = harness({ env: {
    ...env, OUTBOUND_DELIVERY_ENABLED: 'false', WHATSAPP_CLOUD_SEND_ENABLED: 'true',
  } });
  assert.equal((await h.runner()).code, 'META_QA_PREFLIGHT_PASSED');
  assert.equal(h.requests.length, 3);
});
test('missing credentials, wrong version and multi-attempt config fail before any request', async () => {
  for (const [key, value] of [
    ...['WHATSAPP_META_APP_SECRET', 'WHATSAPP_META_TOKEN_TEST', 'WHATSAPP_META_VERIFY_TOKEN', 'WHATSAPP_META_GRAPH_VERSION'].map(k => [k, '']),
    ['WHATSAPP_META_GRAPH_VERSION', 'v25.0'], ['WHATSAPP_CLOUD_MAX_SEND_ATTEMPTS', '2'],
  ]) {
    const h = harness({ env: { ...env, [key]: value } });
    assert.equal((await h.runner()).code, 'META_QA_CONFIGURATION_INCOMPLETE'); assert.equal(h.requests.length, 0);
  }
});
test('successful read runs once; log contains only bounded outcomes and no secrets, bodies or URLs', async () => {
  const h = harness();
  const first = h.runner(); assert.equal(h.runner(), first);
  const result = await first;
  assert.equal(result.code, 'META_QA_PREFLIGHT_PASSED'); assert.equal(result.metaPreflightPassed, true);
  assert.equal(result.wabaAppSubscribed, true); assert.equal(result.sandboxPhoneMatches, true);
  assert.equal(result.appSecretVerified, false); assert.equal(result.messageDeliveryVerified, false);
  assert.equal(h.requests.length, 3); assert.equal(h.logs.length, 1);
  for (const { url, options } of h.requests) {
    assert.equal(url.origin, 'https://graph.facebook.com'); assert.equal(options.method, 'GET');
    assert.equal(options.redirect, 'error'); assert.equal(options.body, undefined);
    assert.equal(url.searchParams.has('access_token'), false);
    const appSubscriptions = url.pathname.endsWith(`/${EXPECTED.appId}/subscriptions`);
    assert.deepEqual(options.headers, { Authorization: appSubscriptions
      ? `Bearer ${EXPECTED.appId}|${env.WHATSAPP_META_APP_SECRET}` : `Bearer ${env.WHATSAPP_META_TOKEN_TEST}` });
  }
  for (const forbidden of ['fake-', 'https:', EXPECTED.appId, EXPECTED.phoneNumberId, 'display_phone_number', 'Authorization']) {
    assert.equal(h.logs[0].includes(forbidden), false);
  }
  for (const [key, value] of Object.entries(JSON.parse(h.logs[0]))) {
    assert(key === 'code' || value === null || typeof value === 'boolean' || typeof value === 'number');
  }
});
test('global staging fetch guard continues blocking Graph while private diagnostic reads exact sandbox', async () => {
  let requests = 0;
  const target = { fetch: async url => {
    requests++;
    if (url.pathname.endsWith(`/${EXPECTED.appId}/subscriptions`)) return response({ data: [{ object: 'whatsapp_business_account',
      callback_url: EXPECTED.callbackUrl, fields: ['messages'] }] });
    return url.pathname.endsWith('/subscribed_apps')
      ? response({ data: [{ whatsapp_business_api_data: { id: EXPECTED.appId } }] })
      : response({ id: EXPECTED.phoneNumberId, display_phone_number: '+54 11 5555 5555' });
  } };
  const h = harness({ fetchImpl: target.fetch });
  const restore = installStagingFetchGuard(env, target);
  try {
    await assert.rejects(target.fetch('https://graph.facebook.com/v26.0/1300908966439481/messages', { method: 'POST' }), { code: 'OUTBOUND_DISABLED' });
    assert.equal(requests, 0);
    assert.equal((await h.runner()).metaPreflightPassed, true); assert.equal(requests, 3);
    await assert.rejects(target.fetch('https://graph.facebook.com/v26.0/1300908966439481', { method: 'GET' }), { code: 'OUTBOUND_DISABLED' });
  } finally { restore(); }
});
test('permission errors are unknown subscription, never an absent-subscription claim, with bounded codes only', async () => {
  const h = harness({ fetchImpl: async () => response({ error: { code: 10, error_subcode: 123, message: env.WHATSAPP_META_TOKEN_TEST } }, 403) });
  const result = await h.runner();
  assert.equal(result.code, 'META_READ_REJECTED'); assert.equal(result.wabaAppSubscribed, null);
  assert.equal(result.providerCode, 10); assert.equal(result.providerSubcode, 123);
  assert.equal(h.logs[0].includes(env.WHATSAPP_META_TOKEN_TEST), false);
});
test('subscription absent and sandbox mismatch do not pass', async () => {
  const h = harness({ fetchImpl: async url => {
    if (url.pathname.endsWith(`/${EXPECTED.appId}/subscriptions`)) return response({ data: [{ object: 'whatsapp_business_account',
      callback_url: 'https://wrong.example/webhook', fields: [] }] });
    return url.pathname.endsWith('/subscribed_apps')
      ? response({ data: [{ whatsapp_business_api_data: { id: 'unrelated-app' } }] })
      : response({ id: 'wrong-phone-id', display_phone_number: '+1 555 000 0000' });
  } });
  const result = await h.runner();
  assert.equal(result.code, 'META_QA_PREFLIGHT_INCOMPLETE'); assert.equal(result.wabaAppSubscribed, false);
  assert.equal(result.sandboxPhoneMatches, false); assert.equal(result.metaPreflightPassed, false);
});
test('untrusted paging next URL is never followed; only the cursor travels to fixed Graph host', async () => {
  const requests = [];
  const h = harness({ fetchImpl: async url => {
    requests.push(url);
    if (requests.length === 1) return response({ data: [], paging: { next: 'https://example.invalid/?access_token=do-not-log', cursors: { after: 'next-cursor' } } });
    if (requests.length === 2) return response({ data: [{ whatsapp_business_api_data: { id: EXPECTED.appId } }] });
    if (url.pathname.endsWith(`/${EXPECTED.appId}/subscriptions`)) return response({ data: [{ object: 'whatsapp_business_account',
      callback_url: EXPECTED.callbackUrl, fields: ['messages'] }] });
    return response({ id: EXPECTED.phoneNumberId, display_phone_number: '+54 11 5555 5555' });
  } });
  assert.equal((await h.runner()).metaPreflightPassed, true);
  assert.equal(requests[1].searchParams.get('after'), 'next-cursor');
  assert(requests.every(url => url.origin === 'https://graph.facebook.com'));
  assert.equal(h.logs[0].includes('example.invalid'), false);
});
test('transport rejects sends, writes, production phone, other hosts, token URLs and duplicate parameters', async () => {
  const valid = `https://graph.facebook.com/v26.0/${EXPECTED.wabaId}/subscribed_apps?limit=100`;
  const cases = [
    [valid, { method: 'POST' }], [valid, { method: 'DELETE' }], [valid, { method: 'GET', body: '{}' }],
    [valid, { method: 'GET', redirect: 'follow' }],
    [`https://graph.facebook.com/v26.0/${EXPECTED.phoneNumberId}/messages`, {}],
    ['https://graph.facebook.com/v26.0/19174970468?fields=id,display_phone_number', {}],
    [valid.replace('graph.facebook.com', 'example.invalid'), {}], [valid + '&access_token=secret', {}],
    [valid + '&limit=100', {}], [valid + '#fragment', {}], [valid.replace('https://', 'https://user:secret@'), {}],
  ];
  for (const [url, options] of cases) {
    const h = harness({ verifyImpl: async ({ fetchImpl }) => {
      await fetchImpl(url, { method: 'GET', redirect: 'error', ...options });
      throw new Error('Should never be reached');
    } });
    assert.equal((await h.runner()).code, 'META_QA_CHECK_UNAVAILABLE'); assert.equal(h.requests.length, 0);
  }
});
test('pagination and request budgets are bounded and never silently mark unknown as unsubscribed', async () => {
  let calls = 0;
  const h = harness({ fetchImpl: async () => response({ data: [], paging: { next: 'ignored', cursors: { after: `page-${++calls}` } } }) });
  const result = await h.runner();
  assert.equal(calls, 10); assert.equal(result.code, 'META_PAGINATION_LIMIT'); assert.equal(result.wabaAppSubscribed, null);
  const over = harness({ verifyImpl: async ({ fetchImpl }) => {
    for (let i = 0; i < 13; i++) await fetchImpl(`https://graph.facebook.com/v26.0/${EXPECTED.wabaId}/subscribed_apps?limit=100`, { method: 'GET', redirect: 'error' });
  } });
  assert.equal((await over.runner()).code, 'META_QA_CHECK_UNAVAILABLE'); assert.equal(over.requests.length, 12);
});
test('total timeout aborts transport and logs once even if the transport ignores abort', async () => {
  let signal;
  const h = harness({ timeoutMs: 10, fetchImpl: (_url, options) => { signal = options.signal; return new Promise(() => {}); } });
  assert.equal((await h.runner()).code, 'META_QA_CHECK_TIMEOUT'); assert.equal(signal.aborted, true);
  assert.equal(h.logs.length, 1);
});
test('unexpected exceptions and hostile result fields never enter logs; logger errors do not reject startup', async () => {
  const h = harness({ verifyImpl: async () => ({ error: env.WHATSAPP_META_APP_SECRET,
    providerCode: env.WHATSAPP_META_TOKEN_TEST, providerSubcode: Infinity, httpStatus: 999,
    wabaAppSubscribed: 'https://secret.invalid', sandboxPhoneMatches: {}, body: env.WHATSAPP_META_VERIFY_TOKEN }) });
  const result = await h.runner();
  assert.equal(result.code, 'META_QA_CHECK_UNAVAILABLE'); assert.equal(result.providerCode, null);
  assert.equal(result.providerSubcode, null); assert.equal(result.httpStatus, null);
  assert.equal(result.wabaAppSubscribed, null); assert.equal(result.sandboxPhoneMatches, null);
  assert.equal(h.logs[0].includes('fake-'), false);
  const brokenLogger = harness({ logger: () => { throw new Error('log sink unavailable'); } });
  assert.equal((await brokenLogger.runner()).metaPreflightPassed, true);
  const thrown = harness({ verifyImpl: async () => { throw new Error(env.WHATSAPP_META_APP_SECRET); } });
  assert.equal((await thrown.runner()).code, 'META_QA_CHECK_UNAVAILABLE'); assert.equal(thrown.logs[0].includes('fake-'), false);
});
test('startup hook is nonblocking after HTTP listen and transport is captured before existing staging guard', () => {
  const source = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  assert(source.indexOf('const runWhatsappMetaQaStartupCheck = createWhatsappMetaQaStartupCheck();') < source.indexOf('installStagingFetchGuard();'));
  assert.match(source, /httpServer\.listen\(PORT, \(\) => \{\s+void runWhatsappMetaQaStartupCheck\(\);/);
  assert.equal((source.match(/void runWhatsappMetaQaStartupCheck\(\);/g) || []).length, 1);
});
