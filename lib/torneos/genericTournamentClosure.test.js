import assert from 'node:assert/strict';
import { test } from 'node:test';
import { persistGenericTournamentClosure } from './tournamentCompletionService.js';

const torneo = { id: 7, estado: 'en_curso', updated_at: '2026-11-22T21:00:00.123456' };
const equipos = [1, 2, 3, 4].map(id => ({ id }));
const puntosData = [
  { torneo_id: 7, equipo_id: 3, posicion: 1, puntos: 10, equipo_nombre: 'Campeón' },
  { torneo_id: 7, equipo_id: 1, posicion: 2, puntos: 6, equipo_nombre: 'Subcampeón' },
  { torneo_id: 7, equipo_id: 2, posicion: 3, puntos: 4, equipo_nombre: 'Tercero' },
  { torneo_id: 7, equipo_id: 4, posicion: 4, puntos: 3, equipo_nombre: 'Cuarto' },
];
const tabla = rows => rows.map(({ equipo_id, posicion, puntos }) => ({ torneo_id: 7, equipo_id, posicion, puntos }));
const committed = (status = 'completed') => ({
  data: { ok: true, status, torneo: { id: 7, estado: 'finalizado' }, tabla: tabla(puntosData) },
  error: null,
});
const closure = (db) => persistGenericTournamentClosure(db, {
  torneo, equipos, puntosData, fechaFin: '2026-11-22',
});

test('exito: un único RPC persiste sólo las cuatro columnas del ledger', async () => {
  const calls = [];
  const db = { async rpc(name, args) { calls.push({ name, args }); return committed(); } };
  const result = await closure(db);
  assert.equal(result.status, 'completed');
  assert.equal(result.torneo.estado, 'finalizado');
  assert.deepEqual(result.tabla, tabla(puntosData));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'finalizar_torneo_generico');
  assert.deepEqual(Object.keys(calls[0].args).sort(), [
    'p_expected_estado', 'p_expected_updated_at', 'p_fecha_fin', 'p_puntos', 'p_torneo_id',
  ]);
  assert.equal(calls[0].args.p_torneo_id, 7);
  assert.equal(calls[0].args.p_expected_estado, 'en_curso');
  assert.equal(calls[0].args.p_expected_updated_at, torneo.updated_at);
  assert.equal(calls[0].args.p_fecha_fin, '2026-11-22');
  for (const row of calls[0].args.p_puntos) {
    assert.deepEqual(Object.keys(row).sort(), ['equipo_id', 'posicion', 'puntos', 'torneo_id']);
  }
});

test('conflicto de concurrencia devuelve status sin lanzar ni confirmar escritura', async () => {
  const db = { async rpc() { return { data: { ok: false, status: 'conflict' }, error: null }; } };
  assert.deepEqual(await closure(db), { status: 'conflict' });
});

test('torneo inexistente devuelve not_found', async () => {
  const db = { async rpc() { return { data: { ok: false, status: 'not_found' }, error: null }; } };
  assert.deepEqual(await closure(db), { status: 'not_found' });
});

test('retry idempotente confirma el ledger histórico completo', async () => {
  const db = { async rpc() { return committed('idempotent'); } };
  const result = await closure(db);
  assert.equal(result.status, 'idempotent');
  assert.deepEqual(result.tabla, tabla(puntosData));
});

test('retry con ledger histórico incompleto no inventa filas', async () => {
  const db = {
    async rpc() {
      return { data: { ok: true, status: 'idempotent', torneo: { id: 7 }, tabla: tabla(puntosData).slice(0, 3) }, error: null };
    },
  };
  assert.deepEqual(await closure(db), { status: 'historical_ledger_incomplete', torneo: { id: 7 } });
});

test('un cierre confirmado que no coincide con el snapshot es un fallo de integridad', async () => {
  const db = {
    async rpc() {
      const rows = tabla(puntosData);
      rows[0].puntos = 999;
      return { data: { ok: true, status: 'completed', torneo: { id: 7 }, tabla: rows }, error: null };
    },
  };
  await assert.rejects(closure(db), error => error.status === 503 && error.code === 'TORNEO_CLOSURE_ATOMIC_UNCONFIRMED');
});

test('errores SQL de validación o concurrencia se exponen como 409 y el resto como 503', async () => {
  for (const [code, status] of [['40001', 409], ['22023', 409], ['55000', 503], ['23503', 503]]) {
    const db = { async rpc() { return { data: null, error: Object.assign(new Error('boom'), { code }) }; } };
    await assert.rejects(closure(db), error => error.status === status);
  }
});

test('una respuesta sin confirmación ok se rechaza aunque traiga torneo', async () => {
  const db = { async rpc() { return { data: { ok: false, status: 'completed', torneo: { id: 7 } }, error: null }; } };
  await assert.rejects(closure(db), error => error.status === 503);
});
