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

test('reproduce query y devuelve el 401/403 de la ruta canónica, no un 404 del alias', () => {
  let replayedUrl = null;
  const app = {
    handle(req, res) {
      replayedUrl = req.url;
      res.headersSent = true;
      res.statusCode = 401;
    },
  };
  const req = { url: '/api/organizaciones?estado=pendiente' };
  const res = { headersSent: false, statusCode: 200 };
  replayOnCanonicalRoute(app, req, res, () => assert.fail('no debe continuar al 404'), '/api/admin/organizaciones');
  assert.equal(replayedUrl, '/api/admin/organizaciones?estado=pendiente');
  assert.equal(res.statusCode, 401);
});
