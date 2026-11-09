import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { mountAdminJugadoresRoutes } from './adminJugadores.js';

const U1 = 'aaaaaaaa-bbbb-cccc-dddd-111111111111';
const U2 = 'aaaaaaaa-bbbb-cccc-dddd-222222222222';
const U3 = 'aaaaaaaa-bbbb-cccc-dddd-333333333333';
const U4 = 'aaaaaaaa-bbbb-cccc-dddd-444444444444';
const U5 = 'aaaaaaaa-bbbb-cccc-dddd-555555555555';

function unescapeIlike(value) {
  return String(value).replace(/\\(.)/g, '$1');
}

function matchesOrFilter(row, filter) {
  if (!filter) return true;
  const terms = [...String(filter).matchAll(/([a-z_]+)\.ilike\."%([^"]*)%"/g)]
    .map((m) => [m[1], unescapeIlike(m[2]).toLowerCase()]);
  return terms.some(([field, needle]) => (
    String(row[field] || '').toLowerCase().includes(needle)
  ));
}

function compareNullable(a, b) {
  const av = a == null || a === '' ? null : String(a);
  const bv = b == null || b === '' ? null : String(b);
  if (av == null && bv == null) return 0;
  if (av == null) return 1;
  if (bv == null) return -1;
  return av.localeCompare(bv, 'es', { sensitivity: 'base' });
}

function compareOrdered(a, b, orders) {
  for (const [column, options] of orders) {
    const direction = options?.ascending === false ? -1 : 1;
    const nullsFirst = Boolean(options?.nullsFirst);
    const av = a[column] == null || a[column] === '' ? null : a[column];
    const bv = b[column] == null || b[column] === '' ? null : b[column];
    if (av == null && bv == null) continue;
    if (av == null) return nullsFirst ? -1 : 1;
    if (bv == null) return nullsFirst ? 1 : -1;
    const cmp = (typeof av === 'number' || typeof bv === 'number')
      ? Number(av) - Number(bv)
      : compareNullable(av, bv);
    if (cmp !== 0) return cmp * direction;
  }
  return 0;
}

/**
 * Minimal PostgREST-shaped fake for the players roster:
 * - jugadores_perfil: global count/range/or + in(user_id|email)
 * - reservas: sede history
 * - sede_jugadores: active formal links
 * - sedes: name lookup
 */
function createDb({
  perfiles = [],
  reservas = [],
  links = [],
  sedes = [{ id: 7, nombre: 'Club Siete' }, { id: 9, nombre: 'Club Nueve' }],
  failTable = null,
} = {}) {
  const used = [];

  function rowsFor(table) {
    if (table === 'jugadores_perfil') return perfiles;
    if (table === 'reservas') return reservas;
    if (table === 'sede_jugadores') return links;
    if (table === 'sedes') return sedes;
    return [];
  }

  const db = {
    from(table) {
      used.push(table);
      const state = {
        table,
        filters: {},
        inFilter: null,
        orFilter: null,
        range: null,
        limit: null,
        orders: [],
      };

      function resolveRows() {
        if (failTable === table) {
          return { data: null, error: { message: `boom ${table}`, code: 'XX000' }, count: null };
        }
        let rows = [...rowsFor(table)];
        for (const [key, value] of Object.entries(state.filters)) {
          rows = rows.filter((row) => String(row[key]) === String(value));
        }
        if (state.inFilter) {
          const allowed = new Set(state.inFilter.values.map((v) => String(v)));
          rows = rows.filter((row) => allowed.has(String(row[state.inFilter.key] ?? '')));
        }
        if (table === 'jugadores_perfil') {
          rows = rows.filter((row) => matchesOrFilter(row, state.orFilter));
          if (state.orders.length) {
            rows.sort((a, b) => compareOrdered(a, b, state.orders));
          } else {
            rows.sort((a, b) => (
              compareNullable(a.nombre, b.nombre)
              || compareNullable(a.apellido, b.apellido)
              || Number(a.id || 0) - Number(b.id || 0)
            ));
          }
        }
        if (table === 'reservas') {
          rows.sort((a, b) => String(b.fecha || '').localeCompare(String(a.fecha || '')));
        }
        const total = rows.length;
        if (state.range) rows = rows.slice(state.range[0], state.range[1] + 1);
        if (state.limit != null) rows = rows.slice(0, state.limit);
        return { data: rows, error: null, count: total };
      }

      const api = {
        select() { return api; },
        eq(key, value) { state.filters[key] = value; return api; },
        in(key, values) { state.inFilter = { key, values }; return api; },
        or(filter) { state.orFilter = filter; return api; },
        order(column, options) { state.orders.push([column, options]); return api; },
        limit(value) { state.limit = value; return api; },
        range(from, to) { state.range = [from, to]; return api; },
        maybeSingle() {
          const result = resolveRows();
          return Promise.resolve({
            data: result.data ? (result.data[0] || null) : null,
            error: result.error,
          });
        },
        then(resolve, reject) {
          return Promise.resolve(resolveRows()).then(resolve, reject);
        },
      };
      return api;
    },
    _used: used,
  };
  return db;
}


async function createGlobalPool(profiles = []) {
  const db = new PGlite();
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
  for (const row of profiles) {
    await db.query(
      `INSERT INTO public.jugadores_perfil
         (user_id, email, nombre, apellido, username, telefono, sede_id, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        row.user_id ?? null,
        row.email,
        row.nombre ?? null,
        row.apellido ?? null,
        row.username ?? null,
        row.telefono ?? null,
        row.sede_id ?? null,
        row.created_at ?? '2026-01-01T00:00:00Z',
      ],
    );
  }
  const pool = {
    queries: 0,
    async query(sql, params) {
      this.queries += 1;
      return db.query(sql, params);
    },
  };
  return { db, pool, close: () => db.close() };
}

function mount({
  db,
  pgPool = null,
  role = { role: 'super_admin', sede_id: null },
  user = { id: 'admin-1', email: 'admin@test.com' },
}) {
  const routes = {};
  const app = {
    get(path, handler) { routes[`get ${path}`] = handler; },
    post(path, handler) { routes[`post ${path}`] = handler; },
  };
  mountAdminJugadoresRoutes(app, {
    supabaseAdmin: db,
    pgPool,
    getAuthenticatedUser: async () => (
      user
        ? { user, status: 200 }
        : { user: null, status: 401, error: 'No autorizado' }
    ),
    fetchUserRoleRowForAuthUser: async () => role,
    legacySuperAdminEmails: [],
  });
  return {
    list: routes['get /api/admin/jugadores'],
    search: routes['get /api/admin/jugadores/buscar'],
  };
}

async function invoke(handler, query = {}) {
  const res = {
    code: 200,
    status(code) { this.code = code; return this; },
    json(body) { this.body = body; return this; },
  };
  await handler({ query, params: {}, body: {} }, res);
  return res;
}

function ids(body) {
  return body.items.map((item) => item.user_id);
}

test('listado: sin sesión responde 401 y no toca la base', async () => {
  const db = createDb();
  const res = await invoke(mount({ db, user: null }).list);
  assert.equal(res.code, 401);
  assert.equal(db._used.length, 0);
});

test('listado: rol no administrativo responde 403 y no toca la base', async () => {
  const db = createDb();
  const res = await invoke(mount({ db, role: { role: 'jugador', sede_id: null } }).list);
  assert.equal(res.code, 403);
  assert.equal(db._used.length, 0);
});

test('listado: admin_club sin sede asignada responde 403', async () => {
  const db = createDb();
  const res = await invoke(mount({ db, role: { role: 'admin_club', sede_id: null } }).list);
  assert.equal(res.code, 403);
});

test('super_admin sin sede: lista todos los registrados, incluidos sin sede', async (t) => {
  const db = createDb();
  const env = await createGlobalPool([
    { user_id: U1, nombre: 'Ana', apellido: 'Lopez', email: 'ana@test.com', sede_id: null },
    { user_id: U2, nombre: 'Beto', apellido: 'Diaz', email: 'beto@test.com', sede_id: 7 },
  ]);
  t.after(() => env.close());

  const res = await invoke(mount({ db, pgPool: env.pool }).list);
  assert.equal(res.code, 200);
  assert.equal(res.body.scope, 'global');
  assert.equal(res.body.sede_id, null);
  assert.equal(res.body.total, 2);
  assert.deepEqual(ids(res.body).sort(), [U1, U2].sort());
  assert.equal(env.pool.queries, 1);
  assert.equal(db._used.length, 0);
  assert.equal(res.body.items[0].vinculacion, 'registrado');
});

test('super_admin con sede: conserva el roster historial ∪ vínculos de esa sede', async () => {
  const db = createDb({
    perfiles: [
      { id: 1, user_id: U1, nombre: 'Ana', apellido: 'Lopez', email: 'ana@test.com' },
      { id: 2, user_id: U2, nombre: 'Beto', apellido: 'Diaz', email: 'beto@test.com' },
      { id: 3, user_id: U3, nombre: 'Caro', apellido: 'Sosa', email: 'caro@test.com' },
    ],
    reservas: [
      { user_id: U1, email: 'ana@test.com', sede_id: 7, fecha: '2026-01-10', created_at: '2026-01-10T10:00:00Z' },
    ],
    links: [
      { id: 10, sede_id: 7, user_id: U2, estado: 'activo', origen: 'manual', created_at: '2026-02-01T00:00:00Z' },
    ],
  });
  const res = await invoke(mount({ db }).list, { sede_id: '7' });
  assert.equal(res.code, 200);
  assert.equal(res.body.scope, 'sede');
  assert.equal(res.body.sede_id, 7);
  assert.equal(res.body.total, 2);
  assert.deepEqual(ids(res.body).sort(), [U1, U2].sort());
  assert.equal(db._used.includes('reservas'), true);
  assert.equal(db._used.includes('sede_jugadores'), true);
});

test('super_admin con sede sin roster devuelve vacío sin filtrar otras sedes', async () => {
  const db = createDb({
    perfiles: [{ id: 1, user_id: U1, nombre: 'Ana', email: 'ana@test.com' }],
    reservas: [{ user_id: U1, email: 'ana@test.com', sede_id: 9, fecha: '2026-01-10' }],
  });
  const res = await invoke(mount({ db }).list, { sede_id: '7' });
  assert.equal(res.code, 200);
  assert.equal(res.body.total, 0);
  assert.deepEqual(res.body.items, []);
});

test('admin_club: no puede pedir otra sede (403)', async () => {
  const db = createDb();
  const res = await invoke(
    mount({ db, role: { role: 'admin_club', sede_id: 7 } }).list,
    { sede_id: '9' },
  );
  assert.equal(res.code, 403);
  assert.equal(db._used.length, 0);
});

test('admin_club: sin sede_id en query queda forzado a su propia sede', async () => {
  const db = createDb({
    perfiles: [
      { id: 1, user_id: U1, nombre: 'Ana', apellido: 'Lopez', email: 'ana@test.com' },
      { id: 2, user_id: U2, nombre: 'Beto', apellido: 'Diaz', email: 'beto@test.com' },
    ],
    reservas: [
      { user_id: U1, email: 'ana@test.com', sede_id: 7, fecha: '2026-01-10' },
      { user_id: U2, email: 'beto@test.com', sede_id: 9, fecha: '2026-01-11' },
    ],
  });
  const res = await invoke(mount({ db, role: { role: 'admin_club', sede_id: 7 } }).list);
  assert.equal(res.code, 200);
  assert.equal(res.body.scope, 'sede');
  assert.equal(res.body.sede_id, 7);
  assert.deepEqual(ids(res.body), [U1]);
  assert.equal(db._used.includes('jugadores_perfil'), true);
});

test('super_admin todos: paginación y conteo consistentes entre páginas', async (t) => {
  const env = await createGlobalPool([
    { user_id: U1, email: 'ana@test.com', nombre: 'Ana', apellido: 'Lopez' },
    { user_id: U2, email: 'beto@test.com', nombre: 'Beto', apellido: 'Diaz' },
    { user_id: U3, email: 'caro@test.com', nombre: 'Caro', apellido: 'Sosa' },
    { user_id: U4, email: 'dani@test.com', nombre: 'Dani', apellido: 'Paz' },
    { user_id: U5, email: 'eva@test.com', nombre: 'Eva', apellido: 'Rios' },
  ]);
  t.after(() => env.close());

  const first = await invoke(mount({ db: createDb(), pgPool: env.pool }).list, { page: '1', limit: '2' });
  const second = await invoke(mount({ db: createDb(), pgPool: env.pool }).list, { page: '2', limit: '2' });
  assert.equal(first.body.total, 5);
  assert.equal(first.body.total_pages, 3);
  assert.deepEqual(ids(first.body), [U1, U2]);
  assert.deepEqual(ids(second.body), [U3, U4]);
  assert.deepEqual(
    ids(first.body).filter((id) => ids(second.body).includes(id)),
    [],
  );
});

test('super_admin todos: búsqueda, q vacía y q de 1 carácter', async (t) => {
  const env = await createGlobalPool([
    { user_id: U1, email: 'ana@test.com', nombre: 'Ana', apellido: 'Lopez', username: 'analopez' },
    { user_id: U2, email: 'beto@test.com', nombre: 'Beto', apellido: 'Diaz', username: 'betod' },
  ]);
  t.after(() => env.close());

  const all = await invoke(mount({ db: createDb(), pgPool: env.pool }).list, { q: '' });
  assert.equal(all.body.total, 2);

  const beforeShort = env.pool.queries;
  const oneChar = await invoke(mount({ db: createDb(), pgPool: env.pool }).list, { q: 'b' });
  assert.equal(oneChar.code, 200);
  assert.equal(oneChar.body.total, 0);
  assert.deepEqual(oneChar.body.items, []);
  assert.equal(env.pool.queries, beforeShort);

  const match = await invoke(mount({ db: createDb(), pgPool: env.pool }).list, { q: '@beto' });
  assert.equal(match.body.total, 1);
  assert.deepEqual(ids(match.body), [U2]);
});

test('super_admin todos: filtro de vinculación exige sede (400)', async () => {
  const pool = { queries: 0, async query() { this.queries += 1; return { rows: [] }; } };
  const res = await invoke(mount({ db: createDb(), pgPool: pool }).list, { vinculado: 'true' });
  assert.equal(res.code, 400);
  assert.equal(res.body.code, 'VINCULADO_REQUIRES_SEDE');
  assert.equal(pool.queries, 0);
});

test('listado: error de base responde 500 y no un listado vacío', async () => {
  const pool = {
    async query() { throw new Error('pg caido'); },
  };
  const res = await invoke(mount({ db: createDb(), pgPool: pool }).list);
  assert.equal(res.code, 500);
  assert.equal(res.body.items, undefined);
  assert.ok(res.body.error);
});

test('búsqueda global: 401 sin sesión y 403 sin rol admin', async () => {
  const anon = await invoke(mount({ db: createDb(), user: null }).search, { q: 'ana' });
  assert.equal(anon.code, 401);
  const forbidden = await invoke(
    mount({ db: createDb(), role: { role: 'jugador', sede_id: null } }).search,
    { q: 'ana' },
  );
  assert.equal(forbidden.code, 403);
});

test('búsqueda global: q corta no consulta y devuelve items vacíos', async () => {
  const db = createDb();
  const res = await invoke(mount({ db }).search, { q: 'a' });
  assert.equal(res.code, 200);
  assert.deepEqual(res.body.items, []);
  assert.equal(db._used.length, 0);
});

test('sede_id presente pero inválida nunca se convierte en Todos (400)', async () => {
  for (const role of [
    { role: 'super_admin', sede_id: null },
    { role: 'admin_club', sede_id: 7 },
  ]) {
    const db = createDb({
      perfiles: [{ id: 1, user_id: U1, nombre: 'Ana', email: 'ana@test.com' }],
    });
    const res = await invoke(mount({ db, role }).list, { sede_id: 'abc' });
    assert.equal(res.code, 400);
    assert.equal(res.body.code, 'SEDE_INVALIDA');
    assert.equal(db._used.length, 0);
  }
});

test('sede_id=0 presente tampoco se convierte en Todos (400)', async () => {
  const db = createDb();
  const res = await invoke(mount({ db }).list, { sede_id: '0' });
  assert.equal(res.code, 400);
  assert.equal(res.body.code, 'SEDE_INVALIDA');
  assert.equal(db._used.length, 0);
});

test('sede: filtro de relación se aplica antes de paginar y el total acompaña', async () => {
  const perfiles = [
    { id: 1, user_id: U1, nombre: 'Ana', apellido: 'Lopez', email: 'ana@test.com' },
    { id: 2, user_id: U2, nombre: 'Beto', apellido: 'Diaz', email: 'beto@test.com' },
    { id: 3, user_id: U3, nombre: 'Caro', apellido: 'Sosa', email: 'caro@test.com' },
  ];
  const reservas = [
    { user_id: U1, email: 'ana@test.com', sede_id: 7, fecha: '2026-01-10' },
  ];
  const links = [
    { id: 10, sede_id: 7, user_id: U2, estado: 'activo', origen: 'manual', created_at: '2026-02-01T00:00:00Z' },
    { id: 11, sede_id: 7, user_id: U3, estado: 'activo', origen: 'manual', created_at: '2026-02-02T00:00:00Z' },
  ];

  const historial = await invoke(
    mount({ db: createDb({ perfiles, reservas, links }) }).list,
    { sede_id: '7', vinculacion: 'con_historial' },
  );
  assert.equal(historial.code, 200);
  assert.equal(historial.body.total, 1);
  assert.deepEqual(ids(historial.body), [U1]);

  const vinculados = await invoke(
    mount({ db: createDb({ perfiles, reservas, links }) }).list,
    { sede_id: '7', vinculacion: 'vinculado' },
  );
  assert.equal(vinculados.body.total, 2);
  assert.deepEqual(ids(vinculados.body), [U2, U3]);
});

test('global: orden se aplica antes de paginar (name_desc)', async (t) => {
  const env = await createGlobalPool([
    { user_id: U1, email: 'ana@test.com', nombre: 'Ana', apellido: 'Lopez' },
    { user_id: U2, email: 'beto@test.com', nombre: 'Beto', apellido: 'Diaz' },
    { user_id: U3, email: 'caro@test.com', nombre: 'Caro', apellido: 'Sosa' },
  ]);
  t.after(() => env.close());

  const page1 = await invoke(
    mount({ db: createDb(), pgPool: env.pool }).list,
    { orden: 'name_desc', page: '1', limit: '2' },
  );
  assert.equal(page1.body.total, 3);
  assert.deepEqual(ids(page1.body), [U3, U2]);

  const page2 = await invoke(
    mount({ db: createDb(), pgPool: env.pool }).list,
    { orden: 'name_desc', page: '2', limit: '2' },
  );
  assert.deepEqual(ids(page2.body), [U1]);
});

test('global: filtro de relación sin sede se rechaza (400)', async () => {
  const pool = { queries: 0, async query() { this.queries += 1; return { rows: [] }; } };
  const res = await invoke(mount({ db: createDb(), pgPool: pool }).list, { vinculacion: 'con_historial' });
  assert.equal(res.code, 400);
  assert.equal(res.body.code, 'VINCULADO_REQUIRES_SEDE');
  assert.equal(pool.queries, 0);
});

test('sede_id malformada se rechaza para super_admin y admin_club sin tocar la base', async () => {
  const malformed = ['1abc', 'abc', '0', '-1', '1.5', '1e3', ' 1 2 '];
  for (const raw of malformed) {
    for (const role of [
      { role: 'super_admin', sede_id: null },
      { role: 'admin_club', sede_id: 7 },
    ]) {
      const db = createDb();
      const res = await invoke(mount({ db, role }).list, { sede_id: raw });
      assert.equal(res.code, 400, `${role.role} ${JSON.stringify(raw)}`);
      assert.equal(res.body.code, 'SEDE_INVALIDA');
      assert.equal(db._used.length, 0);
    }
  }
});

test('sede_id omitida o vacía: Todos para super_admin y sede propia para admin_club', async (t) => {
  const perfiles = [
    { id: 1, user_id: U1, nombre: 'Ana', apellido: 'Lopez', email: 'ana@test.com' },
    { id: 2, user_id: U2, nombre: 'Beto', apellido: 'Diaz', email: 'beto@test.com' },
  ];
  const env = await createGlobalPool(perfiles);
  t.after(() => env.close());
  const superAdmin = await invoke(
    mount({ db: createDb(), pgPool: env.pool, role: { role: 'super_admin', sede_id: null } }).list,
    { sede_id: '' },
  );
  assert.equal(superAdmin.code, 200);
  assert.equal(superAdmin.body.scope, 'global');
  assert.equal(superAdmin.body.total, 2);

  const club = await invoke(
    mount({
      db: createDb({
        perfiles,
        reservas: [{ user_id: U1, email: 'ana@test.com', sede_id: 7, fecha: '2026-01-10' }],
      }),
      role: { role: 'admin_club', sede_id: 7 },
    }).list,
    {},
  );
  assert.equal(club.code, 200);
  assert.equal(club.body.scope, 'sede');
  assert.equal(club.body.sede_id, 7);
});

test('sede_id válida de otra sede: super_admin la consulta y admin_club recibe 403', async () => {
  const perfiles = [{ id: 1, user_id: U1, nombre: 'Ana', email: 'ana@test.com' }];
  const superAdmin = await invoke(
    mount({ db: createDb({ perfiles }), role: { role: 'super_admin', sede_id: null } }).list,
    { sede_id: '9' },
  );
  assert.equal(superAdmin.code, 200);
  assert.equal(superAdmin.body.scope, 'sede');
  assert.equal(superAdmin.body.sede_id, 9);

  const club = await invoke(
    mount({ db: createDb({ perfiles }), role: { role: 'admin_club', sede_id: 7 } }).list,
    { sede_id: '9' },
  );
  assert.equal(club.code, 403);
});

test('super_admin todos deduplica UUID antes de paginar: total único y sin repetir páginas', async (t) => {
  const env = await createGlobalPool([
    { user_id: U1, email: 'ana1@test.com', nombre: 'Ana', apellido: 'Lopez' },
    { user_id: U2, email: 'beto@test.com', nombre: 'Beto', apellido: 'Diaz' },
    { user_id: U1, email: 'ana2@test.com', nombre: 'Ana Duplicada', apellido: 'Lopez' },
  ]);
  t.after(() => env.close());

  const page1 = await invoke(
    mount({ db: createDb(), pgPool: env.pool }).list,
    { page: '1', limit: '1' },
  );
  const page2 = await invoke(
    mount({ db: createDb(), pgPool: env.pool }).list,
    { page: '2', limit: '1' },
  );
  assert.equal(page1.body.total, 2);
  assert.equal(page2.body.total, 2);
  assert.deepEqual(ids(page1.body), [U1]);
  assert.deepEqual(ids(page2.body), [U2]);
  assert.equal(page1.body.items[0].display_name, 'Ana Lopez');
});
