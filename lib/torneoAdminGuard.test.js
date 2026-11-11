import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequireTorneoAdminByTorneoId } from './torneoAdminGuard.js';

function response() {
  const out = { statusCode: 200, body: null };
  return {
    out,
    status(code) { this.statusCode = code; out.statusCode = code; return this; },
    json(body) { this.body = body; out.body = body; return this; },
    get statusCode() { return out.statusCode; },
    set statusCode(v) { out.statusCode = v; },
    get body() { return out.body; },
    set body(v) { out.body = v; },
  };
}
function guard({ user = null, role = null, scope = { exists: true, sedeId: 10 } } = {}) {
  const deps = {
    getAuthenticatedUser: async () => ({ user }),
    fetchUserRoleRowForAuthUser: async () => role,
    legacySuperAdminEmails: [],
  };
  return createRequireTorneoAdminByTorneoId({ adminDeps: deps, fetchTorneoScopeById: async () => scope });
}
const req = { headers: { authorization: 'Bearer synthetic' } };

test('401 sin usuario no consulta torneo ni permite', async () => {
  let scopes = 0;
  const g = createRequireTorneoAdminByTorneoId({
    adminDeps: { getAuthenticatedUser: async () => ({ user: null }), fetchUserRoleRowForAuthUser: async () => null },
    fetchTorneoScopeById: async () => { scopes++; return { exists: true, sedeId: 10 }; },
  });
  const res = response();
  assert.equal(await g(req, res, 1), null);
  assert.equal(res.statusCode, 401); assert.equal(scopes, 0);
});
test('403 sin rol admin y con torneo existente', async () => {
  const res = response();
  assert.equal(await guard({ user: { id: 'u1', email: 'u1@test' }, role: { rol: 'jugador', sede_id: 10 } })(req, res, 1), null);
  assert.equal(res.statusCode, 403);
});
test('403 admin_club de otra sede', async () => {
  const res = response();
  assert.equal(await guard({ user: { id: 'u1', email: 'u1@test' }, role: { rol: 'admin_club', sede_id: 20 } })(req, res, 1), null);
  assert.equal(res.statusCode, 403); assert.match(res.body.error, /otra sede/);
});
test('admin permitido y torneo ajeno inexistente 404', async () => {
  const res = response();
  const auth = { user: { id: 'u1', email: 'u1@test' }, role: { rol: 'super_admin', sede_id: null } };
  assert.deepEqual(await guard({ user: auth.user, role: auth.role })(req, res, 1), auth);
  assert.equal(res.statusCode, 200);
  const missing = response();
  assert.equal(await guard({ user: auth.user, role: auth.role, scope: { exists: false, sedeId: null } })(req, missing, 99), null);
  assert.equal(missing.statusCode, 404);
});
