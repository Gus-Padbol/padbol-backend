import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createScoreboardBulkHandler } from '../src/scoreboard/scoreboardBulkHttp.js';

async function withServer(handler, fn) {
  const app = express();
  app.use(express.json());
  app.post('/api/torneos/:id/generar-scoreboards', (req, res, next) => {
    req.torneoAdminAuth = req.headers['x-test-auth'] === 'denied'
      ? null
      : { user: { id: 'server-user' }, role: { rol: 'super_admin' } };
    return handler(req, res, next);
  });
  app.use((err, req, res, next) => res.status(Number(err.status) || 500).json({ error: err.message }));
  const server = app.listen(0);
  try { await new Promise(r => server.once('listening', r)); return await fn(server.address().port); }
  finally { await new Promise(r => server.close(r)); }
}

test('sin auth server-side devuelve 401 y no llama a legacy/bulk', async () => {
  let calls = 0;
  const handler = createScoreboardBulkHandler({ legacy: () => { calls++; }, bulk: () => { calls++; } });
  await withServer(handler, async port => {
    const r = await fetch(`http://127.0.0.1:${port}/api/torneos/9/generar-scoreboards`, { method: 'POST', headers: { 'x-test-auth': 'denied' } });
    assert.equal(r.status, 401); assert.equal(calls, 0);
  });
});

test('feature OFF preserva legacy y no toca pool', async () => {
  let legacyArgs, bulkCalls = 0;
  const handler = createScoreboardBulkHandler({
    enabled: false,
    supabaseAdmin: { from() {} },
    legacy: (db, id, body) => { legacyArgs = [db, id, body]; return { created: 1 }; },
    bulk: () => { bulkCalls++; },
  });
  await withServer(handler, async port => {
    const r = await fetch(`http://127.0.0.1:${port}/api/torneos/9/generar-scoreboards`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ role: 'super_admin' }) });
    assert.equal(r.status, 200); assert.equal((await r.json()).created, 1);
    assert.equal(bulkCalls, 0); assert.equal(legacyArgs[1], '9');
  });
});

test('feature ON usa pool y auth server-side, ignorando role/sede del body', async () => {
  let bulkArgs;
  const handler = createScoreboardBulkHandler({
    enabled: true,
    pool: { connect() {} },
    legacy: () => { throw new Error('legacy must not run'); },
    bulk: (pool, id, body, auth) => { bulkArgs = { pool, id, body, auth }; return { created: 2 }; },
  });
  await withServer(handler, async port => {
    const r = await fetch(`http://127.0.0.1:${port}/api/torneos/9/generar-scoreboards`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ role: 'admin_club', sede_id: 999 }) });
    assert.equal(r.status, 200); assert.equal((await r.json()).created, 2);
    assert.equal(bulkArgs.id, '9'); assert.equal(bulkArgs.auth.user.id, 'server-user');
    assert.equal(bulkArgs.auth.role.rol, 'super_admin');
  });
});

test('feature ON sin pool falla 503 sin caer a legacy', async () => {
  let legacyCalls = 0;
  const handler = createScoreboardBulkHandler({ enabled: true, pool: null, legacy: () => { legacyCalls++; }, bulk: () => {} });
  await withServer(handler, async port => {
    const r = await fetch(`http://127.0.0.1:${port}/api/torneos/9/generar-scoreboards`, { method: 'POST' });
    assert.equal(r.status, 503); assert.equal(legacyCalls, 0);
  });
});
