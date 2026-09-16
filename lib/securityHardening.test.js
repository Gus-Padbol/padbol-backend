import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { backendRuntime, assertStagingIsolation } from './backendRuntime.js';
import { clientIp, configureRateLimitTrustProxy, createRateLimiter } from './rateLimit.js';
import { createSupabaseCrmRepository } from './crmService.js';
import { verifyMercadoPagoWebhookSignature } from '../routes/mercadopagoWebhook.js';

test('unknown or absent runtime mode fails closed regardless of delivery flags', () => {
  for (const mode of [undefined, '', 'standard', 'typo']) {
    const runtime = backendRuntime({ BACKEND_RUNTIME_MODE: mode, OUTBOUND_DELIVERY_ENABLED: 'true', BACKGROUND_JOBS_ENABLED: 'true', PUSH_SEND_ENABLED: 'true' });
    assert.equal(runtime.outboundDeliveryEnabled, false);
    assert.equal(runtime.backgroundJobsEnabled, false);
    assert.equal(runtime.pushSendEnabled, false);
  }
});

test('known runtime still requires explicit switches and clientIp trusts Express only', () => {
  assert.equal(backendRuntime({ BACKEND_RUNTIME_MODE: 'production' }).outboundDeliveryEnabled, false);
  assert.equal(backendRuntime({ BACKEND_RUNTIME_MODE: 'production', OUTBOUND_DELIVERY_ENABLED: 'true' }).outboundDeliveryEnabled, true);
  assert.equal(clientIp({ ip: '203.0.113.8', headers: { 'x-forwarded-for': '1.2.3.4' }, socket: {} }), '203.0.113.8');
});

test('normalized staging mode cannot bypass isolation and proxy trust is opt-in', () => {
  assert.throws(() => assertStagingIsolation({ BACKEND_RUNTIME_MODE: ' Staging ' }), /STAGING_SUPABASE_ISOLATION_REQUIRED/);
  const calls = [];
  const previous = process.env.RATE_LIMIT_TRUST_PROXY;
  delete process.env.RATE_LIMIT_TRUST_PROXY;
  configureRateLimitTrustProxy({ set(...args) { calls.push(args); } });
  assert.deepEqual(calls, []);
  process.env.RATE_LIMIT_TRUST_PROXY = 'true';
  configureRateLimitTrustProxy({ set(...args) { calls.push(args); } });
  assert.deepEqual(calls, [['trust proxy', 1]]);
  if (previous === undefined) delete process.env.RATE_LIMIT_TRUST_PROXY;
  else process.env.RATE_LIMIT_TRUST_PROXY = previous;
});

test('rate limiter cannot be bypassed with forged X-Forwarded-For', () => {
  const limiter = createRateLimiter({ name: 'test', windowMs: 60_000, max: 1 });
  const response = () => ({ statusCode: 200, headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } });
  const req = (xff) => ({ ip: '203.0.113.8', headers: { 'x-forwarded-for': xff }, method: 'POST', path: '/x' });
  limiter(req('1.1.1.1'), response(), () => {});
  const res = response();
  limiter(req('2.2.2.2'), res, () => assert.fail('must be limited'));
  assert.equal(res.statusCode, 429);
});

test('CRM contact lookup uses equality builders and bounded merge, never raw or()', async () => {
  const calls = [];
  const rows = { email_normalized: [{ id: 'a' }, { id: 'shared' }], phone_normalized: [{ id: 'shared' }, { id: 'b' }] };
  const supabase = { from() { return { select() { return this; }, eq(column, value) { calls.push({ column, value }); this.column = column; return this; }, limit(value) { calls.push({ limit: value }); return Promise.resolve({ data: rows[this.column], error: null }); } }; } };
  const repository = createSupabaseCrmRepository(supabase);
  const result = await repository.findContactsByEmailOrPhone('a,b@example.com', '5492215551234');
  assert.deepEqual(calls, [
    { column: 'email_normalized', value: 'a,b@example.com' }, { limit: 3 },
    { column: 'phone_normalized', value: '5492215551234' }, { limit: 3 },
  ]);
  assert.deepEqual(result.map((row) => row.id), ['a', 'shared', 'b']);
});

test('Mercado Pago signature validates timestamp and rejects unsigned production/QA traffic', () => {
  const now = 1_800_000_000_000;
  const ts = String(Math.floor(now / 1000));
  const secret = 'fixture-secret';
  const requestId = 'request-123';
  const dataId = '98765';
  const manifest = `id:${dataId};request-id:${requestId};ts:${ts};`;
  const v1 = crypto.createHmac('sha256', secret).update(manifest).digest('hex');
  const req = { headers: { 'x-signature': `ts=${ts},v1=${v1}`, 'x-request-id': requestId }, query: { 'data.id': dataId }, body: {} };
  const verified = verifyMercadoPagoWebhookSignature(req, { env: { BACKEND_RUNTIME_MODE: 'production', MERCADOPAGO_WEBHOOK_SECRET: secret }, now });
  assert.equal(verified.ok, true);
  assert.equal(verified.replay, false);
  assert.ok(verified.replayKey);
  const legacyReq = { headers: { 'x-signature': `ts=${ts},v1=${v1}`, 'x-request-id': requestId }, query: { topic: 'payment', id: dataId }, body: {} };
  assert.equal(verifyMercadoPagoWebhookSignature(legacyReq, { env: { BACKEND_RUNTIME_MODE: 'production', MERCADOPAGO_WEBHOOK_SECRET: secret }, now }).ok, true);
  assert.equal(verifyMercadoPagoWebhookSignature({ headers: {}, query: {}, body: {} }, { env: { BACKEND_RUNTIME_MODE: 'staging' }, now }).ok, false);
  assert.equal(verifyMercadoPagoWebhookSignature({ headers: {}, query: {}, body: {} }, { env: { BACKEND_RUNTIME_MODE: 'development' }, now }).compatibilityUnsigned, true);
});
