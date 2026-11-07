/**
 * Gate editorial del Hub: PATCH /api/hub-deporte-config y POST /api/hub-deporte-config/foto
 * deben aceptar editor_contenido y super_admin, y rechazar admin_club, jugador y anónimo.
 * Sin datos reales: getAuthenticatedUser y el rol se inyectan como fixtures.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import {mountAdminQaPanelRoutes} from './adminQaPanel.js';

const USERS = {editor: {id: '11111111-1111-4111-8111-111111111111', email: 'editor@fixture.invalid'},
  super: {id: '22222222-2222-4222-8222-222222222222', email: 'super@fixture.invalid'},
  club: {id: '33333333-3333-4333-8333-333333333333', email: 'club@fixture.invalid'},
  jugador: {id: '44444444-4444-4444-8444-444444444444', email: 'jugador@fixture.invalid'}};
const ROLES = {editor: {rol: 'editor_contenido'}, super: {rol: 'super_admin'},
  club: {rol: 'admin_club', sede_id: 9}, jugador: {rol: 'jugador'}};

function fakeDb(rows = {}) {
  const chain = {
    select: () => chain, eq: () => chain, order: () => chain, limit: () => chain,
    maybeSingle: async () => ({data: null, error: null}), single: async () => ({data: rows.single || {ok: true}, error: null}),
    upsert: () => chain, update: () => chain, insert: () => chain,
  };
  return {from: () => chain, storage: {from: () => ({upload: async () => ({error: null}), getPublicUrl: () => ({data: {publicUrl: 'https://cdn.invalid/x.png'}}), remove: async () => ({})})}};
}

async function server() {
  const app = express();
  app.use(express.json());
  mountAdminQaPanelRoutes(app, {
    supabaseAdmin: fakeDb(),
    getAuthenticatedUser: async (req) => {
      const who = String(req.headers['x-fixture-user'] || '');
      if (!USERS[who]) return {user: null, status: 401, error: 'No autorizado'};
      return {user: USERS[who], status: 200};
    },
    fetchUserRoleRowForAuthUser: async (user) => {
      const key = Object.keys(USERS).find((k) => USERS[k].id === user.id);
      return ROLES[key] || {rol: 'jugador'};
    },
    legacySuperAdminEmails: [],
  });
  const s = http.createServer(app);
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  return {s, base: `http://127.0.0.1:${s.address().port}`};
}

const patchConfig = (base, who) => fetch(`${base}/api/hub-deporte-config`, {
  method: 'PATCH', headers: {'Content-Type': 'application/json', 'x-fixture-user': who},
  body: JSON.stringify({deporte: 'padbol', card_key: 'hero', titulo: 'T', subtitulo: 'S'}),
});
const postFoto = (base, who) => fetch(`${base}/api/hub-deporte-config/foto`, {
  method: 'POST', headers: {'x-fixture-user': who},
});

test('editor_contenido y super_admin pasan; admin_club, jugador y anónimo reciben 403/401', async () => {
  const {s, base} = await server();
  try {
    assert.notEqual((await patchConfig(base, 'editor')).status, 403, 'editor debe pasar el gate');
    assert.notEqual((await patchConfig(base, 'super')).status, 403, 'super_admin debe pasar');
    assert.equal((await patchConfig(base, 'club')).status, 403, 'admin_club no edita contenido global');
    assert.equal((await patchConfig(base, 'jugador')).status, 403, 'jugador no edita contenido global');
    assert.equal((await patchConfig(base, 'nadie')).status, 401, 'sin token es 401');

    assert.notEqual((await postFoto(base, 'editor')).status, 403, 'editor debe poder subir foto');
    assert.equal((await postFoto(base, 'club')).status, 403, 'admin_club no puede subir foto global');
    assert.equal((await postFoto(base, 'jugador')).status, 403, 'jugador no puede subir foto global');
  } finally { s.close(); }
});
