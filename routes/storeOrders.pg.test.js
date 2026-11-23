import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {
  EXISTING_STORE_SCHEMA_SQL,
  STORE_MIGRATION_SQL,
  STORE_SEED_SQL,
  buildStoreApp,
  createRpcClient,
  listen,
  request,
} from './storeTestHarness.js';

/**
 * Real PostgreSQL proof for the candidate package. Gated by STORE_ORDERS_PG_URL
 * and refused outside a dedicated local test database. The migration is applied
 * verbatim; roles/RLS/grants and the SECURITY DEFINER RPC are the ones shipped in
 * the candidate, with the Supabase service-role client simulated by SET LOCAL ROLE.
 */
const CS = process.env.STORE_ORDERS_PG_URL;
const it = CS ? test : test.skip;

let pool = null;
let server = null;
let baseUrl = null;

function assertSafeTarget(connectionString) {
  const parsed = new URL(connectionString);
  const database = parsed.pathname.replace(/^\//, '');
  if (!['127.0.0.1', 'localhost'].includes(parsed.hostname) || !/^store_orders_[a-z0-9_]+_test$/.test(database)) {
    throw new Error('REFUSE_DESTRUCTIVE_STORE_PG_TARGET');
  }
}

const orderBody = (overrides = {}) => ({
  sede_id: 7,
  fulfillment_type: 'pickup',
  items: [{ offer_id: 14, quantity: 1 }],
  ...overrides,
});

const withKey = (key, body) => ({ body, headers: { 'Idempotency-Key': key } });

async function asRole(role, sql, params = []) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL ROLE ${role}`);
    return await client.query(sql, params);
  } finally {
    try { await client.query('ROLLBACK'); } catch { /* best effort */ }
    client.release();
  }
}

async function resetFixtures() {
  await pool.query('DROP TRIGGER IF EXISTS hold_store_order ON public.store_orders');
  await pool.query('DROP FUNCTION IF EXISTS public.hold_store_order()');
  await pool.query('DROP TRIGGER IF EXISTS fail_store_order_items ON public.store_order_items');
  await pool.query('DROP FUNCTION IF EXISTS public.fail_store_order_items()');
  await pool.query('TRUNCATE public.store_order_items, public.store_orders RESTART IDENTITY CASCADE');
  await pool.query("UPDATE public.store_sede_config SET estado = 'active', retiro_en_sede = true, entrega_local = true WHERE sede_id = 7");
  await pool.query(`UPDATE public.store_sede_offers SET stock = CASE id
      WHEN 10 THEN 2 WHEN 11 THEN 5 WHEN 12 THEN 5 WHEN 13 THEN 5
      WHEN 14 THEN 1 WHEN 15 THEN 5 WHEN 16 THEN 5 WHEN 17 THEN 5 WHEN 18 THEN 5 END
    WHERE id BETWEEN 10 AND 18`);
}

before(async () => {
  if (!CS) return;
  assertSafeTarget(CS);
  pool = new pg.Pool({ connectionString: CS, max: 8, application_name: 'store-orders-pg-test', ssl: false });

  await pool.query(`DO $roles$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
        CREATE ROLE anon NOLOGIN;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
        CREATE ROLE authenticated NOLOGIN;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
        CREATE ROLE service_role NOLOGIN BYPASSRLS;
      END IF;
    END
  $roles$;`);
  await pool.query('ALTER ROLE service_role BYPASSRLS');
  await pool.query('ALTER ROLE anon NOBYPASSRLS');
  await pool.query('ALTER ROLE authenticated NOBYPASSRLS');

  await pool.query(`DROP TABLE IF EXISTS public.store_order_items, public.store_orders,
    public.store_sede_payment_methods, public.store_sede_config,
    public.store_sede_offers, public.store_central_offers,
    public.store_catalog_products, public.sedes CASCADE`);
  await pool.query(EXISTING_STORE_SCHEMA_SQL);
  await pool.query(STORE_MIGRATION_SQL);
  await pool.query(STORE_SEED_SQL);

  const started = await listen(buildStoreApp({ supabaseAdmin: createRpcClient(pool) }));
  server = started.server;
  baseUrl = started.baseUrl;
});

beforeEach(async () => {
  if (pool) await resetFixtures();
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (pool) await pool.end();
});

async function waitForRowLock() {
  for (let i = 0; i < 500; i += 1) {
    const result = await pool.query(`SELECT EXISTS (
        SELECT 1 FROM pg_stat_activity
         WHERE datname = current_database()
           AND application_name = 'store-orders-pg-test'
           AND wait_event_type = 'Lock'
      ) AS waiting`);
    if (result.rows[0].waiting) return true;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  return false;
}

it('PG real: esquema efectivo, tipos reales, RLS, grants y RPC security definer', async () => {
  const columns = (await pool.query(`SELECT table_name, column_name, data_type
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name IN ('store_orders', 'store_order_items', 'store_sede_config', 'store_sede_payment_methods', 'store_sede_offers')
     ORDER BY table_name, ordinal_position`)).rows;
  const column = (table, name) => columns.find((row) => row.table_name === table && row.column_name === name);
  assert.equal(column('store_orders', 'sede_id').data_type, 'integer');
  assert.equal(column('store_orders', 'id').data_type, 'bigint');
  assert.equal(column('store_order_items', 'order_id').data_type, 'bigint');
  assert.equal(column('store_order_items', 'product_id').data_type, 'bigint');
  assert.equal(column('store_sede_offers', 'sede_id').data_type, 'integer');
  assert.equal(column('store_sede_offers', 'id').data_type, 'bigint');
  assert.equal(column('store_sede_config', 'sede_id').data_type, 'integer');

  const rls = (await pool.query(`SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname IN ('store_orders','store_order_items','store_sede_config','store_sede_payment_methods')`)).rows;
  assert.equal(rls.length, 4);
  assert.ok(rls.every((row) => row.relrowsecurity === true && row.relforcerowsecurity === false));
  const policies = (await pool.query(`SELECT count(*)::int AS n FROM pg_policies
      WHERE schemaname = 'public'
        AND tablename IN ('store_orders','store_order_items','store_sede_config','store_sede_payment_methods')`)).rows[0].n;
  assert.equal(policies, 0);

  for (const table of ['store_orders', 'store_order_items', 'store_sede_config', 'store_sede_payment_methods']) {
    assert.equal((await pool.query("SELECT has_table_privilege('anon', $1, 'SELECT') AS ok", [`public.${table}`])).rows[0].ok, false, table);
    assert.equal((await pool.query("SELECT has_table_privilege('authenticated', $1, 'SELECT') AS ok", [`public.${table}`])).rows[0].ok, false, table);
    assert.equal((await pool.query("SELECT has_table_privilege('service_role', $1, 'SELECT') AS ok", [`public.${table}`])).rows[0].ok, true, table);
  }

  const routines = (await pool.query(`SELECT p.proname, p.prosecdef, p.proconfig,
        pg_get_function_identity_arguments(p.oid) AS args
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname IN ('store_create_order','store_update_order')
     ORDER BY p.proname`)).rows;
  assert.equal(routines.length, 2);
  assert.ok(routines.every((routine) => routine.prosecdef === true));
  assert.ok(routines.every((routine) => String(routine.proconfig).includes('search_path=pg_catalog, public')));
  assert.equal(routines[0].args, 'p_user_id uuid, p_sede_id integer, p_fulfillment_type text, p_items jsonb, p_nota_cliente text, p_idempotency_key text');
  assert.equal(routines[1].args, 'p_order_id bigint, p_sede_id integer, p_estado text, p_pago_estado text');
  for (const role of ['anon', 'authenticated']) {
    assert.equal((await pool.query(`SELECT has_function_privilege($1,
        'public.store_create_order(uuid,integer,text,jsonb,text,text)', 'EXECUTE') AS ok`, [role])).rows[0].ok, false);
    assert.equal((await pool.query(`SELECT has_function_privilege($1,
        'public.store_update_order(bigint,integer,text,text)', 'EXECUTE') AS ok`, [role])).rows[0].ok, false);
  }
  assert.equal((await pool.query(`SELECT has_function_privilege('service_role',
      'public.store_create_order(uuid,integer,text,jsonb,text,text)', 'EXECUTE') AS ok`)).rows[0].ok, true);

  await assert.rejects(asRole('anon', 'SELECT count(*) FROM public.store_orders'), /permission denied|row-level security/i);
  await assert.rejects(asRole('authenticated', 'SELECT count(*) FROM public.store_orders'), /permission denied|row-level security/i);
  const serviceRead = await asRole('service_role', 'SELECT count(*)::int AS n FROM public.store_orders');
  assert.equal(serviceRead.rows[0].n, 0);
  await assert.rejects(
    asRole('authenticated', `SELECT public.store_create_order(
      '11111111-1111-4111-8111-111111111111'::uuid, 7, 'pickup',
      '[{"offer_id":10,"quantity":1}]'::jsonb, NULL, 'rls-key')`),
    /permission denied/i,
  );
});

it('PG real: última unidad con pedidos simultáneos deja exactamente un pedido y stock 0', async () => {
  await pool.query(`CREATE FUNCTION public.hold_store_order() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN PERFORM pg_sleep(0.05); RETURN NEW; END $$;
    CREATE TRIGGER hold_store_order BEFORE INSERT ON public.store_orders
    FOR EACH ROW EXECUTE FUNCTION public.hold_store_order();`);
  const body = orderBody();
  const pending = Promise.all(Array.from({ length: 4 }, () => request(baseUrl, 'POST', '/api/shop/orders', { body })));
  const sawLock = await waitForRowLock();
  const results = await pending;
  assert.equal(sawLock, true, 'los pedidos deben competir por el lock de la fila de oferta');
  assert.equal(results.filter((result) => result.status === 201).length, 1);
  assert.equal(results.filter((result) => result.status === 409).length, 3);
  assert.deepEqual((await pool.query('SELECT count(*)::int AS n FROM public.store_orders')).rows[0], { n: 1 });
  assert.deepEqual((await pool.query('SELECT count(*)::int AS n FROM public.store_order_items')).rows[0], { n: 1 });
  assert.deepEqual((await pool.query('SELECT stock FROM public.store_sede_offers WHERE id = 14')).rows[0], { stock: 0 });
});

it('PG real: idempotencia concurrente devuelve un solo pedido y no vuelve a descontar', async () => {
  const body = orderBody();
  const results = await Promise.all(Array.from({ length: 4 }, () => request(baseUrl, 'POST', '/api/shop/orders', withKey('pg-idem-concurrent-1', body))));
  assert.equal(results.every((result) => result.status === 201), true);
  assert.equal(new Set(results.map((result) => result.body.order.id)).size, 1);
  assert.equal(results.filter((result) => result.headers.get('idempotency-replayed') === 'true').length, 3);
  assert.deepEqual((await pool.query('SELECT count(*)::int AS n FROM public.store_orders')).rows[0], { n: 1 });
  assert.deepEqual((await pool.query('SELECT count(*)::int AS n FROM public.store_order_items')).rows[0], { n: 1 });
  assert.deepEqual((await pool.query('SELECT stock FROM public.store_sede_offers WHERE id = 14')).rows[0], { stock: 0 });

  const mismatch = await request(baseUrl, 'POST', '/api/shop/orders', withKey('pg-idem-concurrent-1', orderBody({ items: [{ offer_id: 10, quantity: 1 }] })));
  assert.equal(mismatch.status, 409);
  assert.equal(mismatch.body.error, 'La clave de intento ya se usó con otro carrito');
});

it('PG real: fallo de items revierte pedido, items y stock en la misma transacción', async () => {
  await pool.query(`CREATE FUNCTION public.fail_store_order_items() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'forced store_order_items failure'; END $$;
    CREATE TRIGGER fail_store_order_items BEFORE INSERT ON public.store_order_items
    FOR EACH ROW EXECUTE FUNCTION public.fail_store_order_items();`);
  const failed = await request(baseUrl, 'POST', '/api/shop/orders', { body: orderBody({ items: [{ offer_id: 10, quantity: 1 }] }) });
  assert.equal(failed.status, 500);
  assert.deepEqual((await pool.query('SELECT count(*)::int AS n FROM public.store_orders')).rows[0], { n: 0 });
  assert.deepEqual((await pool.query('SELECT count(*)::int AS n FROM public.store_order_items')).rows[0], { n: 0 });
  assert.deepEqual((await pool.query('SELECT stock FROM public.store_sede_offers WHERE id = 10')).rows[0], { stock: 2 });
});

it('PG real: dos cancelaciones simultáneas devuelven el stock una sola vez', async () => {
  const created = await request(baseUrl, 'POST', '/api/shop/orders', { body: orderBody() });
  assert.equal(created.status, 201);
  const path = `/api/sedes/7/shop/orders/${created.body.order.id}`;
  const [a, b] = await Promise.all([
    request(baseUrl, 'PATCH', path, { token: 'token-admin-7', body: { estado: 'cancelado' } }),
    request(baseUrl, 'PATCH', path, { token: 'token-admin-7', body: { estado: 'cancelado' } }),
  ]);
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.deepEqual((await pool.query('SELECT stock FROM public.store_sede_offers WHERE id = 14')).rows[0], { stock: 1 });
  assert.deepEqual((await pool.query('SELECT estado FROM public.store_orders')).rows[0], { estado: 'cancelado' });
});

it('PG real: separación por sede e IDOR denegados aunque se conozcan los ids', async () => {
  const other = (await pool.query(`INSERT INTO public.store_orders
      (codigo, sede_id, user_id, fulfillment_type, moneda, total)
    VALUES ('PMS-OTHER-SEDE', 8, NULL, 'pickup', 'ARS', 9999)
    RETURNING id`)).rows[0];
  const denied = await request(baseUrl, 'PATCH', `/api/sedes/7/shop/orders/${other.id}`, {
    token: 'token-admin-7',
    body: { estado: 'cancelado' },
  });
  assert.equal(denied.status, 404);
  assert.deepEqual((await pool.query('SELECT estado FROM public.store_orders WHERE id = $1', [other.id])).rows[0], { estado: 'nuevo' });
  assert.deepEqual((await pool.query('SELECT stock FROM public.store_sede_offers WHERE id = 17')).rows[0], { stock: 5 });

  const crossOffer = await request(baseUrl, 'POST', '/api/shop/orders', { body: orderBody({ items: [{ offer_id: 17, quantity: 1 }] }) });
  assert.equal(crossOffer.status, 409);
  assert.deepEqual((await pool.query('SELECT stock FROM public.store_sede_offers WHERE id = 17')).rows[0], { stock: 5 });
});

it('PG real: precio y comprador son del servidor; sin clave se conserva el contrato viejo', async () => {
  const first = await request(baseUrl, 'POST', '/api/shop/orders', {
    body: orderBody({
      total: 1,
      precio: 1,
      moneda: 'USD',
      user_id: '00000000-0000-4000-8000-000000000999',
      items: [{ offer_id: 10, quantity: 1, precio: 1 }],
    }),
  });
  assert.equal(first.status, 201);
  assert.equal(first.body.order.total, 35000);
  assert.equal(first.body.order.moneda, 'ARS');
  assert.equal(first.body.order.user_id, '11111111-1111-4111-8111-111111111111');
  assert.equal(first.headers.get('idempotency-replayed'), null);

  const second = await request(baseUrl, 'POST', '/api/shop/orders', { body: orderBody({ items: [{ offer_id: 10, quantity: 1 }] }) });
  assert.equal(second.status, 201);
  assert.notEqual(second.body.order.id, first.body.order.id);
  assert.equal(second.headers.get('idempotency-replayed'), null);
  assert.deepEqual((await pool.query('SELECT count(*)::int AS n FROM public.store_orders')).rows[0], { n: 2 });
});
