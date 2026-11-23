import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const migration = read('sql/candidates/20261123120000_store_orders_schema.sql');
const rollback = read('sql/candidates/20261123120000_store_orders_schema.rollback.sql');
const verify = read('sql/candidates/20261123120000_store_orders_schema.verify.sql');
const reference = read('sql/migrations/rpc_schema_real.sql');
const docs = read('docs/sql/store_network_pilot.sql');

function tableBlock(sql, name) {
  const start = sql.indexOf(`create table if not exists public.${name} (`);
  if (start === -1) return null;
  const end = sql.indexOf('\n);', start);
  return sql.slice(start, end + 3);
}

test('referencia efectiva: las 4 tablas faltan y las 3 existentes tienen tipos reales', () => {
  for (const absent of ['store_orders', 'store_order_items', 'store_sede_config', 'store_sede_payment_methods']) {
    assert.equal(tableBlock(reference, absent), null, `${absent} no debe existir en el dump de referencia`);
  }
  const offers = tableBlock(reference, 'store_sede_offers');
  assert.ok(offers);
  assert.match(offers, /\n  precio numeric\(12,2\),/);
  assert.doesNotMatch(offers, /precio numeric\(12,2\) not null/);
  assert.match(offers, /\n  stock integer default 0 not null,/);
  assert.match(offers, /\n  sede_id integer not null,/);
  assert.match(offers, /\n  id bigint not null,/);
  assert.match(offers, /\n  autorizado_por_super boolean default false not null,/);
  assert.match(docs, /sede_id INTEGER NOT NULL REFERENCES public\.sedes\(id\) ON DELETE RESTRICT/);
  assert.doesNotMatch(docs, /idempotency/i);
});

test('migración aditiva: crea sólo las 4 tablas nuevas con los tipos reales', () => {
  assert.match(migration, /CREATE TABLE IF NOT EXISTS public\.store_sede_config \(\n  sede_id integer PRIMARY KEY REFERENCES public\.sedes\(id\)/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS public\.store_sede_payment_methods \(\n  id BIGSERIAL PRIMARY KEY,\n  sede_id integer NOT NULL REFERENCES public\.sedes\(id\)/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS public\.store_orders \(\n  id BIGSERIAL PRIMARY KEY,\n  codigo text NOT NULL UNIQUE,\n  sede_id integer NOT NULL REFERENCES public\.sedes\(id\) ON DELETE RESTRICT,\n  user_id uuid,/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS public\.store_order_items \(\n  id BIGSERIAL PRIMARY KEY,\n  order_id bigint NOT NULL REFERENCES public\.store_orders\(id\) ON DELETE CASCADE,\n  product_id bigint REFERENCES public\.store_catalog_products\(id\) ON DELETE SET NULL,/);
  assert.match(migration, /total numeric\(12,2\) NOT NULL DEFAULT 0 CHECK \(total >= 0\)/);
  assert.match(migration, /idempotency_key text,/);
  assert.match(migration, /idempotency_hash text,/);
  assert.match(migration, /CREATE UNIQUE INDEX IF NOT EXISTS store_orders_idempotency_uq\n  ON public\.store_orders \(user_id, sede_id, idempotency_key\)\n  WHERE idempotency_key IS NOT NULL/);
  assert.match(migration, /TIENDA_SCHEMA_REQUIRES_SEDES_ID_INTEGER/);
  assert.match(migration, /TIENDA_SCHEMA_REQUIRES_REAL_OFFER_TYPES/);
  // The migration is additive: it never drops or alters the three existing tables.
  assert.doesNotMatch(migration, /DROP TABLE|DROP COLUMN|ALTER COLUMN|TRUNCATE|DELETE FROM/i);
});

test('migración: RLS, revocaciones y RPC security definer con search_path fijo', () => {
  assert.equal((migration.match(/ENABLE ROW LEVEL SECURITY/g) || []).length, 4);
  assert.match(migration, /REVOKE ALL ON TABLE public\.store_orders FROM PUBLIC, anon, authenticated/);
  assert.match(migration, /REVOKE ALL ON TABLE public\.store_order_items FROM PUBLIC, anon, authenticated/);
  assert.match(migration, /REVOKE ALL ON TABLE public\.store_sede_config FROM PUBLIC, anon, authenticated/);
  assert.match(migration, /REVOKE ALL ON TABLE public\.store_sede_payment_methods FROM PUBLIC, anon, authenticated/);
  assert.match(migration, /GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public\.store_orders TO service_role/);
  assert.match(migration, /GRANT EXECUTE ON FUNCTION public\.store_create_order\(uuid, integer, text, jsonb, text, text\)\n  TO service_role/);
  assert.match(migration, /GRANT EXECUTE ON FUNCTION public\.store_update_order\(bigint, integer, text, text\)\n  TO service_role/);
  assert.match(migration, /SECURITY DEFINER\nSET search_path = pg_catalog, public/);
  assert.match(migration, /pg_advisory_xact_lock/);
  assert.match(migration, /STORE_IDEMPOTENCY_MISMATCH/);
  assert.match(migration, /FOR UPDATE OF o/);
  assert.match(migration, /stock >= \(v_item\.item->>'quantity'\)::integer/);
  assert.match(migration, /v_offer\.precio IS NULL OR v_offer\.precio < 0/);
  assert.match(migration, /STORE_CURRENCY_MISMATCH/);
  assert.match(migration, /STORE_PICKUP_UNAVAILABLE/);
});

test('rollback y verificación: no tocan las 3 tablas de catálogo/ofertas', () => {
  assert.match(rollback, /DROP FUNCTION IF EXISTS public\.store_update_order/);
  assert.match(rollback, /DROP FUNCTION IF EXISTS public\.store_create_order/);
  for (const table of ['store_order_items', 'store_orders', 'store_sede_payment_methods', 'store_sede_config']) {
    assert.match(rollback, new RegExp(`DROP TABLE IF EXISTS public\\.${table};`));
  }
  assert.doesNotMatch(rollback, /DROP TABLE IF EXISTS public\.store_(catalog_products|central_offers|sede_offers)/);
  assert.match(verify, /store_schema_verification/);
  assert.match(verify, /has_function_privilege\('anon'/);
  assert.match(verify, /store_orders', 'store_order_items', 'store_sede_config',\s*'store_sede_payment_methods'/);
});
