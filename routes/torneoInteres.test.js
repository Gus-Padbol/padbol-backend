import test from 'node:test';
import assert from 'node:assert/strict';
import { mountTorneoInteresRoutes } from './torneoInteres.js';

function setup({ user = { id: 'player-a' }, rows = [], dbError = null } = {}) {
  const routes = {};
  const app = Object.fromEntries(['get', 'post', 'delete'].map(method => [method, (path, handler) => { routes[`${method} ${path}`] = handler; }]));
  const calls = [];
  const supabaseAdmin = { from(table) {
    assert.equal(table, 'torneo_interes');
    const filters = {};
    return { select() { return this; }, eq(key, value) { filters[key] = value; calls.push([key, value]); return this; },
      async maybeSingle() { return { data: rows.find(row => row.sede_id === filters.sede_id && row.user_id === filters.user_id) || null, error: dbError }; } };
  } };
  mountTorneoInteresRoutes(app, { supabaseAdmin, getAuthenticatedUser: async () => ({ user, status: 401, error: 'Unauthorized' }), fetchUserRoleRowForAuthUser: async () => null });
  return { handler: routes['get /api/sedes/:id/torneo-interes'], calls };
}
async function request(handler, id) {
  const res = { code: 200, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
  await handler({ params: { id } }, res);
  return res;
}
test('consulta solo la sede solicitada y el usuario autenticado', async () => {
  const { handler, calls } = setup({ rows: [{ sede_id: 7, user_id: 'player-a' }, { sede_id: 8, user_id: 'player-b' }] });
  assert.deepEqual((await request(handler, '7')).body, { registrado: true });
  assert.deepEqual(calls, [['sede_id', 7], ['user_id', 'player-a']]);
  assert.deepEqual((await request(handler, '8')).body, { registrado: false });
});
test('sin sesión o sede inválida deniega antes de consultar', async () => {
  const noAuth = setup({ user: null });
  assert.equal((await request(noAuth.handler, '7')).code, 401);
  assert.equal(noAuth.calls.length, 0);
  const invalid = setup();
  assert.equal((await request(invalid.handler, '0')).code, 400);
  assert.equal(invalid.calls.length, 0);
});
test('un fallo de base no se presenta como estado no registrado', async () => {
  const { handler } = setup({ dbError: new Error('private database details') });
  const result = await request(handler, '7');
  assert.equal(result.code, 500);
  assert.deepEqual(result.body, { error: 'Error al consultar interés' });
});
