import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { quoteReservaPrice, assertClientPrecioMatchesQuote } from './pricing/quoteReservaPrice.js';
import { applyMembresiaBenefitsToQuote } from './membresiasDomain.js';
import { normalizeStripeCurrency, toStripeMinorUnits } from './stripe/stripeAmount.js';
import {
  ensureReservaPendienteParaMpPg,
  normalizeCrearPreferenciaReservaInput,
  persistMercadoPagoPreferencePg,
  persistStripeCheckoutSessionPg,
} from '../routes/reservaPendienteMp.js';

const owner = { id: 'server-authenticated-user', email: 'test@example.invalid' };
const source = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const helpers = source.slice(source.indexOf('function normalizePaymentExtras('), source.indexOf('function computePartidoDeadlineCancel('));

function database({ benefits = null, basePrice = 100 } = {}) {
  const reads = [];
  const tables = {
    sedes: [{ id: 7, nombre: 'Fixture court', moneda: 'USD', precio_90min: basePrice }],
    sede_extras: [{ id: 9, sede_id: 7, nombre: 'Fixture extra', precio: 10, precio_moneda: 'USD', activo: true, aprobado_super: true }],
    franjas_precio: [], sedes_duraciones: [], surge_config: [],
    membresias_sede: benefits ? [{ id: 4, sede_id: 7, user_id: owner.id, estado: 'activa', inicio: '2026-01-01', vencimiento: '2099-01-01', plan_id: 3 }] : [],
    membresia_planes: benefits ? [{ id: 3, sede_id: 7, beneficios: benefits }] : [],
    membresia_usos_reserva: [],
  };
  return {
    reads,
    from(table) {
      assert.ok(table in tables, `unexpected table: ${table}`);
      let rows = tables[table];
      const result = () => ({ data: rows, error: null, count: rows.length });
      const query = {
        select() { return query; }, order() { return query; }, limit() { return query; }, or() { return query; },
        eq(field, value) { reads.push({ table, field, value }); rows = rows.filter(row => row[field] === value); return query; },
        in(field, values) { rows = rows.filter(row => values.includes(row[field])); return query; },
        maybeSingle() { return Promise.resolve({ data: rows[0] ?? null, error: null }); },
        then(resolve, reject) { return Promise.resolve(result()).then(resolve, reject); },
      };
      return query;
    },
  };
}

async function quote(options = {}, db = database()) {
  return quoteReservaPrice(db, { sedeId: 7, deporte: 'padbol', duracionMinutos: 90, userId: owner.id, ...options });
}

test('server quote charges 100 for a court priced 100 and preserves pricing/snapshot contracts', async () => {
  const result = await quote({ fee: 3, precio: 103, pricing: { base: 1, fee: 999, total: 1 } });
  assert.deepEqual(result.pricing, { base: 100, fee: 0, extrasSubtotal: 0, total: 100 });
  assert.equal(result.pricing_snapshot.fee, 0);
  assert.equal(result.pricing_snapshot.total, 100);
  assert.equal(result.moneda, 'USD');
});

test('extras use stored prices and quantities, without charging the old 3%', async () => {
  const result = await quote({ extras: [{ id: 9, cantidad: 2, precio: 0.01, nombre: 'forged name' }] });
  assert.deepEqual(result.pricing, { base: 100, fee: 0, extrasSubtotal: 20, total: 120 });
  assert.equal(result.extras[0].precio, 10);
  assert.equal(result.extras[0].nombre, 'Fixture extra');
});

test('membership discount keeps its benefit and also pays zero player fee', async () => {
  const result = await quote({ extras: [{ id: 9, cantidad: 2 }] }, database({ benefits: { descuento_porcentual: 10 } }));
  assert.deepEqual(result.pricing, { base: 90, fee: 0, extrasSubtotal: 20, total: 110 });
  assert.equal(result.membresia.descuento_monto, 10);
});

test('included membership reservation charges only optional extras', async () => {
  const result = await quote({ extras: [{ id: 9, cantidad: 2 }] }, database({ benefits: { reservas_incluidas_por_periodo: 1 } }));
  assert.deepEqual(result.pricing, { base: 0, fee: 0, extrasSubtotal: 20, total: 20 });
  assert.equal(result.membresia.reserva_incluida, true);
});

test('membership domain default cannot reintroduce a 3% fee', () => {
  const result = applyMembresiaBenefitsToQuote({ base: 100, extrasSubtotal: 20, beneficios: {} });
  assert.equal(result.fee, 0);
  assert.equal(result.total, 120);
});

function checkoutFixture({ provider, authenticated = true, confirmed = false, wrongOwner = false, basePrice = 100 } = {}) {
  const db = database({ basePrice });
  const providerRequests = [];
  const saved = [];
  let handler;
  const pgPool = {
    async query(sql, params) {
      if (/SELECT metodo_pago/.test(sql)) return { rows: [{ metodo_pago: 'stripe', moneda: 'USD' }] };
      if (/SELECT id, estado, pago_estado, user_id, email FROM reservas/.test(sql)) {
        return { rows: [{ id: 42, estado: confirmed ? 'confirmada' : 'pendiente', pago_estado: confirmed ? 'pagado' : 'pendiente', user_id: wrongOwner ? 'other-user' : owner.id, email: wrongOwner ? 'other@example.invalid' : owner.email }] };
      }
      if (/UPDATE reservas/.test(sql)) { saved.push({ sql, params }); return { rows: [] }; }
      throw new Error(`unexpected fixture SQL: ${sql}`);
    },
  };
  const auth = async () => authenticated ? { user: owner } : { user: null, status: 401, error: 'Unauthorized' };
  const context = {
    app: { post(_path, _limiter, callback) { handler = callback; } }, paymentsRateLimit() {},
    supabaseAdmin: db, SUPABASE_SERVICE_ROLE_KEY: 'fixture-only-present', pgPool,
    quoteReservaPrice, assertClientPrecioMatchesQuote, normalizeCrearPreferenciaReservaInput,
    ensureReservaPendienteParaMpPg, persistMercadoPagoPreferencePg, persistStripeCheckoutSessionPg,
    normalizeStripeCurrency, toStripeMinorUnits,
    getAuthenticatedUser: auth,
    requireAuthenticatedUser: async (_req, res) => { const result = await auth(); if (!result.user) res.status(401).json({ error: 'Unauthorized' }); return result.user; },
    parsePositiveInt: value => Number.parseInt(value, 10) || null,
    registerMembresiaUsoIncluidaIfNeeded: async () => {},
    mpClient: {}, MercadoPagoConfig: class {},
    fetchSedeMpCredentialsPg: async () => ({ mp_access_token: 'fixture-only-present' }),
    Preference: class { async create(request) { providerRequests.push(request); return { id: 'fixture-mp-id', init_point: 'https://fixture.invalid/checkout' }; } },
    stripeClient: { checkout: { sessions: { async create(request) { providerRequests.push(request); return { id: 'fixture-stripe-id', url: 'https://fixture.invalid/checkout' }; } } } },
    FRONTEND_URL: 'https://fixture.invalid', process: { env: {} },
    console: { log() {}, warn() {}, error() {} },
    logCrearPreferenciaError() {}, summarizeError: error => ({ message: error.message }), serializeRawErrorForLog: error => ({ message: error.message }),
    crearPreferenciaSupabaseLogActive: false, crearPreferenciaSupabaseLogSeq: 0,
  };
  const path = provider === 'mp' ? '/api/crear-preferencia' : '/api/crear-pago-stripe';
  const start = source.indexOf(`app.post('${path}',`);
  assert.ok(start >= 0);
  const end = source.indexOf('\n});', start) + '\n});'.length;
  vm.runInNewContext(helpers + '\n' + source.slice(start, end), context);
  return { handler, providerRequests, saved, db };
}

function response() {
  return { statusCode: 200, headersSent: false, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; this.headersSent = true; return this; } };
}

for (const provider of ['mp', 'stripe']) {
  test(`${provider} installed client can send old total 10300 while provider receives 10000`, async () => {
    const fixture = checkoutFixture({ provider, basePrice: 10000 });
    const res = response();
    await fixture.handler({ body: { titulo: 'Fixture booking', sedeId: 7, moneda: 'USD', precio: 10300, reservaData: { reserva_id: 42, platform_fee: 300 } } }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.precio_esperado, 10000);
    assert.equal(res.body.pricing.fee, 0);
    const items = provider === 'mp' ? fixture.providerRequests[0].body.items : fixture.providerRequests[0].line_items;
    assert.equal(items.length, 1);
    assert.equal(provider === 'mp' ? items[0].unit_price : items[0].price_data.unit_amount / 100, 10000);
  });

  for (const extras of [[], [{ id: 9, cantidad: 2, precio: 0.01 }]]) {
    test(`${provider} route uses server quote for provider and pending reservation, extras=${extras.length}`, async () => {
      const fixture = checkoutFixture({ provider });
      const total = extras.length ? 120 : 100;
      const res = response();
      await fixture.handler({ body: {
        titulo: 'Fixture booking', sedeId: 7, moneda: 'USD', precio: 1, extras,
        pricing: { base: 1, fee: 999, total: 1 }, user_id: 'forged-user',
        reservaData: { reserva_id: 42, user_id: 'forged-user', precio: 1, precio_base: 1, platform_fee: 999 },
      } }, res);
      // With extras, 1 exceeds the existing mismatch tolerance: retry using the old-client amount.
      if (extras.length) {
        assert.equal(res.statusCode, 400);
        assert.equal(fixture.providerRequests.length, 0);
        const retry = response();
        await fixture.handler({ body: { titulo: 'Fixture booking', sedeId: 7, moneda: 'USD', precio: 124, extras, pricing: { base: 1, fee: 999, total: 1 }, reservaData: { reserva_id: 42, user_id: 'forged-user', platform_fee: 999 } } }, retry);
        Object.assign(res, retry);
      }
      assert.equal(res.statusCode, 200);
      assert.equal(res.body.precio_esperado, total);
      assert.equal(res.body.pricing.fee, 0);
      assert.equal(fixture.providerRequests.length, 1);
      const items = provider === 'mp' ? fixture.providerRequests[0].body.items : fixture.providerRequests[0].line_items;
      assert.equal(items.length, 1 + extras.length);
      const providerTotal = items.reduce((sum, item) => sum + item.quantity * (provider === 'mp' ? item.unit_price : item.price_data.unit_amount / 100), 0);
      assert.equal(providerTotal, total);
      assert.doesNotMatch(JSON.stringify(items), /3%|comisi[oó]n/i);
      const pricingWrite = fixture.saved.find(call => /pricing_snapshot/.test(call.sql));
      assert.ok(pricingWrite);
      assert.equal(pricingWrite.params[1], total);
      assert.equal(pricingWrite.params[2], total);
      assert.equal(JSON.parse(pricingWrite.params[4]).fee, 0);
      assert.equal(pricingWrite.params[5], owner.id);
    });
  }

  test(`${provider} unauthenticated request creates no preference or reservation write`, async () => {
    const fixture = checkoutFixture({ provider, authenticated: false });
    const res = response();
    await fixture.handler({ body: { titulo: 'Fixture booking', sedeId: 7 } }, res);
    assert.equal(res.statusCode, 401);
    assert.equal(fixture.providerRequests.length, 0);
    assert.equal(fixture.saved.length, 0);
  });

  for (const [option, expected] of [['confirmed', 409], ['wrongOwner', 403]]) {
    test(`${provider} preserves ${option} reservation protection`, async () => {
      const fixture = checkoutFixture({ provider, [option]: true });
      const res = response();
      await fixture.handler({ body: { titulo: 'Fixture booking', sedeId: 7, precio: 103, reservaData: { reserva_id: 42 } } }, res);
      assert.equal(res.statusCode, expected);
      assert.equal(fixture.providerRequests.length, 0);
      assert.equal(fixture.saved.length, 0);
    });
  }
}

test('provider builders never add a player commission even with stale fee input', () => {
  const result = vm.runInNewContext(helpers + `\n({mp:buildMercadoPagoItems({titulo:'Fixture',moneda:'USD',pricing:{base:100,fee:3}}),stripe:buildStripeLineItems({titulo:'Fixture',moneda:'USD',pricing:{base:100,fee:3}})})`, { normalizeStripeCurrency, toStripeMinorUnits });
  assert.equal(result.mp.length, 1);
  assert.equal(result.mp[0].unit_price, 100);
  assert.equal(result.stripe.length, 1);
  assert.equal(result.stripe[0].price_data.unit_amount, 10000);
});

test('legacy compatibility does not accept an unrelated or substantially underpriced total', () => {
  assert.doesNotThrow(() => assertClientPrecioMatchesQuote(10300, 10000));
  assert.doesNotThrow(() => assertClientPrecioMatchesQuote(10000, 10000));
  assert.throws(() => assertClientPrecioMatchesQuote(10700, 10000), error => error.status === 400);
  assert.throws(() => assertClientPrecioMatchesQuote(1, 10000), error => error.status === 400);
});
