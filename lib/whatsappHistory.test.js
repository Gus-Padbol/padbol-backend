import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHistoryPage, createWhatsappHistoryService } from './whatsappHistory.js';
const tenant = '11111111-1111-4111-8111-111111111111';
const id = '22222222-2222-4222-8222-222222222222';
const cursor = value => Buffer.from(JSON.stringify(value)).toString('base64url');
test('pagination defaults and maximum preserve microseconds', () => {
  assert.deepEqual(parseHistoryPage({}, tenant), { limit: 25, before: null });
  assert.deepEqual(parseHistoryPage({ limit: '50', before: cursor([1, tenant, '2026-09-10T10:01:02.123456Z', id]) }, tenant),
    { limit: 50, before: { at: '2026-09-10T10:01:02.123456Z', id } });
});
test('rejects excessive/negative/repeated/object limits and unknown filters', () => {
  for (const query of [{ limit: '51' }, { limit: '0' }, { limit: '-1' }, { limit: ['1', '2'] },
    { limit: '1.2' }, { limit: {} }, { role: 'super_admin' }, { sede_id: '2' }]) {
    assert.throws(() => parseHistoryPage(query, tenant), { code: 'INVALID_PAGE', status: 400 });
  }
});
test('rejects cursor for another tenant, unknown version, invalid date, UUID and malformed JSON', () => {
  for (const value of [[1, id, '2026-09-10T10:01:02.123456Z', id], [2, tenant, '2026-09-10T10:01:02.123456Z', id],
    [1, tenant, '2026-02-31T10:01:02.123456Z', id], [1, tenant, '2026-09-10T10:01:02.123456Z', 'bad']]) {
    assert.throws(() => parseHistoryPage({ before: cursor(value) }, tenant), { code: 'INVALID_PAGE' });
  }
  for (const before of ['*', 'x'.repeat(513), 'abc', {}, ['x']]) {
    assert.throws(() => parseHistoryPage({ before }, tenant), { code: 'INVALID_PAGE' });
  }
});
test('fails closed without authenticated identity or configured SQL client', async () => {
  const service = createWhatsappHistoryService({ pgPool: null });
  await assert.rejects(service.listTenants(null), { status: 401 });
  await assert.rejects(service.listTenants(id), { status: 503 });
});
