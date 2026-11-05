import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createSpaceUploadToken, verifySpaceUploadToken } from './crmSpaceUploadToken.js';

const secret = 'local-test-only-secret';
const conversationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const nowSeconds = 1800000000;
const claims = { v: 1, scope: 'commercial-space-upload', conversationId, iat: nowSeconds, exp: nowSeconds + 600 };
const issue = options => createSpaceUploadToken({ secret, conversationId, nowSeconds, ...options });
const verify = (token, options) => verifySpaceUploadToken({ token, secret, conversationId, nowSeconds, ...options });
function signed(value) {
  const payload = Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${payload}.${createHmac('sha256', secret).update('padbol:commercial-space-upload:v1.' + payload).digest('base64url')}`;
}
const rejects = fn => assert.throws(fn, error => error.code === 'SPACE_UPLOAD_TOKEN_INVALID' && error.status === 401);

test('round trip and server interoperability with exact wire algorithm', () => {
  assert.equal(issue(), signed(claims));
  assert.deepEqual(verify(issue()), claims);
  assert.deepEqual(verify(issue(), { conversationId: conversationId.toUpperCase() }), claims);
  assert.equal(verify(issue({ ttlSeconds: 1 })).exp, nowSeconds + 1);
  assert.equal(verify(issue(), { nowSeconds: nowSeconds + 599 }).scope, 'commercial-space-upload');
});
test('reject expired tokens including the exact expiration second', () => {
  for (const offset of [600, 601, 1000]) rejects(() => verify(issue(), { nowSeconds: nowSeconds + offset }));
});
test('reject wrong secret, payload tampering and destination mismatch', () => {
  rejects(() => verify(issue(), { secret: 'another-secret' }));
  const [payload, mac] = issue().split('.');
  rejects(() => verify(`${payload.slice(0, -1)}A.${mac}`));
  rejects(() => verify(issue(), { conversationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }));
  rejects(() => verify(issue(), { conversationId: undefined }));
});
test('reject valid signatures with wrong scope, malformed claims or invalid times', () => {
  for (const patch of [
    { scope: 'read' }, { v: 2 }, { conversationId: '../private' }, { conversationId: null },
    { iat: nowSeconds + 1 }, { iat: -1 }, { iat: String(nowSeconds) }, { iat: nowSeconds + .1 },
    { exp: nowSeconds }, { exp: nowSeconds - 1 }, { exp: nowSeconds + 601 },
    { exp: String(nowSeconds + 100) }, { exp: Number.MAX_SAFE_INTEGER + 1 }, { extra: 'read' },
  ]) rejects(() => verify(signed({ ...claims, ...patch })));
  for (const value of [null, [], 'string', { ...claims, iat: undefined }]) rejects(() => verify(signed(value)));
});
test('reject malformed and oversized tokens without parser or crypto errors', () => {
  const token = issue();
  for (const value of [undefined, null, {}, '', 'a', 'a.b.c', '.', 'a.!!!!', token + '=', 'x'.repeat(4097), ` ${token}`, `${token}\n`, token.split('.')[0] + '.YQ']) {
    rejects(() => verify(value));
  }
});
test('issuance rejects invalid configuration, IDs and TTLs', () => {
  for (const options of [
    { secret: '' }, { secret: ' ' }, { secret: undefined }, { conversationId: '../x' }, { conversationId: null },
    { ttlSeconds: 0 }, { ttlSeconds: -1 }, { ttlSeconds: 601 }, { ttlSeconds: 1.5 },
    { nowSeconds: -1 }, { nowSeconds: 1.5 }, { nowSeconds: Number.MAX_SAFE_INTEGER },
  ]) assert.throws(() => issue(options), TypeError);
  rejects(() => verify(issue(), { secret: '' }));
  rejects(() => verify(issue(), { nowSeconds: -1 }));
});
