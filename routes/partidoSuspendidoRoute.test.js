import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createPartidosRouter } from './partidos.js';

test('el listado solo entrega partidos suspendidos al organizador o jugador autenticado', async () => {
  const rows = [
    { id: 11, estado: 'suspendido', capitan_user_id: 'owner', capitan_nombre: 'Organizador', capitan_foto_url: 'https://example.test/photo', partidos_abiertos_jugadores: [{ user_id: 'member' }], fecha: '2026-01-01', hora: '10:00', deporte: 'padbol' },
    { id: 12, estado: 'suspendido', capitan_user_id: 'other', capitan_nombre: 'Otro', capitan_foto_url: 'https://example.test/photo', partidos_abiertos_jugadores: [], fecha: '2026-01-01', hora: '10:00', deporte: 'padbol' },
  ];
  const db = { from(table) {
    let states = [];
    const query = { select() { return this; }, in(column, values) { if (table === 'partidos_abiertos' && column === 'estado') states = values; return this; }, eq() { return this; }, gte() { return this; }, order() { return this; }, or() { return this; }, maybeSingle() { return Promise.resolve({ data: null, error: null }); }, then(resolve) { return Promise.resolve({ data: table === 'partidos_abiertos' ? rows.filter((row) => states.includes(row.estado)) : [], error: null }).then(resolve); } };
    return query;
  } };
  const app = express();
  app.use(createPartidosRouter({ supabaseAdmin: db, getAuthenticatedUser: async (req) => ({ user: req.headers.authorization ? { id: req.headers.authorization } : null }) }));
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  try {
    const base = `http://127.0.0.1:${server.address().port}/abiertos`;
    for (const [user, ids] of [[null, []], ['member', [11]], ['owner', [11]], ['outsider', []]]) {
      const response = await fetch(base, user ? { headers: { authorization: user } } : {});
      assert.equal(response.status, 200);
      assert.deepEqual((await response.json()).map((row) => row.id), ids);
    }
  } finally { await new Promise((resolve) => server.close(resolve)); }
});
