import assert from 'node:assert/strict';
import test from 'node:test';
import { EXPECTED, configurationSummary, verifyMetaSandbox } from './verify-meta-sandbox-v26.mjs';
import { createWhatsappMetaSender, environmentWhatsappAccessTokenResolver } from './whatsappCloud.js';
const env = { WHATSAPP_META_TOKEN_TEST: 'test-only-credential', WHATSAPP_META_APP_SECRET: 'test-only-app-secret',
  WHATSAPP_META_VERIFY_TOKEN: 'test-only-verify', WHATSAPP_META_GRAPH_VERSION: 'v26.0',
  OUTBOUND_DELIVERY_ENABLED: 'false', WHATSAPP_CLOUD_SEND_ENABLED: 'false',
  BACKGROUND_JOBS_ENABLED: 'false', PUSH_SEND_ENABLED: 'false', WHATSAPP_CLOUD_MAX_SEND_ATTEMPTS: '1' };
const response = (data, status = 200) => ({ ok: status === 200, status, async json() { return data; } });
function successfulFetch(requests) {
  return async (url, options) => {
    const parsed = new URL(url); requests.push(parsed.pathname);
    assert.equal(options.method, 'GET'); assert.equal(parsed.hostname, 'graph.facebook.com');
    assert.equal(options.redirect, 'error'); assert.equal(parsed.searchParams.has('access_token'), false);
    const appSubscriptions = parsed.pathname.endsWith(`/${EXPECTED.appId}/subscriptions`);
    assert.equal(options.headers.Authorization, appSubscriptions
      ? `Bearer ${EXPECTED.appId}|${env.WHATSAPP_META_APP_SECRET}`
      : `Bearer ${env.WHATSAPP_META_TOKEN_TEST}`);
    if (appSubscriptions) return response({ data: [{ object: 'whatsapp_business_account',
      callback_url: EXPECTED.callbackUrl, fields: [{ name: 'messages' }] }] });
    return parsed.pathname.endsWith('/subscribed_apps')
      ? response({ data: [{ whatsapp_business_api_data: { id: EXPECTED.appId } }] })
      : response({ id: EXPECTED.phoneNumberId, display_phone_number: '+1 555 671 1531' });
  };
}
test('missing token fails closed before any request and prints only names', async () => {
  const result = await verifyMetaSandbox({ env: {}, fetchImpl() { throw new Error('Must not call'); } });
  assert.equal(result.error, 'WHATSAPP_META_TOKEN_TEST_REQUIRED');
  assert.equal(result.wabaAppSubscribed, null);
  assert(configurationSummary({}).missing.includes('WHATSAPP_META_APP_SECRET'));
});
test('read-only WABA and sandbox number checks are repeatable and do not activate anything', async () => {
  const requests = []; const fetchImpl = successfulFetch(requests);
  for (let i = 0; i < 2; i += 1) {
    const result = await verifyMetaSandbox({ env, fetchImpl });
    assert.equal(result.wabaAppSubscribed, true); assert.equal(result.sandboxPhoneMatches, true);
    assert.equal(result.metaPreflightPassed, true);
    assert.equal(result.configuration.outboundGateEnabled, false);
    assert(!JSON.stringify(result).includes(env.WHATSAPP_META_TOKEN_TEST));
  }
  assert.equal(requests.length, 6);
});
test('a different app is not mistaken for the expected subscription', async () => {
  const result = await verifyMetaSandbox({ env, fetchImpl: async () => response({ data: [{ whatsapp_business_api_data: { id: '999' } }] }) });
  assert.equal(result.wabaAppSubscribed, false); assert.equal(result.metaPreflightPassed, false);
});
test('provider errors never echo raw body, token, secret or provider message', async () => {
  const result = await verifyMetaSandbox({ env, fetchImpl: async () => response({ error: { code: 190, message: env.WHATSAPP_META_TOKEN_TEST, payload: env.WHATSAPP_META_APP_SECRET } }, 400) });
  assert.equal(result.error, 'META_READ_REJECTED'); assert.equal(result.providerCode, 190);
  assert(!JSON.stringify(result).includes('test-only'));
});
test('paging uses only fixed Graph host and cursor, never provider next URL', async () => {
  let count = 0;
  const result = await verifyMetaSandbox({ env, fetchImpl: async (url, options) => {
    const parsed = new URL(url); assert.equal(parsed.hostname, 'graph.facebook.com'); assert.equal(options.method, 'GET');
    if (count++ === 0) return response({ data: [], paging: { next: 'https://untrusted.invalid/?access_token=secret', cursors: { after: 'cursor-2' } } });
    if (count === 2) { assert.equal(parsed.searchParams.get('after'), 'cursor-2'); return response({ data: [{ whatsapp_business_api_data: { id: EXPECTED.appId } }] }); }
    if (parsed.pathname.endsWith(`/${EXPECTED.appId}/subscriptions`)) return response({ data: [{ object: 'whatsapp_business_account',
      callback_url: EXPECTED.callbackUrl, fields: ['messages'] }] });
    return response({ id: EXPECTED.phoneNumberId, display_phone_number: '+54 11 5555 5555' });
  } });
  assert.equal(result.metaPreflightPassed, true); assert.equal(count, 4);
});
test('wrong number or API version never passes activation checks', async () => {
  assert.equal((await verifyMetaSandbox({ env: { ...env, WHATSAPP_META_GRAPH_VERSION: 'v25.0' }, fetchImpl() { throw new Error('No call'); } })).error, 'GRAPH_VERSION_V26_REQUIRED');
  const result = await verifyMetaSandbox({ env, fetchImpl: async (url) => String(url).includes('subscribed_apps')
    ? response({ data: [{ whatsapp_business_api_data: { id: EXPECTED.appId } }] })
    : response({ id: 'wrong-phone-id', display_phone_number: '+1 555 000 0000' }) });
  assert.equal(result.sandboxPhoneMatches, false); assert.equal(result.metaPreflightPassed, false);
});
test('frozen published sender accepts v26.0 and TEST reference with mocked transport only', async () => {
  let calls = 0;
  const sender = createWhatsappMetaSender({ graphVersion: 'v26.0', resolveAccessToken: environmentWhatsappAccessTokenResolver(env),
    fetchImpl: async (url, options) => {
      calls += 1; assert.equal(url, `https://graph.facebook.com/v26.0/${EXPECTED.phoneNumberId}/messages`);
      assert.equal(options.headers.Authorization, `Bearer ${env.WHATSAPP_META_TOKEN_TEST}`);
      return response({ messages: [{ id: 'mock-only-message-id' }] });
    } });
  assert.deepEqual(await sender.sendText({ channel: { credential_ref: 'TEST', meta_phone_number_id: EXPECTED.phoneNumberId },
    toWaId: '15550000001', body: 'Local mock only' }), { providerMessageId: 'mock-only-message-id' });
  assert.equal(calls, 1);
});
