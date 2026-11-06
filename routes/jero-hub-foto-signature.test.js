import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { mountAdminQaPanelRoutes } from './adminQaPanel.js';

const PNG = Buffer.concat([Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]), Buffer.alloc(16)]);
const JPG = Buffer.concat([Buffer.from([0xff,0xd8,0xff,0xe0]), Buffer.alloc(16)]);

function build({ authOk = true, uploadFails = false, upsertFails = false, onUpload } = {}) {
  const uploads = [];
  const removed = [];
  const supabaseAdmin = {
    storage: { from: () => ({
      upload: async (p, buf, opts) => { uploads.push({ p, opts }); onUpload?.(p); return uploadFails ? { error: new Error('storage caido') } : { error: null }; },
      getPublicUrl: (p) => ({ data: { publicUrl: `https://cdn.test/${p}` } }),
      remove: async (ps) => { removed.push(...ps); return { error: null }; },
    }) },
    from: () => ({ upsert: (row) => ({ select: () => ({ single: async () => upsertFails
      ? { data: null, error: new Error('upsert fallo') }
      : { data: { ...row, titulo: 'Titulo previo' }, error: null } }) }) }),
  };
  const app = express();
  const user = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', email: 'admin@test.invalid', email_confirmed_at: '2026-01-01' };
  mountAdminQaPanelRoutes(app, {
    supabaseAdmin,
    getAuthenticatedUser: async () => (authOk ? { user, status: 200 } : null),
    fetchUserRoleRowForAuthUser: async () => ({ user_id: user.id, email: user.email, role: 'super_admin' }),
    legacySuperAdminEmails: [],
  });
  return { app, uploads, removed };
}
async function post(app, { deporte = 'padbol', cardKey = 'buscar-partido', bytes = PNG, type = 'image/png', name = 'foto.png' } = {}) {
  const server = app.listen(0);
  try {
    const fd = new FormData();
    if (deporte) fd.append('deporte', deporte);
    if (cardKey) fd.append('card_key', cardKey);
    if (bytes) fd.append('foto', new Blob([bytes], { type }), name);
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/hub-deporte-config/foto`, { method: 'POST', body: fd });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  } finally { server.close(); }
}

test('sin autenticacion no sube nada', async () => {
  const { app, uploads } = build({ authOk: false });
  const r = await post(app);
  if (!(r.status === 401 || r.status === 403)) console.log('ESTADO SIN AUTH:', r.status, JSON.stringify(r.body));
  assert.ok(r.status === 401 || r.status === 403);
  assert.equal(uploads.length, 0);
});

test('MIME falsificado con contenido no imagen es rechazado', async () => {
  const { app, uploads } = build();
  const r = await post(app, { bytes: Buffer.from('esto no es una imagen'), type: 'image/png' });
  assert.equal(r.status, 400);
  assert.equal(uploads.length, 0);
});

test('JPEG real es aceptado y se guarda el contentType real', async () => {
  const { app, uploads } = build();
  const r = await post(app, { bytes: JPG, type: 'image/jpeg', name: 'f.jpg' });
  assert.equal(r.status, 201);
  assert.equal(uploads[0].opts.contentType, 'image/jpeg');
});

test('fallo de storage no crea fila', async () => {
  const { app } = build({ uploadFails: true });
  const r = await post(app);
  assert.equal(r.status, 500);
});

test('fallo de upsert elimina el objeto subido', async () => {
  const { app, removed } = build({ upsertFails: true });
  const r = await post(app);
  assert.equal(r.status, 500);
  assert.equal(removed.length, 1);
});

test('reintento sobre la misma tarjeta no duplica fila', async () => {
  const { app } = build();
  const a = await post(app);
  const b = await post(app);
  assert.equal(a.status, 201);
  assert.equal(b.status, 201);
  assert.equal(a.body.deporte, b.body.deporte);
  assert.equal(a.body.card_key, b.body.card_key);
});

test('clave con traversal o separador es rechazada', async () => {
  const { app, uploads } = build();
  for (const clave of ['../etc', 'a/b', '.oculto', 'x'.repeat(80)]) {
    const r = await post(app, { cardKey: clave });
    assert.equal(r.status, 400, `clave aceptada: ${clave}`);
  }
  assert.equal(uploads.length, 0);
});

test('rol no autorizado no sube nada', async () => {
  const uploads = [];
  const supabaseAdmin = { storage: { from: () => ({ upload: async () => { uploads.push(1); return { error: null }; }, getPublicUrl: () => ({ data: { publicUrl: 'x' } }), remove: async () => ({}) }) }, from: () => ({}) };
  const app = express();
  const user = { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', email: 'jugador@test.invalid', email_confirmed_at: '2026-01-01' };
  mountAdminQaPanelRoutes(app, {
    supabaseAdmin,
    getAuthenticatedUser: async () => ({ user, status: 200 }),
    fetchUserRoleRowForAuthUser: async () => ({ user_id: user.id, email: user.email, role: 'jugador' }),
    legacySuperAdminEmails: [],
  });
  const r = await post(app);
  assert.ok(r.status === 401 || r.status === 403, `estado inesperado ${r.status}`);
  assert.equal(uploads.length, 0);
});
