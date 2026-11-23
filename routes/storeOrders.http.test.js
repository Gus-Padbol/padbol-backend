import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PLAYER_ID,
  PLAYER2_ID,
  freshPgliteStore,
  offerStock,
  request,
  startStoreServer,
  storeCounts,
} from './storeTestHarness.js';

const orderBody = (overrides = {}) => ({
  sede_id: 7,
  fulfillment_type: 'pickup',
  items: [{ offer_id: 10, quantity: 1 }],
  ...overrides,
});

const withKey = (key, body) => ({ body, headers: { 'Idempotency-Key': key } });

test('HTTP pedido: total, precio y comprador salen del servidor; el body no fija user_id', async () => {
  const store = await freshPgliteStore();
  try {
    const created = await request(store.baseUrl, 'POST', '/api/shop/orders', {
      body: orderBody({
        total: 1,
        precio: 1,
        moneda: 'USD',
        user_id: '00000000-0000-4000-8000-000000000999',
        items: [{ offer_id: 10, quantity: 2, precio: 1, precio_unitario: 1 }],
      }),
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.order.total, 70000);
    assert.equal(created.body.order.moneda, 'ARS');
    assert.equal(created.body.order.user_id, PLAYER_ID);
    assert.equal(created.body.order.items.length, 1);
    assert.equal(created.body.order.items[0].precio_unitario, 35000);
    assert.equal(created.body.order.items[0].nombre_producto, 'Chivi figura');
    assert.equal(created.body.order.items[0].cantidad, 2);
    assert.equal(created.body.order.idempotency_key, undefined);
    assert.equal(created.body.order.idempotency_hash, undefined);
    assert.equal(await offerStock(store.pg, 10), 0);
    const dbOrder = (await store.pg.query('SELECT total::text, moneda, user_id FROM public.store_orders')).rows[0];
    assert.deepEqual(dbOrder, { total: '70000.00', moneda: 'ARS', user_id: PLAYER_ID });
  } finally { await store.close(); }
});

test('HTTP pedido: precio NULL del catálogo no se convierte en pedido gratis', async () => {
  const store = await freshPgliteStore();
  try {
    const rejected = await request(store.baseUrl, 'POST', '/api/shop/orders', { body: orderBody({ items: [{ offer_id: 11, quantity: 1 }] }) });
    assert.equal(rejected.status, 409);
    assert.equal(rejected.body.error, 'El precio del producto no está disponible');
    assert.deepEqual(await storeCounts(store.pg), { orders: 0, items: 0 });
    assert.equal(await offerStock(store.pg, 11), 5);
  } finally { await store.close(); }
});

test('HTTP pedido: oferta inactiva, sin aprobación super o de otra sede se rechaza sin tocar stock', async () => {
  const store = await freshPgliteStore();
  try {
    for (const item of [
      { offer_id: 12, label: 'producto inactivo' },
      { offer_id: 13, label: 'oferta sin autorizado_por_super' },
      { offer_id: 18, label: 'oferta inactiva' },
      { offer_id: 17, label: 'oferta de la sede 8 pedida para la sede 7' },
    ]) {
      const rejected = await request(store.baseUrl, 'POST', '/api/shop/orders', { body: orderBody({ items: [{ offer_id: item.offer_id, quantity: 1 }] }) });
      assert.equal(rejected.status, 409, item.label);
      assert.equal(await offerStock(store.pg, item.offer_id), 5, item.label);
    }
    assert.equal((await storeCounts(store.pg)).orders, 0);
  } finally { await store.close(); }
});

test('HTTP pedido: pedidos concurrentes por la última unidad producen exactamente uno', async () => {
  const store = await freshPgliteStore();
  try {
    const body = orderBody({ items: [{ offer_id: 14, quantity: 1 }] });
    const results = await Promise.all(Array.from({ length: 4 }, () => request(store.baseUrl, 'POST', '/api/shop/orders', { body })));
    assert.equal(results.filter((result) => result.status === 201).length, 1);
    assert.equal(results.filter((result) => result.status === 409).length, 3);
    assert.equal(await offerStock(store.pg, 14), 0);
    assert.deepEqual(await storeCounts(store.pg), { orders: 1, items: 1 });

    const retry = await request(store.baseUrl, 'POST', '/api/shop/orders', { body });
    assert.equal(retry.status, 409);
    assert.deepEqual(await storeCounts(store.pg), { orders: 1, items: 1 });
  } finally { await store.close(); }
});

test('HTTP pedido: fallo al insertar items revierte pedido y stock (sin huérfanos)', async () => {
  const store = await freshPgliteStore();
  try {
    await store.pg.exec(`
      CREATE FUNCTION public.fail_store_order_items() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'forced store_order_items failure'; END $$;
      CREATE TRIGGER fail_store_order_items BEFORE INSERT ON public.store_order_items
      FOR EACH ROW EXECUTE FUNCTION public.fail_store_order_items();
    `);
    const failed = await request(store.baseUrl, 'POST', '/api/shop/orders', { body: orderBody() });
    assert.equal(failed.status, 500);
    assert.deepEqual(await storeCounts(store.pg), { orders: 0, items: 0 });
    assert.equal(await offerStock(store.pg, 10), 2);

    await store.pg.exec('DROP TRIGGER fail_store_order_items ON public.store_order_items; DROP FUNCTION public.fail_store_order_items();');
    const recovered = await request(store.baseUrl, 'POST', '/api/shop/orders', { body: orderBody() });
    assert.equal(recovered.status, 201);
    assert.deepEqual(await storeCounts(store.pg), { orders: 1, items: 1 });
    assert.equal(await offerStock(store.pg, 10), 1);
  } finally { await store.close(); }
});

test('HTTP pedido: cantidades y carrito inválidos se rechazan sin escribir', async () => {
  const store = await freshPgliteStore();
  try {
    for (const body of [
      orderBody({ items: [] }),
      orderBody({ items: [{ offer_id: 10, quantity: 0 }] }),
      orderBody({ items: [{ offer_id: 10, quantity: '1.5' }] }),
      orderBody({ items: [{ offer_id: 10, quantity: 1 }, { offer_id: 10, quantity: 1 }] }),
      orderBody({ items: [{ offer_id: 'abc', quantity: 1 }] }),
      orderBody({ idempotency_key: 'k'.repeat(201) }),
    ]) {
      const rejected = await request(store.baseUrl, 'POST', '/api/shop/orders', { body });
      assert.equal(rejected.status, 400);
    }
    assert.deepEqual(await storeCounts(store.pg), { orders: 0, items: 0 });
    assert.equal(await offerStock(store.pg, 10), 2);
  } finally { await store.close(); }
});

test('HTTP pedido: tienda pausada o entrega no ofrecida no reserva stock', async () => {
  const store = await freshPgliteStore();
  try {
    await store.pg.query("UPDATE public.store_sede_config SET estado = 'paused' WHERE sede_id = 7");
    assert.equal((await request(store.baseUrl, 'POST', '/api/shop/orders', { body: orderBody() })).status, 409);

    await store.pg.query("UPDATE public.store_sede_config SET estado = 'active', retiro_en_sede = false WHERE sede_id = 7");
    assert.equal((await request(store.baseUrl, 'POST', '/api/shop/orders', { body: orderBody() })).status, 409);
    assert.equal(await offerStock(store.pg, 10), 2);
    assert.deepEqual(await storeCounts(store.pg), { orders: 0, items: 0 });
  } finally { await store.close(); }
});

test('HTTP pedido: dos monedas distintas en el mismo carrito se rechazan', async () => {
  const store = await freshPgliteStore();
  try {
    const rejected = await request(store.baseUrl, 'POST', '/api/shop/orders', {
      body: orderBody({ items: [{ offer_id: 10, quantity: 1 }, { offer_id: 16, quantity: 1 }] }),
    });
    assert.equal(rejected.status, 409);
    assert.equal(rejected.body.error, 'El pedido debe usar una sola moneda');
    assert.deepEqual(await storeCounts(store.pg), { orders: 0, items: 0 });
    assert.equal(await offerStock(store.pg, 10), 2);
    assert.equal(await offerStock(store.pg, 16), 5);
  } finally { await store.close(); }
});

test('HTTP admin: cancelar devuelve stock una sola vez, otra sede recibe 403 y reabrir re-reserva', async () => {
  const store = await freshPgliteStore();
  try {
    const created = await request(store.baseUrl, 'POST', '/api/shop/orders', { body: orderBody({ items: [{ offer_id: 14, quantity: 1 }] }) });
    assert.equal(created.status, 201);
    const orderId = created.body.order.id;
    assert.equal(await offerStock(store.pg, 14), 0);

    const otherSede = await request(store.baseUrl, 'PATCH', `/api/sedes/7/shop/orders/${orderId}`, { token: 'token-admin-8', body: { estado: 'cancelado' } });
    assert.equal(otherSede.status, 403);
    assert.equal(await offerStock(store.pg, 14), 0);

    const cancelled = await request(store.baseUrl, 'PATCH', `/api/sedes/7/shop/orders/${orderId}`, { token: 'token-admin-7', body: { estado: 'cancelado' } });
    assert.equal(cancelled.status, 200);
    assert.equal(cancelled.body.order.estado, 'cancelado');
    assert.equal(await offerStock(store.pg, 14), 1);

    const repeated = await request(store.baseUrl, 'PATCH', `/api/sedes/7/shop/orders/${orderId}`, { token: 'token-admin-7', body: { estado: 'cancelado' } });
    assert.equal(repeated.status, 200);
    assert.equal(await offerStock(store.pg, 14), 1, 'cancelar dos veces no devuelve stock dos veces');

    assert.equal((await request(store.baseUrl, 'PATCH', `/api/sedes/7/shop/orders/${orderId}`, { token: 'token-admin-7', body: { estado: 'inventado' } })).status, 400);

    const reopened = await request(store.baseUrl, 'PATCH', `/api/sedes/7/shop/orders/${orderId}`, { token: 'token-admin-7', body: { estado: 'nuevo' } });
    assert.equal(reopened.status, 200);
    assert.equal(await offerStock(store.pg, 14), 0);
  } finally { await store.close(); }
});

test('HTTP idempotencia: misma clave y mismo carrito devuelve el mismo pedido y no vuelve a descontar', async () => {
  const store = await freshPgliteStore();
  try {
    const body = orderBody();
    const first = await request(store.baseUrl, 'POST', '/api/shop/orders', withKey('idem-same-cart-001', body));
    const second = await request(store.baseUrl, 'POST', '/api/shop/orders', withKey('idem-same-cart-001', body));
    assert.equal(first.status, 201);
    assert.equal(second.status, 201);
    assert.equal(second.body.order.id, first.body.order.id);
    assert.equal(second.headers.get('idempotency-replayed'), 'true');
    assert.equal(first.headers.get('idempotency-replayed'), null);
    assert.deepEqual(await storeCounts(store.pg), { orders: 1, items: 1 });
    assert.equal(await offerStock(store.pg, 10), 1);

    const differentCart = await request(store.baseUrl, 'POST', '/api/shop/orders', withKey('idem-same-cart-001', orderBody({ items: [{ offer_id: 10, quantity: 2 }] })));
    assert.equal(differentCart.status, 409);
    assert.equal(differentCart.body.error, 'La clave de intento ya se usó con otro carrito');
    assert.deepEqual(await storeCounts(store.pg), { orders: 1, items: 1 });
    assert.equal(await offerStock(store.pg, 10), 1);
  } finally { await store.close(); }
});

test('HTTP idempotencia: claves concurrentes no duplican pedido ni stock', async () => {
  const store = await freshPgliteStore();
  try {
    const body = orderBody({ items: [{ offer_id: 14, quantity: 1 }] });
    const results = await Promise.all(Array.from({ length: 4 }, () => request(store.baseUrl, 'POST', '/api/shop/orders', withKey('idem-concurrent-001', body))));
    assert.equal(results.every((result) => result.status === 201), true);
    assert.equal(new Set(results.map((result) => result.body.order.id)).size, 1);
    assert.deepEqual(await storeCounts(store.pg), { orders: 1, items: 1 });
    assert.equal(await offerStock(store.pg, 14), 0);
  } finally { await store.close(); }
});

test('HTTP idempotencia: la clave se acota al comprador y al carrito; el body también puede traerla', async () => {
  const store = await freshPgliteStore();
  try {
    const first = await request(store.baseUrl, 'POST', '/api/shop/orders', withKey('idem-buyer-001', orderBody()));
    const secondBuyer = await request(store.baseUrl, 'POST', '/api/shop/orders', {
      token: 'token-player-2',
      body: orderBody({ idempotency_key: 'idem-buyer-001' }),
    });
    assert.equal(first.status, 201);
    assert.equal(secondBuyer.status, 201);
    assert.notEqual(secondBuyer.body.order.id, first.body.order.id);
    assert.equal(secondBuyer.body.order.user_id, PLAYER2_ID);
    assert.deepEqual(await storeCounts(store.pg), { orders: 2, items: 2 });
    assert.equal(await offerStock(store.pg, 10), 0);
  } finally { await store.close(); }
});

test('HTTP idempotencia: el mismo carrito en otro orden también reutiliza el pedido', async () => {
  const store = await freshPgliteStore();
  try {
    const forward = await request(store.baseUrl, 'POST', '/api/shop/orders', withKey('idem-reorder-001', orderBody({
      items: [{ offer_id: 10, quantity: 1 }, { offer_id: 14, quantity: 1 }],
    })));
    const reversed = await request(store.baseUrl, 'POST', '/api/shop/orders', withKey('idem-reorder-001', orderBody({
      items: [{ offer_id: 14, quantity: 1 }, { offer_id: 10, quantity: 1 }],
    })));
    assert.equal(forward.status, 201);
    assert.equal(reversed.status, 201);
    assert.equal(reversed.body.order.id, forward.body.order.id);
    assert.equal(reversed.headers.get('idempotency-replayed'), 'true');
    assert.deepEqual(await storeCounts(store.pg), { orders: 1, items: 2 });
    assert.equal(await offerStock(store.pg, 10), 1);
    assert.equal(await offerStock(store.pg, 14), 0);
  } finally { await store.close(); }
});

test('HTTP idempotencia: reintento tras cancelación devuelve el mismo pedido cancelado y no re-reserva', async () => {
  const store = await freshPgliteStore();
  try {
    const body = orderBody({ items: [{ offer_id: 14, quantity: 1 }] });
    const created = await request(store.baseUrl, 'POST', '/api/shop/orders', withKey('idem-after-cancel-001', body));
    assert.equal(created.status, 201);
    const cancelled = await request(store.baseUrl, 'PATCH', `/api/sedes/7/shop/orders/${created.body.order.id}`, { token: 'token-admin-7', body: { estado: 'cancelado' } });
    assert.equal(cancelled.status, 200);
    assert.equal(await offerStock(store.pg, 14), 1);

    const replay = await request(store.baseUrl, 'POST', '/api/shop/orders', withKey('idem-after-cancel-001', body));
    assert.equal(replay.status, 201);
    assert.equal(replay.body.order.id, created.body.order.id);
    assert.equal(replay.body.order.estado, 'cancelado');
    assert.equal(replay.headers.get('idempotency-replayed'), 'true');
    assert.deepEqual(await storeCounts(store.pg), { orders: 1, items: 1 });
    assert.equal(await offerStock(store.pg, 14), 1);
  } finally { await store.close(); }
});

test('HTTP idempotencia: la misma clave en otra sede es un pedido independiente', async () => {
  const store = await freshPgliteStore();
  try {
    const first = await request(store.baseUrl, 'POST', '/api/shop/orders', withKey('idem-sede-scope-001', orderBody()));
    const otherSede = await request(store.baseUrl, 'POST', '/api/shop/orders', withKey('idem-sede-scope-001', orderBody({ sede_id: 8, items: [{ offer_id: 17, quantity: 1 }] })));
    assert.equal(first.status, 201);
    assert.equal(otherSede.status, 201);
    assert.notEqual(otherSede.body.order.id, first.body.order.id);
    assert.equal(otherSede.body.order.sede_id, 8);
    assert.deepEqual(await storeCounts(store.pg), { orders: 2, items: 2 });
  } finally { await store.close(); }
});

test('HTTP cliente sin clave: conserva el contrato y no simula idempotencia', async () => {
  const store = await freshPgliteStore();
  try {
    const first = await request(store.baseUrl, 'POST', '/api/shop/orders', { body: orderBody() });
    const second = await request(store.baseUrl, 'POST', '/api/shop/orders', { body: orderBody() });
    assert.equal(first.status, 201);
    assert.equal(second.status, 201);
    assert.notEqual(second.body.order.id, first.body.order.id);
    assert.equal(second.headers.get('idempotency-replayed'), null);
    assert.deepEqual(await storeCounts(store.pg), { orders: 2, items: 2 });
    assert.equal(await offerStock(store.pg, 10), 0);
  } finally { await store.close(); }
});

test('HTTP pedido: sin RPC transaccional falla cerrado 503 y no cae a escrituras REST', async () => {
  const explodingDb = { from() { throw new Error('REST write attempted without RPC'); } };
  const server = await startStoreServer({ supabaseAdmin: explodingDb });
  try {
    const result = await request(server.baseUrl, 'POST', '/api/shop/orders', { body: orderBody() });
    assert.equal(result.status, 503);
    assert.equal(result.body.error, 'La tienda no está disponible en este momento');
  } finally { await server.close(); }
});
