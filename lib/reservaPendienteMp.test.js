import test from 'node:test';
import assert from 'node:assert/strict';
import {
  persistMercadoPagoPreferencePg,
} from '../routes/reservaPendienteMp.js';

function createRecordingPgPool({ throwOnUpdate = null } = {}) {
  const queries = [];
  return {
    queries,
    query: async (sql, params) => {
      queries.push({ sql, params });
      if (throwOnUpdate) throw throwOnUpdate;
      return { rows: [] };
    },
  };
}

test('persistMercadoPagoPreferencePg stores mp_preference_id and payment_provider', async () => {
  const pgPool = createRecordingPgPool();

  await persistMercadoPagoPreferencePg(pgPool, 42, 'pref-abc-123');

  assert.equal(pgPool.queries.length, 1);
  assert.match(pgPool.queries[0].sql, /mp_preference_id/i);
  assert.match(pgPool.queries[0].sql, /payment_provider/i);
  assert.deepEqual(pgPool.queries[0].params, [42, 'pref-abc-123', 'mercadopago']);
});

test('persistMercadoPagoPreferencePg no-ops when preference id is null', async () => {
  const pgPool = createRecordingPgPool();

  await persistMercadoPagoPreferencePg(pgPool, 42, null);
  await persistMercadoPagoPreferencePg(pgPool, 42, '   ');

  assert.equal(pgPool.queries.length, 0);
});

test('persistMercadoPagoPreferencePg ignores missing column errors', async () => {
  const columnErr = new Error('column "mp_preference_id" of relation "reservas" does not exist');
  const pgPool = createRecordingPgPool({ throwOnUpdate: columnErr });

  await assert.doesNotReject(() => persistMercadoPagoPreferencePg(pgPool, 42, 'pref-1'));
});

test('persistMercadoPagoPreferencePg rethrows unexpected database errors', async () => {
  const pgPool = createRecordingPgPool({
    throwOnUpdate: new Error('connection terminated unexpectedly'),
  });

  await assert.rejects(
    () => persistMercadoPagoPreferencePg(pgPool, 42, 'pref-1'),
    /connection terminated/i,
  );
});
