import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import {
  buildAdminJugadoresGlobalQuery,
  buildGlobalDisplayName,
  escapeSqlIlike,
  listAdminJugadoresGlobal,
  mapAdminJugadorGlobalRow,
} from './adminJugadoresService.js';

const U1 = '11111111-1111-4111-8111-111111111111';
const U2 = '22222222-2222-4222-8222-222222222222';
const U3 = '33333333-3333-4333-8333-333333333333';

const SCHEMA = `CREATE TABLE public.jugadores_perfil (
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
  created_at timestamptz DEFAULT now()
);`;

async function createGlobalPool() {
  const db = new PGlite();
  await db.query(SCHEMA);
  const pool = {
    queries: 0,
    async query(sql, params) {
      this.queries += 1;
      return db.query(sql, params);
    },
  };
  return {
    db,
    pool,
    async seed(rows) {
      for (const row of rows) {
        await db.query(
          `INSERT INTO public.jugadores_perfil
             (user_id, email, nombre, apellido, nombre_saludo, username, apodo, alias, telefono, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [
            row.user_id ?? null,
            row.email,
            row.nombre ?? null,
            row.apellido ?? null,
            row.nombre_saludo ?? null,
            row.username ?? null,
            row.apodo ?? null,
            row.alias ?? null,
            row.telefono ?? null,
            row.created_at ?? '2026-01-01T00:00:00Z',
          ],
        );
      }
    },
    async rowCount() {
      const { rows } = await db.query('SELECT count(*)::int AS n FROM public.jugadores_perfil');
      return rows[0].n;
    },
    close() { return db.close(); },
  };
}

function rowsOf(result) {
  return result.items.map((item) => item.user_id);
}

test('global: deduplica UUID repetido antes de contar y paginar (misma página)', async (t) => {
  const env = await createGlobalPool();
  t.after(() => env.close());
  await env.seed([
    { user_id: U1, email: 'a1@test.com', nombre: 'Ana', apellido: 'Lopez', username: 'ana' },
    { user_id: U1, email: 'a2@test.com', nombre: 'Ana Duplicada', apellido: 'Lopez', username: 'anadup' },
    { user_id: U2, email: 'b@test.com', nombre: 'Beto', apellido: 'Diaz', username: 'beto' },
  ]);

  const result = await listAdminJugadoresGlobal(env.pool, { limit: 10 });
  assert.equal(result.total, 2);
  assert.equal(result.total_pages, 1);
  assert.deepEqual(rowsOf(result), [U1, U2]);
  assert.equal(result.items[0].display_name, 'Ana Lopez');
  assert.equal('email' in result.items[0], false);
  assert.equal('telefono' in result.items[0], false);
  assert.equal('foto_url' in result.items[0], false);
  assert.equal('nivel' in result.items[0], false);
});

test('global: un UUID repetido no se repite al cruzar páginas y el total es único', async (t) => {
  const env = await createGlobalPool();
  t.after(() => env.close());
  await env.seed([
    { user_id: U1, email: 'a1@test.com', nombre: 'Ana', apellido: 'Lopez' },
    { user_id: U2, email: 'b@test.com', nombre: 'Beto', apellido: 'Diaz' },
    { user_id: U1, email: 'a2@test.com', nombre: 'Ana Duplicada', apellido: 'Lopez' },
    { user_id: U3, email: 'c@test.com', nombre: 'Caro', apellido: 'Sosa' },
  ]);

  const page1 = await listAdminJugadoresGlobal(env.pool, { page: 1, limit: 2 });
  const page2 = await listAdminJugadoresGlobal(env.pool, { page: 2, limit: 2 });
  assert.equal(page1.total, 3);
  assert.equal(page2.total, 3);
  assert.deepEqual(rowsOf(page1), [U1, U2]);
  assert.deepEqual(rowsOf(page2), [U3]);
  assert.equal(page1.items[0].display_name, 'Ana Lopez');
});

test('global: identidad cae a email y nunca fusiona personas por nombre', async (t) => {
  const env = await createGlobalPool();
  t.after(() => env.close());
  await env.seed([
    { user_id: U1, email: 'ana1@test.com', nombre: 'Ana', apellido: 'Lopez' },
    { user_id: U2, email: 'ana2@test.com', nombre: 'Ana', apellido: 'Lopez' },
    { user_id: null, email: 'ana3@test.com', nombre: 'Ana', apellido: 'Lopez' },
    { user_id: null, email: 'ana4@test.com', nombre: 'Ana', apellido: 'Lopez' },
  ]);

  const result = await listAdminJugadoresGlobal(env.pool, { limit: 10 });
  assert.equal(result.total, 4);
  assert.deepEqual(rowsOf(result), [U1, U2, null, null]);
});

test('global: 1200 filas no se truncan (cap DataAPI) y el conteo es el único', async (t) => {
  const env = await createGlobalPool();
  t.after(() => env.close());
  await env.db.query(`
    INSERT INTO public.jugadores_perfil (user_id, email, nombre, apellido, username, created_at)
    SELECT
      CASE WHEN g <= 100 THEN '${U1}'::uuid
           ELSE ('00000000-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid END,
      'demo' || g || '@example.test',
      'Jugador ' || lpad(g::text, 4, '0'),
      'Demo',
      'demo' || g,
      timestamptz '2026-01-01 00:00:00+00' + (g || ' minutes')::interval
    FROM generate_series(1, 1200) g;
  `);

  const page1 = await listAdminJugadoresGlobal(env.pool, { page: 1, limit: 20 });
  assert.equal(page1.total, 1101);
  assert.equal(page1.total_pages, 56);
  assert.equal(page1.items.length, 20);
  assert.equal(page1.items[0].display_name, 'Jugador 0001 Demo');

  const page30 = await listAdminJugadoresGlobal(env.pool, { page: 30, limit: 20 });
  assert.equal(page30.items.length, 20);
  assert.equal(page30.total, 1101);

  const page56 = await listAdminJugadoresGlobal(env.pool, { page: 56, limit: 20 });
  assert.equal(page56.items.length, 1);

  const page999 = await listAdminJugadoresGlobal(env.pool, { page: 999, limit: 20 });
  assert.equal(page999.items.length, 0);
  assert.equal(page999.total, 1101);
  assert.equal(page999.total_pages, 56);
  assert.equal(await env.rowCount(), 1200);
});

test('global: búsqueda escapa comodines, acentos y teléfono con formato', async (t) => {
  const env = await createGlobalPool();
  t.after(() => env.close());
  await env.seed([
    { user_id: U1, email: 'pct@test.com', nombre: 'Ana 50% Club', apellido: 'López', telefono: '+54 11 5555-9999' },
    { user_id: U2, email: 'under@test.com', nombre: 'Beto_Under', apellido: 'Diaz' },
    { user_id: U3, email: 'quote@test.com', nombre: "O'Brien", apellido: 'Ñandú' },
  ]);

  assert.equal((await listAdminJugadoresGlobal(env.pool, { q: '50%' })).total, 1);
  assert.equal((await listAdminJugadoresGlobal(env.pool, { q: 'beto_' })).total, 1);
  assert.equal((await listAdminJugadoresGlobal(env.pool, { q: "o'brien" })).total, 1);
  assert.equal((await listAdminJugadoresGlobal(env.pool, { q: 'ñandú' })).total, 1);
  assert.equal((await listAdminJugadoresGlobal(env.pool, { q: '1155559999' })).total, 1);
  assert.equal((await listAdminJugadoresGlobal(env.pool, { q: 'zzz' })).total, 0);
});

test('global: orden por nombre y por fecha de registro, siempre determinista', async (t) => {
  const env = await createGlobalPool();
  t.after(() => env.close());
  await env.seed([
    { user_id: U1, email: 'a@test.com', nombre: 'Ana', apellido: 'Lopez', created_at: '2026-01-01T00:00:00Z' },
    { user_id: U2, email: 'c@test.com', nombre: 'Caro', apellido: 'Diaz', created_at: '2026-03-01T00:00:00Z' },
    { user_id: U3, email: 'b@test.com', nombre: 'Beto', apellido: 'Sosa', created_at: '2026-02-01T00:00:00Z' },
  ]);

  assert.deepEqual(rowsOf(await listAdminJugadoresGlobal(env.pool, { orden: 'name_asc' })), [U1, U3, U2]);
  assert.deepEqual(rowsOf(await listAdminJugadoresGlobal(env.pool, { orden: 'name_desc' })), [U2, U3, U1]);
  assert.deepEqual(rowsOf(await listAdminJugadoresGlobal(env.pool, { orden: 'activity_desc' })), [U2, U3, U1]);
  assert.deepEqual(rowsOf(await listAdminJugadoresGlobal(env.pool, { orden: 'activity_asc' })), [U1, U3, U2]);
});

test('global: q vacía lista todos; q de 1 carácter no consulta y devuelve vacío', async (t) => {
  const env = await createGlobalPool();
  t.after(() => env.close());
  await env.seed([{ user_id: U1, email: 'a@test.com', nombre: 'Ana', apellido: 'Lopez' }]);

  const all = await listAdminJugadoresGlobal(env.pool, { q: '   ' });
  assert.equal(all.total, 1);
  const before = env.pool.queries;

  const short = await listAdminJugadoresGlobal(env.pool, { q: 'a' });
  assert.equal(short.total, 0);
  assert.deepEqual(short.items, []);
  assert.equal(env.pool.queries, before);
});

test('global: filtros de relación sin sede se rechazan antes de consultar', async (t) => {
  const env = await createGlobalPool();
  t.after(() => env.close());
  const before = env.pool.queries;
  await assert.rejects(
    () => listAdminJugadoresGlobal(env.pool, { vinculado: true }),
    (err) => err.status === 400 && err.code === 'VINCULADO_REQUIRES_SEDE',
  );
  await assert.rejects(
    () => listAdminJugadoresGlobal(env.pool, { vinculacion: 'con_historial' }),
    (err) => err.status === 400 && err.code === 'VINCULADO_REQUIRES_SEDE',
  );
  assert.equal(env.pool.queries, before);
});

test('global: sin pgPool responde 503 y con error de pool propaga el fallo', async () => {
  await assert.rejects(
    () => listAdminJugadoresGlobal(null, {}),
    (err) => err.status === 503 && err.code === 'JUGADORES_DB_UNAVAILABLE',
  );
  await assert.rejects(
    () => listAdminJugadoresGlobal({ query: async () => { throw new Error('pg down'); } }, {}),
    (err) => err.message === 'pg down',
  );
});

test('global: SQL parametrizado, orden allowlisted y límite acotado', () => {
  assert.equal(escapeSqlIlike('a%b_c\\d'), 'a\\%b\\_c\\\\d');

  const query = buildAdminJugadoresGlobalQuery({
    q: 'ana 50%',
    orden: 'name_desc',
    limit: 9999,
    offset: 40,
  });
  assert.deepEqual(query.params, ['%ana 50\\%%', 50, 40]);
  assert.match(query.sql, /ESCAPE '\\'/);
  assert.match(query.sql, /DISTINCT ON \(identity_key\)/);
  assert.match(query.sql, /'user:' \|\| NULLIF\(user_id::text, ''\)/);
  assert.match(query.sql, /'email:' \|\| NULLIF\(lower\(btrim\(email\)\), ''\)/);
  assert.match(query.sql, /'id:' \|\| id::text/);
  assert.match(query.sql, /LIMIT \$2 OFFSET \$3/);
  assert.match(query.sql, /COALESCE\(nombre, ''\) DESC/);

  const unsafeOrder = buildAdminJugadoresGlobalQuery({ orden: 'id; DROP TABLE x', limit: 20 });
  assert.match(unsafeOrder.sql, /COALESCE\(nombre, ''\) ASC/);
  assert.doesNotMatch(unsafeOrder.sql, /DROP/i);
});

test('global: DTO mínimo sin campos privados y sin fallback a email', () => {
  const row = mapAdminJugadorGlobalRow({
    id: 1,
    user_id: U1,
    email: 'privado@test.com',
    nombre: null,
    apellido: null,
    username: '@alias',
    telefono: '111',
    created_at: '2026-01-01T00:00:00Z',
  });
  assert.deepEqual(Object.keys(row).sort(), [
    'apellido', 'created_at', 'display_name', 'last_activity_at',
    'nombre', 'row_key', 'user_id', 'username', 'vinculacion',
  ]);
  assert.equal(row.row_key, 'user:' + U1);
  assert.equal(row.display_name, 'alias');
  assert.equal(row.username, 'alias');
  assert.equal(row.vinculacion, 'registrado');
  assert.equal(buildGlobalDisplayName({ email: 'solo@email.com' }), 'Jugador');
});
