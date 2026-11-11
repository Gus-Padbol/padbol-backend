/**
 * Gate editorial del Hub + contrato de éxito real.
 * - PATCH /api/hub-deporte-config: editor_contenido y super_admin 200 con fila guardada y
 *   relectura por GET; admin_club / admin_nacional / jugador 403; anónimo 401.
 * - POST /api/hub-deporte-config/foto: imagen PNG sintética -> 201 con URL pública y
 *   relectura; roles no editoriales 403 y anónimo 401 SIN tocar storage ni DB.
 * - Si el upsert falla, se borra el objeto subido y la configuración previa queda intacta.
 * Fixtures locales, sin datos ni cuentas reales.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { mountAdminQaPanelRoutes } from './adminQaPanel.js';

const PNG = Buffer.concat([Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]), Buffer.alloc(16)]);
const USERS = {
  editor: { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', email: 'editor@test.invalid' },
  super: { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', email: 'super@test.invalid' },
  club: { id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', email: 'club@test.invalid' },
  nacional: { id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', email: 'nac@test.invalid' },
  jugador: { id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', email: 'jugador@test.invalid' },
};
const ROLES = {
  editor: { role: 'editor_contenido' }, super: { role: 'super_admin' },
  club: { role: 'admin_club', sede_id: 9 }, nacional: { role: 'admin_nacional' },
  jugador: { role: 'jugador' },
};

function build({ upsertFails = false } = {}) {
  const store = new Map();
  const uploads = [];
  const removed = [];
  const dbCalls = [];
  const rows = () => [...store.values()];
  const chain = {
    select: () => chain, order: () => chain, eq: (col, val) => { chain._eq = { col, val }; return chain; },
    then: (resolve) => { dbCalls.push('select'); const data = rows().filter((r) => !chain._eq || String(r[chain._eq.col]) === String(chain._eq.val)); resolve({ data, error: null }); },
    upsert: (payload) => { dbCalls.push('upsert'); const doUpsert = () => {
        if (upsertFails) return { data: null, error: new Error('upsert fallo') };
        const key = `${payload.deporte}|${payload.card_key}`;
        const prev = store.get(key) || {};
        const merged = { ...prev, ...payload };
        store.set(key, merged);
        return { data: merged, error: null };
      };
      return { select: () => ({ single: async () => { const r = doUpsert(); return r; } }) };
    },
  };
  const supabaseAdmin = {
    storage: { from: () => ({
      upload: async (p) => { uploads.push(p); return { error: null }; },
      getPublicUrl: (p) => ({ data: { publicUrl: `https://cdn.test/${p}` } }),
      remove: async (ps) => { removed.push(...ps); return { error: null }; },
    }) },
    from: (table) => (table === 'hub_deporte_config' ? chain : { select: () => chain }),
  };
  const app = express();
  app.use(express.json());
  mountAdminQaPanelRoutes(app, {
    supabaseAdmin,
    getAuthenticatedUser: async (req) => {
      const who = String(req.headers['x-fixture-user'] || '');
      return USERS[who] ? { user: USERS[who], status: 200 } : { user: null, status: 401, error: 'No autorizado' };
    },
    fetchUserRoleRowForAuthUser: async (user) => {
      const key = Object.keys(USERS).find((k) => USERS[k].id === user.id);
      return ROLES[key] || { role: 'jugador' };
    },
    legacySuperAdminEmails: [],
  });
  return { app, store, uploads, removed, dbCalls };
}

async function withServer(app, fn) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  try { return await fn(`http://127.0.0.1:${server.address().port}`); } finally { server.close(); }
}

const patch = (base, who, body = { deporte: 'padbol', card_key: 'buscar-partido', titulo: 'Titulo', subtitulo: 'Sub' }) =>
  fetch(`${base}/api/hub-deporte-config`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', ...(who ? { 'x-fixture-user': who } : {}) }, body: JSON.stringify(body) });

const get = (base) => fetch(`${base}/api/hub-deporte-config`).then((r) => r.json());

async function postFoto(base, who) {
  const fd = new FormData();
  fd.append('deporte', 'padbol');
  fd.append('card_key', 'buscar-partido');
  fd.append('foto', new Blob([PNG], { type: 'image/png' }), 'foto.png');
  return fetch(`${base}/api/hub-deporte-config/foto`, { method: 'POST', headers: who ? { 'x-fixture-user': who } : {}, body: fd });
}

test('editor y super_admin editan y suben foto con éxito real (200/201 + relectura)', async () => {
  for (const who of ['editor', 'super']) {
    const { app, uploads } = build();
    await withServer(app, async (base) => {
      const p = await patch(base, who);
      assert.equal(p.status, 200, `PATCH ${who} debe ser 200`);
      const saved = await p.json();
      assert.equal(saved.titulo, 'Titulo');
      const leido = await get(base);
      assert.equal(leido.find((r) => r.card_key === 'buscar-partido').titulo, 'Titulo', 'la fila se relee');

      const f = await postFoto(base, who);
      assert.equal(f.status, 201, `POST foto ${who} debe ser 201`);
      const foto = await f.json();
      assert.match(foto.imagen_url, /^https:\/\/cdn\.test\/deporte\/padbol\/buscar-partido\//);
      assert.equal(uploads.length, 1, 'subió exactamente un objeto');
      const leido2 = await get(base);
      const fila = leido2.find((r) => r.card_key === 'buscar-partido');
      assert.equal(fila.imagen_url, foto.imagen_url, 'la URL se relee');
      assert.equal(fila.titulo, 'Titulo', 'la foto conserva el título previo');
    });
  }
});

test('admin_club, admin_nacional y jugador reciben 403 sin tocar storage ni DB', async () => {
  for (const who of ['club', 'nacional', 'jugador']) {
    const { app, uploads, dbCalls } = build();
    await withServer(app, async (base) => {
      assert.equal((await patch(base, who)).status, 403, `PATCH ${who} 403`);
      assert.equal((await postFoto(base, who)).status, 403, `POST foto ${who} 403`);
      assert.equal(uploads.length, 0, 'sin subida');
      assert.equal(dbCalls.length, 0, 'sin llamadas a DB');
    });
  }
});

test('anónimo recibe 401 en ambas operaciones', async () => {
  const { app, uploads } = build();
  await withServer(app, async (base) => {
    assert.equal((await patch(base, '')).status, 401);
    assert.equal((await postFoto(base, '')).status, 401);
    assert.equal(uploads.length, 0);
  });
});

test('si el upsert falla, se limpia el objeto y se conserva la config previa', async () => {
  const { app, store, removed } = build({ upsertFails: true });
  store.set('padbol|buscar-partido', { deporte: 'padbol', card_key: 'buscar-partido', titulo: 'Titulo previo' });
  await withServer(app, async (base) => {
    const f = await postFoto(base, 'editor');
    assert.equal(f.status, 500);
    assert.equal(removed.length, 1, 'borra el objeto subido');
    assert.match(removed[0], /^deporte\/padbol\/buscar-partido\//);
    assert.equal(store.get('padbol|buscar-partido').titulo, 'Titulo previo', 'no pisa la config previa');
  });
});
