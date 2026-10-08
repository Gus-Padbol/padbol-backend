import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ADMIN_LEGACY_GET_ALIASES,
  mountAdminLegacyAliases,
  replayOnCanonicalRoute,
} from './adminLegacyAliases.js';

test('registra todas las URLs exactas del QA con destino administrativo canónico', () => {
  const registered = new Map();
  const app = { get(path, handler) { registered.set(path, handler); } };
  mountAdminLegacyAliases(app);
  assert.deepEqual([...registered.keys()].sort(), Object.keys(ADMIN_LEGACY_GET_ALIASES).sort());
  for (const [legacy, canonical] of Object.entries(ADMIN_LEGACY_GET_ALIASES)) {
    assert.ok(registered.has(legacy));
    assert.match(canonical, /^\/api\/admin\//);
  }
});

test('redirige con 307 y conserva la query hacia la ruta canónica', () => {
  let status = null;
  let location = null;
  const app = {};
  const req = { url: '/api/organizaciones?estado=pendiente' };
  const res = {
    redirect(code, target) {
      status = code;
      location = target;
    },
  };
  replayOnCanonicalRoute(app, req, res, () => assert.fail('no debe continuar al 404'), '/api/admin/organizaciones');
  assert.equal(status, 307);
  assert.equal(location, '/api/admin/organizaciones?estado=pendiente');
});
