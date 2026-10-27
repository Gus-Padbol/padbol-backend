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

import { ensureReservaPendienteParaMpPg } from '../routes/reservaPendienteMp.js';

test('manual payment reservation persists manual pending states without legacy fallback', async () => {
  const queries = [];
  const pgPool = {
    query: async (sql, params) => {
      queries.push({ sql, params });
      if (/SELECT nombre FROM sedes/i.test(sql)) return { rows: [{ nombre: 'Sede Manual' }] };
      if (/SELECT id FROM sedes/i.test(sql)) return { rows: [{ id: 17 }] };
      if (/SELECT id, estado FROM reservas/i.test(sql)) return { rows: [] };
      if (/INSERT INTO reservas/i.test(sql)) return { rows: [{ id: 901 }] };
      throw new Error(`Unexpected query: ${sql}`);
    },
  };

  const reservation = await ensureReservaPendienteParaMpPg(pgPool, {
    sede_id: 17,
    fecha: '2026-11-15',
    hora_inicio: '18:00',
    cancha_id: 2,
    email: 'player@example.com',
    nombre: 'Player',
    precio: 1000,
  }, {
    paymentProvider: 'manual',
    initialEstado: 'pendiente_pago_manual',
    initialPagoEstado: 'pendiente',
    requirePaymentSchema: true,
  });

  assert.deepEqual(reservation, { reserva_id: 901, created: true });
  const insert = queries.find(({ sql }) => /INSERT INTO reservas/i.test(sql));
  assert.ok(insert);
  assert.ok(insert.params.includes('manual'));
  assert.ok(insert.params.includes('pendiente_pago_manual'));
});
