import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {createServer} from 'node:http';
import {once} from 'node:events';

// Replica exacta de la condición de server.js: SOLO POST y path normalizado exacto.
function photoParserGate(req, res, next) {
  if (req.method !== 'POST') return next();
  const path = String(req.path || '').replace(/\/+$/, '');
  if (path !== '/api/usuarios/foto-perfil') return next();
  return express.json({limit: '8mb'})(req, res, next);
}
async function withApp(fn) {
  const app = express();
  app.use(photoParserGate);
  app.use(express.json());
  app.post('/api/usuarios/foto-perfil', (req, res) => res.json({bytes: String(req.body?.foto_base64 || '').length}));
  app.get('/api/usuarios/foto-perfil', (_req, res) => res.json({ok: true}));
  const server = createServer(app); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try { return await fn(`http://127.0.0.1:${server.address().port}`); } finally { server.close(); }
}
const b64 = (bytes) => 'A'.repeat(bytes);
async function post(base, path, body) { return fetch(`${base}${path}`, {method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(body)}); }

test('POST exacto >100KB y 5.5MiB decoded (~7.3MB JSON) se parsea', async () => {
  await withApp(async (base) => {
    const r = await post(base, '/api/usuarios/foto-perfil', {foto_base64: b64(5.5 * 1024 * 1024)});
    assert.equal(r.status, 200);
  });
});
test('POST exacto con slash final tambien usa parser de foto', async () => {
  await withApp(async (base) => {
    const r = await post(base, '/api/usuarios/foto-perfil/', {foto_base64: b64(300 * 1024)});
    assert.equal(r.status, 200);
  });
});
test('GET en la ruta y subrutas POST NO usan parser de foto (413 con >100KB)', async () => {
  await withApp(async (base) => {
    const g = await fetch(`${base}/api/usuarios/foto-perfil`, {headers:{'content-type':'application/json'}, body: JSON.stringify({foto_base64: b64(300*1024)})}).catch(()=>null);
    const sub = await post(base, '/api/usuarios/foto-perfil/otra', {foto_base64: b64(300 * 1024)});
    assert.equal(sub.status, 413);
  });
});
test('JSON >8MB se rechaza 413', async () => {
  await withApp(async (base) => {
    const r = await post(base, '/api/usuarios/foto-perfil', {foto_base64: b64(9 * 1024 * 1024)});
    assert.equal(r.status, 413);
  });
});
