import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createRequireTorneoAdminByTorneoId } from './torneoAdminGuard.js';
import { registerNationsScoreboardGenerationRoute } from '../routes/nationsScoreboardGeneration.js';

const USERS = {
  'u-admin': { id: 'u-admin', email: 'admin@test', role: { role: 'super_admin' } },
  'u-sede10': { id: 'u-sede10', email: 'sede10@test', role: { role: 'admin_club', sede_id: 10 } },
  'u-sede20': { id: 'u-sede20', email: 'sede20@test', role: { role: 'admin_club', sede_id: 20 } },
  'u-player': { id: 'u-player', email: 'player@test', role: { role: 'jugador', sede_id: 10 } },
};
function makeApp({ enabled, pool = { connect() {} }, generate }) {
  const guard = createRequireTorneoAdminByTorneoId({
    adminDeps: {
      getAuthenticatedUser: async req => {
        const id = req.headers['x-test-user'];
        return id ? { user: USERS[id]?.user ?? { id, email: `${id}@test` } } : { user: null };
      },
      fetchUserRoleRowForAuthUser: async user => USERS[user.id]?.role ?? null,
    },
    fetchTorneoScopeById: async id => (String(id) === '999' ? { exists: false, sedeId: null } : { exists: true, sedeId: 10 }),
  });
  const app = express();
  app.use(express.json());
  registerNationsScoreboardGenerationRoute(app, {
    pool, supabaseAdmin: { from() {} }, enabled, requireTorneoAdmin: guard, generate,
    sendError: (res, err) => res.status(Number(err.status) || 500).json({ error: err.message }),
    log: () => {}, logError: () => {},
  });
  return app;
}
async function post(app, user, body = {}) {
  const server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  try {
    const r = await fetch(`http://127.0.0.1:${server.address().port}/api/torneos/9/generar-scoreboards`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...(user ? { 'x-test-user': user } : {}) }, body: JSON.stringify(body),
    });
    return { status: r.status, body: await r.json() };
  } finally { await new Promise(r => server.close(r)); }
}

test('endpoint real: 401 sin usuario, sin invocar servicio', async () => {
  let calls = 0;
  const { status } = await post(makeApp({ enabled: false, generate: () => { calls++; } }), null);
  assert.equal(status, 401); assert.equal(calls, 0);
});
test('endpoint real: 403 rol no admin y 403 sede ajena', async () => {
  let calls = 0;
  const a = makeApp({ enabled: false, generate: () => { calls++; } });
  assert.equal((await post(a, 'u-player')).status, 403);
  assert.equal((await post(a, 'u-sede20')).status, 403);
  assert.equal(calls, 0);
});
test('endpoint real: 404 torneo inexistente, sin invocar servicio', async () => {
  let calls = 0;
  const a = makeApp({ enabled: false, generate: () => { calls++; return { created: 1, skipped: 0, items: [] }; } });
  assert.equal((await post(a, 'u-admin')).status, 200);
  // Se usa ruta específica con id 999 para el 404.
  const server = a.listen(0); await new Promise(r => server.once('listening', r));
  try {
    const r = await fetch(`http://127.0.0.1:${server.address().port}/api/torneos/999/generar-scoreboards`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-test-user': 'u-admin' }, body: '{}' });
    assert.equal(r.status, 404);
  } finally { await new Promise(r => server.close(r)); }
  assert.equal(calls, 1);
});
test('endpoint real: admin permitido, legacy OFF y bulk ON usan auth server-side', async () => {
  const calls = [];
  const generate = (...args) => { calls.push(args); return { created: 1, skipped: 0, items: [] }; };
  const legacy = makeApp({ enabled: false, generate });
  assert.equal((await post(legacy, 'u-admin', { role: 'admin_club', sede_id: 99 })).status, 200);
  assert.equal(calls[0][0].from !== undefined, true);
  assert.equal(calls[0][1], '9');
  const pool = { connect() {} };
  const bulk = makeApp({ enabled: true, pool, generate });
  assert.equal((await post(bulk, 'u-sede10', { role: 'super_admin', sede_id: 99 })).status, 200);
  assert.equal(calls[1][0], pool);
  assert.equal(calls[1][3].user.id, 'u-sede10');
  assert.equal(calls[1][3].role.rol, 'admin_club');
});
test('endpoint real: flag ON sin pool 503, sin fallback legacy', async () => {
  let calls = 0;
  const a = makeApp({ enabled: true, pool: null, generate: () => { calls++; } });
  assert.equal((await post(a, 'u-admin')).status, 503);
  assert.equal(calls, 0);
});
