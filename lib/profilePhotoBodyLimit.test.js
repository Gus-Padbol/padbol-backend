import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {createServer} from 'node:http';
import {once} from 'node:events';

async function withApp(routeParser, fn) {
  const app = express();
  if (routeParser) app.use('/api/usuarios/foto-perfil', express.json({limit: '8mb'}));
  app.use(express.json());
  app.post('/api/usuarios/foto-perfil', (req, res) => res.json({bytes: String(req.body?.foto_base64 || '').length}));
  const server = createServer(app); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try { return await fn(`http://127.0.0.1:${server.address().port}`); } finally { server.close(); }
}
const big = 'A'.repeat(300 * 1024); // ~300 KB de JSON base64, >100kb default
test('parser de ruta acepta >100KB antes del parser global (foto perfil)', async () => {
  await withApp(true, async (base) => {
    const r = await fetch(`${base}/api/usuarios/foto-perfil`, {method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({foto_base64: big})});
    assert.equal(r.status, 200);
    assert.equal((await r.json()).bytes, big.length);
  });
});
test('sin parser de ruta, el default 100kb rechaza 413', async () => {
  await withApp(false, async (base) => {
    const r = await fetch(`${base}/api/usuarios/foto-perfil`, {method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({foto_base64: big})});
    assert.equal(r.status, 413);
  });
});
test('parser de ruta sigue rechazando por encima de 8mb', async () => {
  await withApp(true, async (base) => {
    const huge = 'A'.repeat(9 * 1024 * 1024);
    const r = await fetch(`${base}/api/usuarios/foto-perfil`, {method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({foto_base64: huge})});
    assert.equal(r.status, 413);
  });
});
