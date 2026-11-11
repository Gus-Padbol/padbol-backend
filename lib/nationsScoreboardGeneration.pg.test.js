import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { fixture, match, players, ACTOR } from './fixtures/scoreboardBulkFixture.js';
import { createRequireTorneoAdminByTorneoId } from './torneoAdminGuard.js';
import { registerNationsScoreboardGenerationRoute } from '../routes/nationsScoreboardGeneration.js';
import { generarScoreboardsForTorneo } from '../src/scoreboard/scoreboardTorneoService.js';

// El issuer es sintético (header x-test-user); la autorización y la base son
// reales: se usa requireAdminUser + user_roles del fixture + facade/servicio.
async function appFor(f) {
  const guard = createRequireTorneoAdminByTorneoId({
    adminDeps: {
      getAuthenticatedUser: async req => req.headers['x-test-user'] === ACTOR
        ? { user: { id: ACTOR, email: 'qa@example.invalid' } }
        : { user: null },
      fetchUserRoleRowForAuthUser: async user => (await f.db.query('SELECT role,sede_id FROM user_roles WHERE user_id=$1', [user.id])).rows[0] ?? null,
    },
    fetchTorneoScopeById: async id => {
      const r = await f.db.query('SELECT id,sede_id FROM torneos WHERE id=$1', [Number(id)]);
      return r.rows[0] ? { exists: true, sedeId: Number(r.rows[0].sede_id) } : { exists: false, sedeId: null };
    },
  });
  const app = express(); app.use(express.json());
  registerNationsScoreboardGenerationRoute(app, {
    pool: f.pool, supabaseAdmin: { from() {} }, enabled: true, requireTorneoAdmin: guard,
    generate: generarScoreboardsForTorneo,
    sendError: (res, err) => res.status(Number(err.status) || 500).json({ error: err.message }),
    log: () => {}, logError: () => {},
  });
  const server = app.listen(0); await new Promise(r => server.once('listening', r));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}
async function post(base, body = {}) {
  const r = await fetch(`${base}/api/torneos/901/generar-scoreboards`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-test-user': ACTOR }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
}

test('endpoint real + guard + facade/servicio + SQL candidato: roster 2/3/4, idempotencia y 0 writes sin cruces', async () => {
  for (const size of [2, 3, 4]) {
    const f = await fixture({ nations: true, matches: [match(101, 1, 2, null)] });
    try {
      await f.db.query('UPDATE equipos SET jugadores=$1 WHERE id=1', [JSON.stringify(players(1, size))]);
      await f.db.query('UPDATE equipos SET jugadores=$1 WHERE id=2', [JSON.stringify(players(2, size))]);
      await f.db.query('DELETE FROM torneo_partido_alineaciones');
      const { server, base } = await appFor(f);
      try {
        const first = await post(base, { canchas_rotacion: ['1'] });
        assert.equal(first.status, 200); assert.equal(first.body.created, 1);
        const once = await f.rows(); assert.equal(once.length, 1); assert.equal(once[0].partido_torneo_id, 101);
        assert.deepEqual(once[0].equipo_a_jugadores.map(p => p.user_id), players(1, size).map(p => p.user_id));
        assert.deepEqual(once[0].equipo_b_jugadores.map(p => p.user_id), players(2, size).map(p => p.user_id));
        assert.equal(new Set([...once[0].equipo_a_jugadores, ...once[0].equipo_b_jugadores].map(p => p.user_id)).size, size * 2);
        const second = await post(base, { canchas_rotacion: ['1'] });
        assert.equal(second.status, 200); assert.equal(second.body.created, 0); assert.equal(second.body.existing, 1);
        assert.deepEqual(await f.rows(), once);
      } finally { await new Promise(r => server.close(r)); }
    } finally { await f.close(); }
  }
  const empty = await fixture({ matches: [match(101, null, 2, null)] });
  try {
    const { server, base } = await appFor(empty);
    try { const r = await post(base); assert.equal(r.status, 200); assert.equal(r.body.created, 0); assert.equal((await empty.rows()).length, 0); }
    finally { await new Promise(r => server.close(r)); }
  } finally { await empty.close(); }
});


test('endpoint real rechaza identidad cruzada A/B sin escribir', async () => {
  const f = await fixture({ nations: true, matches: [match(101, 1, 2, null)] });
  try {
    const crossed = players(1, 2); // un jugador de A también en B
    await f.db.query('UPDATE equipos SET jugadores=$1 WHERE id=1', [JSON.stringify(players(1, 2))]);
    await f.db.query('UPDATE equipos SET jugadores=$1 WHERE id=2', [JSON.stringify(crossed)]);
    await f.db.query('DELETE FROM torneo_partido_alineaciones');
    const { server, base } = await appFor(f);
    try { const r = await post(base); assert.equal(r.status, 200); assert.equal(r.body.created, 0); assert.equal((await f.rows()).length, 0); }
    finally { await new Promise(r => server.close(r)); }
  } finally { await f.close(); }
});
