import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import {
  EXISTING_STORE_SCHEMA_SQL,
  STORE_MIGRATION_SQL,
  STORE_ROLES_SQL,
  STORE_ROLLBACK_SQL,
  STORE_VERIFY_SQL,
  createRpcClient,
} from './storeTestHarness.js';

const columnsFor = async (pg, tables) => (await pg.query(
  `SELECT table_name, column_name, data_type, is_nullable, column_default
     FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = ANY($1::text[])
    ORDER BY table_name, ordinal_position`,
  [tables],
)).rows;

const tableNames = async (pg) => (await pg.query(
  `SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name LIKE 'store_%'
    ORDER BY table_name`,
)).rows.map((row) => row.table_name);

test('migración candidata: crea sólo las 4 tablas, preserva las 3 reales y es reversible', async () => {
  const pg = new PGlite();
  try {
    await pg.exec(STORE_ROLES_SQL);
    await pg.exec(EXISTING_STORE_SCHEMA_SQL);
    const preservedBefore = await columnsFor(pg, ['store_catalog_products', 'store_central_offers', 'store_sede_offers']);
    await pg.query("INSERT INTO public.sedes (id, nombre) VALUES (7, 'Sede Siete')");
    await pg.query("INSERT INTO public.store_catalog_products (id, slug, nombre) VALUES (1, 'p1', 'Producto')");
    await pg.query(`INSERT INTO public.store_sede_offers
      (id, sede_id, product_id, autorizado, autorizado_por_super, activo, precio, moneda, stock)
      VALUES (10, 7, 1, true, true, true, 35000, 'ARS', 2)`);

    await pg.exec(STORE_MIGRATION_SQL);
    await pg.query("INSERT INTO public.store_sede_config (sede_id, estado, retiro_en_sede, entrega_local) VALUES (7, 'active', true, true)");

    assert.deepEqual(await tableNames(pg), [
      'store_catalog_products',
      'store_central_offers',
      'store_order_items',
      'store_orders',
      'store_sede_config',
      'store_sede_offers',
      'store_sede_payment_methods',
    ]);
    assert.deepEqual(
      await columnsFor(pg, ['store_catalog_products', 'store_central_offers', 'store_sede_offers']),
      preservedBefore,
      'la migración no debe alterar las 3 tablas existentes',
    );
    assert.equal((await pg.query("SELECT count(*)::int AS n FROM public.store_sede_offers WHERE id = 10")).rows[0].n, 1);

    const verify = (await pg.query(STORE_VERIFY_SQL)).rows[0].store_schema_verification;
    assert.deepEqual(verify.required_tables, [
      'store_order_items',
      'store_orders',
      'store_sede_config',
      'store_sede_payment_methods',
    ]);
    assert.deepEqual(verify.preserved_tables, [
      'store_catalog_products',
      'store_central_offers',
      'store_sede_offers',
    ]);
    assert.deepEqual(verify.policies, []);
    assert.ok(verify.rls.every((entry) => entry.enabled === true && entry.forced === false));
    assert.ok(verify.table_grants.every((entry) => entry.grantee === 'service_role'));
    for (const fn of verify.function_privileges) {
      assert.equal(fn.anon, false);
      assert.equal(fn.authenticated, false);
      assert.equal(fn.service_role, true);
    }
    assert.ok(verify.routines.every((routine) => routine.security_definer === true));
    assert.ok(verify.routines.every((routine) => String(routine.search_path).includes('search_path=pg_catalog, public')));
    const keyColumn = (table, column) => verify.key_columns.find((entry) => entry.table === table && entry.column === column);
    assert.equal(keyColumn('store_orders', 'sede_id').type, 'integer');
    assert.equal(keyColumn('store_order_items', 'order_id').type, 'bigint');
    assert.equal(keyColumn('store_order_items', 'product_id').type, 'bigint');
    assert.equal(keyColumn('store_sede_offers', 'sede_id').type, 'integer');
    assert.equal(keyColumn('store_sede_offers', 'id').type, 'bigint');
    assert.equal(keyColumn('store_orders', 'total').type, 'numeric');

    const db = createRpcClient(pg);
    const created = await db.rpc('store_create_order', {
      p_user_id: '11111111-1111-4111-8111-111111111111',
      p_sede_id: 7,
      p_fulfillment_type: 'pickup',
      p_items: [{ offer_id: 10, quantity: 1 }],
      p_nota_cliente: null,
      p_idempotency_key: 'migration-key-1',
    });
    assert.equal(created.error, null);
    assert.equal(created.data.replayed, false);
    const replayed = await db.rpc('store_create_order', {
      p_user_id: '11111111-1111-4111-8111-111111111111',
      p_sede_id: 7,
      p_fulfillment_type: 'pickup',
      p_items: [{ offer_id: 10, quantity: 1 }],
      p_nota_cliente: null,
      p_idempotency_key: 'migration-key-1',
    });
    assert.equal(replayed.data.order.id, created.data.order.id);
    assert.equal(replayed.data.replayed, true);
    assert.equal((await pg.query("SELECT count(*)::int AS n FROM public.store_orders")).rows[0].n, 1);

    await pg.exec(STORE_ROLLBACK_SQL);
    assert.deepEqual(await tableNames(pg), [
      'store_catalog_products',
      'store_central_offers',
      'store_sede_offers',
    ]);
    assert.deepEqual(
      await columnsFor(pg, ['store_catalog_products', 'store_central_offers', 'store_sede_offers']),
      preservedBefore,
      'el rollback no debe alterar las 3 tablas existentes',
    );
    assert.equal((await pg.query("SELECT count(*)::int AS n FROM public.store_sede_offers WHERE id = 10")).rows[0].n, 1);
    assert.equal((await pg.query("SELECT count(*)::int AS n FROM pg_proc WHERE proname IN ('store_create_order','store_update_order')")).rows[0].n, 0);

    await pg.exec(STORE_MIGRATION_SQL);
    await pg.exec(STORE_MIGRATION_SQL);
    assert.deepEqual(await tableNames(pg), [
      'store_catalog_products',
      'store_central_offers',
      'store_order_items',
      'store_orders',
      'store_sede_config',
      'store_sede_offers',
      'store_sede_payment_methods',
    ]);
  } finally {
    await pg.close();
  }
});

test('migración candidata: acepta sedes.id integer para compatibilidad', async () => {
  const pg = new PGlite();
  try {
    await pg.exec(STORE_ROLES_SQL);
    const integerSchema = EXISTING_STORE_SCHEMA_SQL.replace('id bigint PRIMARY KEY,\n  nombre text NOT NULL', 'id integer PRIMARY KEY,\n  nombre text NOT NULL');
    await pg.exec(integerSchema);
    await pg.exec(STORE_MIGRATION_SQL);
    assert.equal((await pg.query("SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('store_orders','store_order_items','store_sede_config','store_sede_payment_methods')")).rows[0].n, 4);
  } finally { await pg.close(); }
});

test('migración candidata: falla cerrada si sedes.id no es integer o faltan roles', async () => {
  const wrongTypes = new PGlite();
  try {
    await wrongTypes.exec('CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;');
    await wrongTypes.exec(`
      CREATE TABLE public.sedes (id text PRIMARY KEY, nombre text NOT NULL);
      CREATE TABLE public.store_catalog_products (id bigint PRIMARY KEY, slug text NOT NULL UNIQUE, nombre text NOT NULL, categoria text NOT NULL DEFAULT 'official_merchandise', descripcion text, imagen_url text, activo boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
      CREATE TABLE public.store_central_offers (id bigint PRIMARY KEY, product_id bigint NOT NULL REFERENCES public.store_catalog_products(id), activo boolean NOT NULL DEFAULT false, stock integer NOT NULL DEFAULT 0, precio numeric(12,2), moneda text NOT NULL DEFAULT 'ARS', pais_codigo text, ciudad text, radio_entrega_km numeric(6,2), updated_at timestamptz NOT NULL DEFAULT now());
      CREATE TABLE public.store_sede_offers (id bigint PRIMARY KEY, sede_id text NOT NULL REFERENCES public.sedes(id), product_id bigint NOT NULL REFERENCES public.store_catalog_products(id), autorizado boolean NOT NULL DEFAULT false, autorizado_por_super boolean NOT NULL DEFAULT false, activo boolean NOT NULL DEFAULT false, precio numeric(12,2), moneda text NOT NULL DEFAULT 'ARS', stock integer NOT NULL DEFAULT 0, updated_at timestamptz NOT NULL DEFAULT now());
    `);
    await assert.rejects(wrongTypes.exec(STORE_MIGRATION_SQL), /TIENDA_SCHEMA_REQUIRES_SEDES_ID_INTEGER_OR_BIGINT/);
  } finally {
    await wrongTypes.close();
  }

  const noRoles = new PGlite();
  try {
    await noRoles.exec(EXISTING_STORE_SCHEMA_SQL);
    await assert.rejects(noRoles.exec(STORE_MIGRATION_SQL), /TIENDA_SCHEMA_REQUIRES_SUPABASE_ROLES/);
  } finally {
    await noRoles.close();
  }
});
