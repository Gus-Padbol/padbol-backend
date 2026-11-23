import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('el router compatible de /api/clases se monta antes del router legacy /:id', () => {
  const src = fs.readFileSync(new URL('../../server.js', import.meta.url), 'utf8');
  const compatible = src.indexOf("app.use('/api/clases', createClasesRouter");
  const legacy = src.indexOf('registerModuloClasesRoutes(app');
  assert.ok(compatible >= 0, 'fetching compat mount');
  assert.ok(legacy >= 0, 'legacy mount');
  assert.ok(compatible < legacy, 'compat mount must precede legacy /:id');
});
