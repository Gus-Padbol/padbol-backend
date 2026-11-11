import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import { PGlite } from '@electric-sql/pglite';
import { mountAdminJugadoresRoutes } from './adminJugadores.js';

const U1 = '11111111-1111-4111-8111-111111111111';
const TOKENS = {
  'token-super': 'super@test.com',
  'token-club': 'club@test.com',
  'token-player': 'player@test.com',
};
const ROLES = {
  'super@test.com': { role: 'super_admin', sede_id: null },
  'club@test.com': { role: 'admin_club', sede_id: 7 },
  'player@test.com': { role: 'jugador', sede_id: null },
};

let db;
let server;
let baseUrl;

before(async () => {
  db = new PGlite();
  await db.query(`CREATE TABLE public.jugadores_perfil (
    id bigserial PRIMARY KEY,
    user_id uuid,
    email text NOT NULL,
    nombre text,
    apellido text,
    nombre_saludo text,
    username text,
    apodo text,
    alias text,
    telefono text,
    sede_id integer,
    created_at timestamptz DEFAULT now()
  );`);
  await db.query(`
    INSERT INTO public.jugadores_perfil (user_id, email, nombre, apellido, username, telefono, created_at)
    SELECT
      CASE WHEN g <= 100 THEN '${U1}'::uuid
           ELSE ('00000000-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid END,
      'demo' || g || '@example.test',
      CASE WHEN g = 1 THEN 'Ana 50% Club' ELSE 'Jugador ' || lpad(g::text, 4, '0') END,
      CASE WHEN g = 1 THEN 'López' ELSE 'Demo' END,
      'demo' || g,
      CASE WHEN g = 1 THEN '+54 11 5555-9999' ELSE NULL END,
      timestamptz '2026-01-01 00:00:00+00' + (g || ' minutes')::interval
    FROM generate_series(1, 1200) g;
  `);
  await db.query(`
    INSERT INTO public.jugadores_perfil (user_id, email, nombre, apellido, username)
    VALUES (NULL, 'sinuuid@example.test', 'Sin', 'UUID', 'sinuuid');
  `);

  const pool = { query: (sql, params) => db.query(sql, params) };
  const app = express();
  mountAdminJugadoresRoutes(app, {
    supabaseAdmin: {},
    pgPool: pool,
    getAuthenticatedUser: async (req) => {
      const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      const email = TOKENS[token];
      return email
        ? { user: { id: email, email }, status: 200 }
        : { user: null, status: 401, error: 'No autorizado' };
    },
    fetchUserRoleRowForAuthUser: async (user) => ROLES[user.email] || { role: 'jugador', sede_id: null },
    legacySuperAdminEmails: [],
  });

  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await db.close();
});

async function get(path, token = 'token-super') {
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  const res = await fetch(`${baseUrl}${path}`, { headers });
  return { status: res.status, body: await res.json() };
}

test('HTTP: sin sesión 401 y rol jugador 403', async () => {
  assert.equal((await get('/api/admin/jugadores', null)).status, 401);
  assert.equal((await get('/api/admin/jugadores', 'token-player')).status, 403);
});

test('HTTP: super_admin sin sede recibe todos (1200 filas, sin cap DataAPI)', async () => {
  const res = await get('/api/admin/jugadores?page=1&limit=20');
  assert.equal(res.status, 200);
  assert.equal(res.body.scope, 'global');
  assert.equal(res.body.sede_id, null);
  assert.equal(res.body.total, 1102);
  assert.equal(res.body.total_pages, 56);
  assert.equal(res.body.items.length, 20);
  assert.equal(res.body.items[0].display_name, 'Ana 50% Club López');
  assert.equal(res.body.items[0].vinculacion, 'registrado');
  assert.ok(res.body.items[0].row_key);
  for (const item of res.body.items) {
    assert.equal('email' in item, false);
    assert.equal('telefono' in item, false);
    assert.equal('foto_url' in item, false);
    assert.equal('nivel' in item, false);
  }
});

test('HTTP: página final y página fuera de rango conservan total y conteo', async () => {
  const last = await get('/api/admin/jugadores?page=56&limit=20');
  assert.equal(last.body.items.length, 2);
  assert.equal(last.body.total, 1102);

  const beyond = await get('/api/admin/jugadores?page=999&limit=20');
  assert.equal(beyond.status, 200);
  assert.deepEqual(beyond.body.items, []);
  assert.equal(beyond.body.total, 1102);
  assert.equal(beyond.body.total_pages, 56);
});

test('HTTP: búsqueda escapada por nombre y teléfono con formato', async () => {
  const byWildcard = await get('/api/admin/jugadores?q=50%25');
  assert.equal(byWildcard.body.total, 1);
  assert.equal(byWildcard.body.items[0].display_name, 'Ana 50% Club López');

  const byPhone = await get('/api/admin/jugadores?q=1155559999');
  assert.equal(byPhone.body.total, 1);

  const oneChar = await get('/api/admin/jugadores?q=a');
  assert.equal(oneChar.body.total, 0);
  assert.deepEqual(oneChar.body.items, []);

  const empty = await get('/api/admin/jugadores?q=');
  assert.equal(empty.body.total, 1102);
});

test('HTTP: sede_id malformada no cae en Todos; club no consulta otra sede', async () => {
  for (const bad of ['1abc', 'abc', '0', '-1', '1.5']) {
    const res = await get(`/api/admin/jugadores?sede_id=${encodeURIComponent(bad)}`);
    assert.equal(res.status, 400, bad);
    assert.equal(res.body.code, 'SEDE_INVALIDA');
  }

  const club = await get('/api/admin/jugadores?sede_id=9', 'token-club');
  assert.equal(club.status, 403);

  const noSessionBadSede = await get('/api/admin/jugadores?sede_id=1abc', null);
  assert.equal(noSessionBadSede.status, 401);
});

test('HTTP: las lecturas no escriben en la tabla', async () => {
  const { rows } = await db.query('SELECT count(*)::int AS n FROM public.jugadores_perfil');
  assert.equal(rows[0].n, 1201);
});
