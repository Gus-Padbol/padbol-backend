import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startLedgerFixture, known } from './nextGenerationLedger.fixture035.mjs';

let fx, baseUrl, pool;
const { requestA: VA, requestB: VB } = known;
async function call(method, url, body, token = 'super') {
  const headers = {}; if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const r = await fetch(baseUrl + url, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  let data = null; try { data = await r.json(); } catch {}
  return { status: r.status, body: data };
}
const overview = (venue = VA, currency = 'USD', token = 'super') => call('GET', `/api/admin/next-generation/cuentas?venue_request_id=${venue}&currency=${currency}`, undefined, token);
const move = (body, token = 'super') => call('POST', '/api/admin/next-generation/cuentas/movimientos', { venue_request_id: VA, currency: 'USD', ...body }, token);

before(async () => { fx = await startLedgerFixture(); baseUrl = fx.baseUrl; pool = fx.pool; });
beforeEach(async () => {
  await pool.query('TRUNCATE public.ng_cuenta_movimientos, public.ng_cuentas_programa');
  await pool.query("UPDATE public.ng_solicitudes_sede SET estado='aprobada',canonical_sede_id=1 WHERE id=$1", [VA]);
  await pool.query("UPDATE public.ng_solicitudes_sede SET estado='aprobada',canonical_sede_id=2 WHERE id=$1", [VB]);
  process.env.NEXTGEN_MANUAL_LEDGER_ENABLED = 'true';
});
after(async () => { if (fx) await fx.stop(); });

test('success summary, exact string amounts, funds not income', async () => {
  const a = await move({ operation_key: 'sponsor-1', type: 'sponsor_cobrado', amount: '100.00' }); assert.equal(a.status, 200, JSON.stringify(a.body));
  assert.equal((await move({ operation_key: 'gasto-1', type: 'gasto', amount: '20.00' })).status, 200);
  assert.equal((await move({ operation_key: 'fond-1', type: 'apartar_fondo', amount: '30.00' })).status, 200);
  assert.equal((await move({ operation_key: 'liber-1', type: 'liberar_fondo', amount: '10.00' })).status, 200);
  const r = await overview(); assert.equal(r.status, 200);
  assert.equal(r.body.summary.collected_income, '100.00');
  assert.equal(r.body.summary.expense, '20.00');
  assert.equal(r.body.summary.reserved_fund, '20.00');
  assert.equal(r.body.summary.available, '60.00');
  assert.equal(r.body.account.currency, 'USD'); assert.equal(r.body.movements.length, 4);
  assert.equal(typeof r.body.movements[0].amount, 'string');
  assert.ok(!('cuota_cobrada' in r.body.summary));
});
test('concurrent same operation key creates one row; different payload conflicts', async () => {
  const [a,b] = await Promise.all([
    move({ operation_key: 'concurrent-1', type: 'sponsor_cobrado', amount: '50.00' }),
    move({ operation_key: 'concurrent-1', type: 'sponsor_cobrado', amount: '50.00' }),
  ]);
  assert.deepEqual([a.status,b.status], [200,200]);
  assert.equal((await pool.query('SELECT count(*)::int n FROM public.ng_cuenta_movimientos')).rows[0].n, 1);
  const conflict = await move({ operation_key: 'concurrent-1', type: 'sponsor_cobrado', amount: '51.00' });
  assert.equal(conflict.status, 409);
  assert.equal((await pool.query('SELECT count(*)::int n FROM public.ng_cuenta_movimientos')).rows[0].n, 1);
});
test('reversal once, same account and exact amount; nonnegative guard', async () => {
  const sponsor = await move({ operation_key: 'sponsor-r', type: 'sponsor_cobrado', amount: '100.00' }); assert.equal(sponsor.status,200);
  const gasto = await move({ operation_key: 'gasto-r', type: 'gasto', amount: '80.00' }); assert.equal(gasto.status,200);
  const bad = await move({ operation_key: 'rev-sponsor', type: 'reversion', amount: '100.00', original_id: sponsor.body.movements[0].id });
  assert.equal(bad.status, 409);
  const gastoId = gasto.body.movements.find(m => m.type === 'gasto').id;
  const rev = await move({ operation_key: 'rev-gasto', type: 'reversion', amount: '80.00', original_id: gastoId }); assert.equal(rev.status,200);
  assert.equal((await move({ operation_key: 'rev-gasto-2', type: 'reversion', amount: '80.00', original_id: gastoId })).status, 409);
  assert.equal((await overview()).body.summary.available, '100.00');
});
test('two requests and currencies are isolated', async () => {
  assert.equal((await move({ operation_key: 'a-usd', type: 'sponsor_cobrado', amount: '10.00' })).status, 200);
  assert.equal((await move({ venue_request_id: VB, currency: 'USD', operation_key: 'b-usd', type: 'sponsor_cobrado', amount: '20.00' })).status, 200);
  assert.equal((await move({ currency: 'EUR', operation_key: 'a-eur', type: 'sponsor_cobrado', amount: '7.00' })).status, 200);
  assert.equal((await overview(VA,'USD')).body.summary.collected_income, '10.00');
  assert.equal((await overview(VB,'USD')).body.summary.collected_income, '20.00');
  assert.equal((await overview(VA,'EUR')).body.summary.collected_income, '7.00');
});
test('disabled, non-super, map drift and late SQL failure do not mutate', async () => {
  process.env.NEXTGEN_MANUAL_LEDGER_ENABLED = 'false';
  assert.equal((await overview()).status, 503);
  process.env.NEXTGEN_MANUAL_LEDGER_ENABLED = 'true';
  assert.equal((await overview(VA,'USD','club')).status, 403);
  assert.equal((await move({ operation_key: 'club', type: 'sponsor_cobrado', amount: '1.00' }, 'club')).status, 403);
  assert.equal((await move({ operation_key: 'anchor', type: 'sponsor_cobrado', amount: '1.00' })).status, 200);
  await pool.query("UPDATE public.ng_solicitudes_sede SET canonical_sede_id=3 WHERE id=$1", [VA]);
  assert.equal((await move({ operation_key: 'drift', type: 'sponsor_cobrado', amount: '1.00' })).status, 409);
  await pool.query("UPDATE public.ng_solicitudes_sede SET canonical_sede_id=1 WHERE id=$1", [VA]);
  assert.equal((await move({ operation_key: 'base', type: 'sponsor_cobrado', amount: '100.00' })).status, 200);
  assert.equal((await move({ operation_key: 'spend', type: 'gasto', amount: '100.00' })).status, 200);
  const before = (await overview()).body.summary.available;
  assert.equal((await move({ operation_key: 'late', type: 'reversion', amount: '100.00', original_id: (await overview()).body.movements.find(m=>m.type==='sponsor_cobrado'&&m.amount==='100.00').id })).status, 409);
  assert.equal((await overview()).body.summary.available, before);
  assert.equal((await pool.query('SELECT count(*)::int n FROM public.ng_cuenta_movimientos')).rows[0].n, 3);
});
