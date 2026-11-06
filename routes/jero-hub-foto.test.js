import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { mountAdminQaPanelRoutes } from './adminQaPanel.js';

function appWith({ onUpsert } = {}) {
  const uploaded = [];
  const supabaseAdmin = {
    storage: { from: () => ({
      upload: async (p, buf, opts) => { uploaded.push({ p, size: buf.length, opts }); return { error: null }; },
      getPublicUrl: (p) => ({ data: { publicUrl: `https://cdn.test/${p}` } }),
      remove: async () => ({ error: null }),
    }) },
    from: () => ({ upsert: (row) => ({ select: () => ({ single: async () => { onUpsert?.(row); return { data: { ...row, titulo: 'Título existente' }, error: null }; } }) }) }),
  };
  const app = express();
  const user = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', email: 'admin@test.invalid', email_confirmed_at: '2026-01-01' };
  mountAdminQaPanelRoutes(app, {
    supabaseAdmin,
    getAuthenticatedUser: async () => ({ user, status: 200 }),
    fetchUserRoleRowForAuthUser: async () => ({ user_id: user.id, email: user.email, role: 'super_admin' }),
    legacySuperAdminEmails: [],
  });
  return { app, uploaded };
}

async function call(app, form) {
  const server = app.listen(0);
  try {
    const port = server.address().port;
    const res = await fetch(`http://127.0.0.1:${port}/api/hub-deporte-config/foto`, { method: 'POST', body: form });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  } finally { server.close(); }
}

test('rechaza sin imagen', async () => {
  const { app } = appWith();
  const fd = new FormData();
  fd.append('deporte', 'padbol'); fd.append('card_key', 'buscar-partido');
  fd.append('foto', new Blob(['no soy imagen'], { type: 'text/plain' }), 'a.txt');
  const r = await call(app, fd);
  assert.equal(r.status, 400);
});

test('rechaza sin deporte o tarjeta', async () => {
  const { app } = appWith();
  const fd = new FormData();
  fd.append('foto', new Blob(['x'], { type: 'image/png' }), 'a.png');
  const r = await call(app, fd);
  assert.equal(r.status, 400);
});

test('sube imagen, no toca titulos y devuelve 201', async () => {
  let recibido = null;
  const { app, uploaded } = appWith({ onUpsert: (row) => { recibido = row; } });
  const fd = new FormData();
  fd.append('deporte', 'padbol'); fd.append('card_key', 'buscar-partido');
  fd.append('foto', new Blob([Buffer.concat([Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]), Buffer.alloc(16)])], { type: 'image/png' }), 'foto.png');
  const r = await call(app, fd);
  assert.equal(r.status, 201);
  assert.equal(uploaded.length, 1);
  assert.deepEqual(Object.keys(recibido).sort(), ['card_key', 'deporte', 'imagen_url']);
  assert.equal(r.body.titulo, 'Título existente');
});

test('rechaza imagen mayor a 2 MB', async () => {
  const { app } = appWith();
  const fd = new FormData();
  fd.append('deporte', 'padbol'); fd.append('card_key', 'x');
  fd.append('foto', new Blob([Buffer.alloc(2 * 1024 * 1024 + 10)], { type: 'image/jpeg' }), 'big.jpg');
  const r = await call(app, fd);
  assert.equal(r.status, 400);
});
