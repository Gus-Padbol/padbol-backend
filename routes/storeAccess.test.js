import test from 'node:test';
import assert from 'node:assert/strict';
import { buildStoreApp, LEGACY_SUPER_EMAILS, listen, request } from './storeTestHarness.js';

/**
 * Supabase-shaped fixture for the admin reads. The permission matrix must decide
 * before touching the database, so every denied call runs against this fixture
 * without observing it.
 */
function fakeSupabase() {
  const tables = {
    sedes: [
      { id: 7, nombre: 'Sede Siete', pais: 'AR', ciudad: 'La Plata' },
      { id: 8, nombre: 'Sede Ocho', pais: 'AR', ciudad: 'La Plata' },
    ],
    store_catalog_products: [
      { id: 1, slug: 'chivi-figure', nombre: 'Chivi figura', activo: true },
    ],
    store_central_offers: [],
    store_sede_config: [
      { sede_id: 7, estado: 'active', retiro_en_sede: true, entrega_local: true, radio_entrega_km: 12, updated_at: '2026-01-01T00:00:00Z' },
      { sede_id: 8, estado: 'active', retiro_en_sede: true, entrega_local: false, radio_entrega_km: null, updated_at: '2026-01-01T00:00:00Z' },
    ],
    store_sede_payment_methods: [
      { id: 1, sede_id: 7, codigo: 'cash_on_pickup', nombre: 'Pago al retirar', activo: true, instrucciones: null },
    ],
    store_sede_offers: [
      { id: 10, sede_id: 7, product_id: 1, autorizado: true, autorizado_por_super: true, activo: true, precio: 35000, moneda: 'ARS', stock: 2, updated_at: '2026-01-01T00:00:00Z', product: { id: 1, activo: true } },
      { id: 11, sede_id: 7, product_id: 2, autorizado: true, autorizado_por_super: true, activo: true, precio: null, moneda: 'ARS', stock: 5, updated_at: '2026-01-01T00:00:00Z', product: { id: 2, activo: true } },
      { id: 17, sede_id: 8, product_id: 1, autorizado: true, autorizado_por_super: true, activo: true, precio: 9999, moneda: 'ARS', stock: 5, updated_at: '2026-01-01T00:00:00Z', product: { id: 1, activo: true } },
    ],
    store_orders: [
      {
        id: 100, codigo: 'PMS-FIXTURE', sede_id: 7, estado: 'nuevo', pago_estado: 'a_confirmar',
        total: 35000, moneda: 'ARS', created_at: '2026-01-01T00:00:00Z',
        items: [{ id: 1000, order_id: 100, product_id: 1, nombre_producto: 'Chivi figura', precio_unitario: 35000, cantidad: 1 }],
      },
    ],
  };
  let nextId = 9000;

  const matches = (row, filters) => filters.every((filter) => {
    if (filter.kind === 'in') return filter.values.includes(row[filter.column]);
    if (filter.kind === 'gt') return row[filter.column] > filter.value;
    return row[filter.column] === filter.value;
  });

  return {
    from(table) {
      const state = { table, filters: [], mode: 'select', payload: null, single: false, maybe: false, limit: Infinity };
      const api = {
        select() { return api; },
        eq(column, value) { state.filters.push({ column, value, kind: 'eq' }); return api; },
        in(column, values) { state.filters.push({ column, values, kind: 'in' }); return api; },
        gt(column, value) { state.filters.push({ column, value, kind: 'gt' }); return api; },
        order() { return api; },
        limit(n) { state.limit = n; return api; },
        update(payload) { state.mode = 'update'; state.payload = payload; return api; },
        insert(payload) { state.mode = 'insert'; state.payload = payload; return api; },
        upsert(payload) { state.mode = 'upsert'; state.payload = payload; return api; },
        maybeSingle() { state.maybe = true; return api; },
        single() { state.single = true; return api; },
        then(resolve, reject) {
          try {
            const rows = tables[table] || (tables[table] = []);
            let result;
            if (state.mode === 'select') {
              result = rows.filter((row) => matches(row, state.filters));
            } else if (state.mode === 'update') {
              result = rows.filter((row) => matches(row, state.filters));
              for (const row of result) Object.assign(row, state.payload);
            } else if (state.mode === 'insert') {
              const created = { id: nextId++, ...state.payload };
              rows.push(created);
              result = [created];
            } else {
              result = Array.isArray(state.payload) ? state.payload : [state.payload];
            }
            if (state.single || state.maybe) {
              const row = result[0] ?? null;
              if (state.single && !row) return resolve({ data: null, error: { message: 'PGRST116', code: 'PGRST116' } });
              return resolve({ data: row, error: null });
            }
            return resolve({ data: result.slice(0, state.limit), error: null });
          } catch (error) { return reject(error); }
        },
      };
      return api;
    },
  };
}

async function withApp(handler) {
  const { server, baseUrl } = await listen(buildStoreApp({
    supabaseAdmin: fakeSupabase(),
    legacySuperAdminEmails: LEGACY_SUPER_EMAILS,
  }));
  try { return await handler(baseUrl); } finally { await new Promise((resolve) => server.close(resolve)); }
}

const SEDE_ROUTES = [
  { method: 'GET', path: '/api/sedes/7/tienda-config' },
  { method: 'PUT', path: '/api/sedes/7/tienda-config', body: { estado: 'active', retiro_en_sede: true } },
  { method: 'GET', path: '/api/sedes/7/shop/admin' },
  { method: 'PATCH', path: '/api/sedes/7/shop/offers/10', body: { stock: 1 } },
  { method: 'PUT', path: '/api/sedes/7/shop/payment-methods', body: { methods: [{ codigo: 'cash_on_pickup', activo: true }] } },
  { method: 'PATCH', path: '/api/sedes/7/shop/orders/100', body: { estado: 'confirmado' } },
];
const GLOBAL_ROUTES = [
  { method: 'GET', path: '/api/admin/shop/global' },
  { method: 'POST', path: '/api/admin/shop/products', body: { nombre: 'Producto', slug: 'producto' } },
];

test('HTTP permisos por sede: sin sesión 401 y roles sin alcance 403 en todas las rutas de tienda', async () => {
  await withApp(async (baseUrl) => {
    for (const route of [...SEDE_ROUTES, ...GLOBAL_ROUTES]) {
      const anonymous = await request(baseUrl, route.method, route.path, { token: null, body: route.body });
      assert.equal(anonymous.status, 401, `${route.method} ${route.path} sin sesión`);
      for (const token of ['token-player', 'token-employee', 'token-national', 'token-legacy', 'token-norole']) {
        const denied = await request(baseUrl, route.method, route.path, { token, body: route.body });
        assert.equal(denied.status, 403, `${route.method} ${route.path} con ${token}`);
      }
    }
  });
});

test('HTTP permisos por sede: admin_club solo administra y lee su propia sede', async () => {
  await withApp(async (baseUrl) => {
    for (const route of SEDE_ROUTES) {
      const denied = await request(baseUrl, route.method, route.path, { token: 'token-admin-8', body: route.body });
      assert.equal(denied.status, 403, `${route.method} ${route.path} desde la sede 8`);
      assert.equal(denied.body.config, undefined);
      assert.equal(denied.body.orders, undefined);
      assert.equal(denied.body.offer, undefined);
      assert.equal(denied.body.payment_methods, undefined);
    }
    for (const route of GLOBAL_ROUTES) {
      assert.equal((await request(baseUrl, route.method, route.path, { token: 'token-admin-8', body: route.body })).status, 403);
    }
  });
});

test('HTTP permisos por sede: el dueño y el super_admin reciben 200, con datos acotados a la sede pedida', async () => {
  await withApp(async (baseUrl) => {
    const ownAdmin = await request(baseUrl, 'GET', '/api/sedes/7/shop/admin', { token: 'token-admin-7' });
    assert.equal(ownAdmin.status, 200);
    assert.equal(ownAdmin.body.config.sede_id, 7);
    assert.equal(ownAdmin.body.offers.length, 2);
    assert.ok(ownAdmin.body.offers.every((offer) => offer.sede_id === 7));
    assert.ok(ownAdmin.body.orders.every((order) => order.sede_id === 7));

    const ownConfig = await request(baseUrl, 'GET', '/api/sedes/7/tienda-config', { token: 'token-admin-7' });
    assert.equal(ownConfig.status, 200);
    assert.equal(ownConfig.body.config.sede_id, 7);

    const ownOffer = await request(baseUrl, 'PATCH', '/api/sedes/7/shop/offers/10', { token: 'token-admin-7', body: { stock: 1 } });
    assert.equal(ownOffer.status, 200);
    assert.equal(ownOffer.body.offer.stock, 1);

    const ownMethods = await request(baseUrl, 'PUT', '/api/sedes/7/shop/payment-methods', { token: 'token-admin-7', body: { methods: [{ codigo: 'cash_on_pickup', activo: true }] } });
    assert.equal(ownMethods.status, 200);

    // Knowing another venue's offer id is not a scope: the update is filtered by sede_id.
    const crossOffer = await request(baseUrl, 'PATCH', '/api/sedes/7/shop/offers/17', { token: 'token-admin-7', body: { stock: 99 } });
    assert.equal(crossOffer.status, 404);

    const superAdmin = await request(baseUrl, 'GET', '/api/sedes/8/shop/admin', { token: 'token-super' });
    assert.equal(superAdmin.status, 200);
    assert.equal(superAdmin.body.config.sede_id, 8);
    assert.equal((await request(baseUrl, 'GET', '/api/admin/shop/global', { token: 'token-super' })).status, 200);
    assert.equal((await request(baseUrl, 'POST', '/api/admin/shop/products', { token: 'token-super', body: { nombre: 'Nuevo', slug: 'nuevo' } })).status, 201);
  });
});

test('HTTP permisos por sede: una sede inválida responde 400 en vez de quedar sin respuesta', async () => {
  await withApp(async (baseUrl) => {
    assert.equal((await request(baseUrl, 'GET', '/api/sedes/abc/shop/admin', { token: 'token-admin-7' })).status, 400);
    assert.equal((await request(baseUrl, 'GET', '/api/sedes/abc/tienda-config', { token: 'token-admin-7' })).status, 400);
  });
});

test('HTTP tienda-config: la lectura anónima ya no expone configuración de la sede', async () => {
  await withApp(async (baseUrl) => {
    const anonymous = await request(baseUrl, 'GET', '/api/sedes/7/tienda-config', { token: null });
    assert.equal(anonymous.status, 401);
    assert.equal(anonymous.body.config, undefined);
    assert.equal(anonymous.body.payment_methods, undefined);
  });
});

test('HTTP catálogo público: solo ofrece la sede pedida y descarta precios NULL', async () => {
  await withApp(async (baseUrl) => {
    const shop = await request(baseUrl, 'GET', '/api/sedes/7/shop', { token: null });
    assert.equal(shop.status, 200);
    assert.deepEqual(shop.body.offers.map((offer) => offer.id), [10]);
    assert.equal(shop.body.offers[0].precio, 35000);
    assert.ok(shop.body.offers.every((offer) => offer.sede_id === 7));
  });
});
