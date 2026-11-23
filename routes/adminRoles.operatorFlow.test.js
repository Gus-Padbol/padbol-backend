import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import pg from 'pg';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { mountAdminCoreRoutes } from './adminCore.js';
import { mountCommercialReleaseRoutes } from './commercialRelease.js';
import { resolveStoredRoleForVerifiedUser } from '../lib/roleIdentity.js';

/**
 * ROLES-SEDE-OPERADORES-001 — recorrido funcional LOCAL del alcance de permisos
 * de operadores por rol/sede existente.
 *
 * Rutas reales montadas:
 *  - routes/adminCore.js  GET  /api/admin/roles            (requireSuperAdminUser)
 *  - routes/commercialRelease.js POST/DELETE /api/admin/roles y
 *    /api/admin/invitaciones-admin                          (assertSuperAdminReq)
 *
 * Auth: fixtures sintéticas por Bearer; el rol SIEMPRE se resuelve desde la fila
 * persistida en user_roles (resolveStoredRoleForVerifiedUser), nunca desde el body.
 * PG17 efímero propio sólo socket, LC_ALL=C, outbound false.
 *
 * Nota de fidelidad: `assertSuperAdminReq` y el resolver de alcance se replican
 * 1:1 desde lib/releaseServices.js:33-52 y server.js:2045-2049 porque ese módulo
 * importa `svix`, ausente en este worktree WIP; no se instalaron dependencias.
 * La decisión de autorización (rol + alcance desde DB) es la misma del servidor.
 */
const PORT = 55482;
const SUPER = '00000000-0000-4000-8000-000000000001';
const CLUB1 = '00000000-0000-4000-8000-000000000002';
const CLUB2 = '00000000-0000-4000-8000-000000000003';
const EMP = '00000000-0000-4000-8000-000000000004';
const TOKENS = {
  super: { id: SUPER, email: 'super@fixture.invalid', email_confirmed_at: '2026-01-01T00:00:00Z' },
  club1: { id: CLUB1, email: 'club1@fixture.invalid', email_confirmed_at: '2026-01-01T00:00:00Z' },
  club2: { id: CLUB2, email: 'club2@fixture.invalid', email_confirmed_at: '2026-01-01T00:00:00Z' },
  empleado: { id: EMP, email: 'empleado@fixture.invalid', email_confirmed_at: '2026-01-01T00:00:00Z' },
};

let tempDir;
let dataDir;
let sockDir;
let clusterRunning = false;
let pool;
let server;
let baseUrl;
let failWrites = false;
let writeAttempts = 0;

const getAuthenticatedUser = async (req) => {
  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  const user = TOKENS[token];
  return user ? { user } : { user: null, status: 401, error: 'No autorizado' };
};

// Mismo body que createReleaseScopeResolver (lib/releaseServices.js:33-52).
const createScope = (db) => async (req) => {
  const auth = await getAuthenticatedUser(req);
  if (!auth.user?.id) return null;
  const row = await resolveStoredRoleForVerifiedUser(db, auth.user);
  if (!row) return { rol: 'jugador', authUserId: auth.user.id, alcance: 'none' };
  const rol = String(row.role || '').trim().toLowerCase();
  const allowed = {
    super_admin: ['global'], admin_nacional: ['pais', 'provincia', 'ciudad', 'sede'],
    admin_cadena: ['organizacion'], admin_club: ['sede'], empleado: ['sede'], editor_contenido: [],
  };
  const defaults = { super_admin: 'global', admin_nacional: 'pais', admin_club: 'sede' };
  const candidate = row.alcance || defaults[rol];
  const alcance = allowed[rol]?.includes(candidate) ? candidate : 'none';
  return {
    rol, alcance, superA: rol === 'super_admin' && alcance === 'global',
    authUserId: auth.user.id, authEmail: auth.user.email || '', email: auth.user.email || '', row,
    sedeId: row.sede_id == null ? null : Number(row.sede_id), organizacionId: row.organizacion_id || null,
    pais: row.pais, provincia: row.provincia, ciudad: row.ciudad,
  };
};

const FIXTURE_SQL="CREATE SCHEMA auth;CREATE TABLE auth.users(id uuid PRIMARY KEY);CREATE TABLE organizaciones(id uuid PRIMARY KEY);CREATE TABLE sedes(id bigint PRIMARY KEY,nombre text);INSERT INTO sedes VALUES(8,'PP Otra'),(9,'PP Propia');CREATE TABLE user_roles(id bigserial NOT NULL,user_id uuid,role text NOT NULL,pais text,sede_id bigint,created_at timestamp without time zone DEFAULT now(),email text,nombre text,torneos_oficiales_habilitados boolean DEFAULT false,alcance text DEFAULT 'sede'::text,ciudad text,provincia text,organizacion_id uuid,CONSTRAINT user_roles_organizacion_id_fkey FOREIGN KEY (organizacion_id) REFERENCES organizaciones(id) ON DELETE SET NULL,CONSTRAINT user_roles_pkey PRIMARY KEY (id),CONSTRAINT user_roles_role_check CHECK ((role = ANY (ARRAY['super_admin'::text, 'admin_nacional'::text, 'admin_club'::text, 'empleado'::text, 'editor_contenido'::text]))),CONSTRAINT user_roles_sede_id_fkey FOREIGN KEY (sede_id) REFERENCES sedes(id),CONSTRAINT user_roles_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE); ALTER TABLE user_roles ENABLE ROW LEVEL SECURITY; CREATE ROLE anon NOLOGIN;CREATE ROLE authenticated NOLOGIN;CREATE ROLE service_role NOLOGIN BYPASSRLS;INSERT INTO auth.users VALUES('00000000-0000-4000-8000-000000000001'),('00000000-0000-4000-8000-000000000002'),('00000000-0000-4000-8000-000000000003'),('00000000-0000-4000-8000-000000000004');CREATE TABLE invitaciones_admin(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),email text,pais text,nombre_club text,estado text,created_at timestamptz,expires_at timestamptz,sede_id bigint,invited_role text,invited_alcance text,provincia text,ciudad text);";

const SEED_SQL = `
INSERT INTO public.user_roles (user_id, email, role, alcance, sede_id) VALUES
  ('${SUPER}', 'super@fixture.invalid', 'super_admin', 'global', NULL),
  ('${CLUB1}', 'club1@fixture.invalid', 'admin_club', 'sede', 9),
  ('${CLUB2}', 'club2@fixture.invalid', 'admin_club', 'sede', 8),
  ('${EMP}', 'empleado@fixture.invalid', 'empleado', 'sede', 9);
`;

/** PostgREST-like mínimo sobre pg con inyección de fallo de escritura. */
function createDb(pool, state) {
  const KNOWN = new Set(['user_roles', 'sedes', 'invitaciones_admin']);
  const ident = (name) => {
    const clean = String(name).trim();
    if (!/^[a-z_][a-z0-9_]*$/i.test(clean)) throw new Error(`identificador inválido: ${clean}`);
    return `"${clean}"`;
  };
  function from(table) {
    const st = { table, cols: '*', filters: [], order: null, limit: null, mode: 'select', payload: null, single: false };
    const q = {
      select(cols) { st.cols = cols || '*'; return q; },
      eq(column, value) { st.filters.push([column, '=', value]); return q; },
      is(column, value) { st.filters.push([column, 'is', value]); return q; },
      order(column, opts) { st.order = [column, opts?.ascending === false ? 'DESC' : 'ASC']; return q; },
      limit(n) { st.limit = Number(n); return q; },
      maybeSingle() { st.single = true; return q; },
      single() { st.single = true; return q; },
      insert(payload) { st.mode = 'insert'; st.payload = payload; return q; },
      update(payload) { st.mode = 'update'; st.payload = payload; return q; },
      delete() { st.mode = 'delete'; return q; },
      then(resolve, reject) { return execute().then(resolve, reject); },
    };
    async function execute() {
      if (!KNOWN.has(st.table)) return { data: st.single ? null : [], error: null };
      const isWrite = st.mode !== 'select';
      if (isWrite) {
        state.writeAttempts += 1;
        if (state.failWrites) return { data: null, error: { message: 'fixture write failure', code: 'XX000' } };
      }
      const params = [];
      const where = st.filters.map(([column, op, value]) => {
        const col = ident(column);
        if (op === 'is') return `${col} IS ${value == null ? 'NULL' : 'NOT NULL'}`;
        params.push(value);
        return `${col} = $${params.length}`;
      });
      const projection = st.cols === '*' ? '*' : st.cols.split(',').map(ident).join(', ');
      let text;
      if (st.mode === 'insert') {
        const keys = Object.keys(st.payload);
        const values = keys.map((key) => { params.push(st.payload[key] ?? null); return `$${params.length}`; });
        text = `INSERT INTO public.${ident(st.table)} (${keys.map(ident).join(', ')}) VALUES (${values.join(', ')}) RETURNING ${projection}`;
      } else if (st.mode === 'update') {
        const keys = Object.keys(st.payload);
        const sets = keys.map((key) => { params.push(st.payload[key] ?? null); return `${ident(key)} = $${params.length}`; });
        text = `UPDATE public.${ident(st.table)} SET ${sets.join(', ')}`
          + (where.length ? ` WHERE ${where.join(' AND ')}` : '')
          + ` RETURNING ${projection}`;
      } else if (st.mode === 'delete') {
        text = `DELETE FROM public.${ident(st.table)}` + (where.length ? ` WHERE ${where.join(' AND ')}` : '');
      } else {
        text = `SELECT ${projection} FROM public.${ident(st.table)}`
          + (where.length ? ` WHERE ${where.join(' AND ')}` : '')
          + (st.order ? ` ORDER BY ${ident(st.order[0])} ${st.order[1]}` : '')
          + (st.limit != null ? ` LIMIT ${st.limit}` : '');
      }
      try {
        const result = await pool.query(text, params);
        if (st.mode === 'delete') return { data: null, error: null };
        return { data: st.single ? (result.rows[0] ?? null) : result.rows, error: null };
      } catch (error) {
        return { data: null, error };
      }
    }
    return q;
  }
  return {from,async rpc(name,args){
    assert.equal(name,'asignar_rol_admin_atomico');
    if(state.failWrites)return {data:null,error:{code:'XX000',message:'fixture write failure'}};
    const c=await pool.connect();
    try{await c.query('BEGIN');await c.query('SET LOCAL ROLE service_role');const result=await c.query('SELECT public.asignar_rol_admin_atomico($1::uuid,$2::jsonb) out',[args.p_actor_id,JSON.stringify(args.p_payload)]);await c.query('COMMIT');return {data:result.rows[0].out,error:null};}
    catch(e){await c.query('ROLLBACK');return {data:null,error:{code:e.code,message:e.message}};}finally{c.release();}
  }};
}

async function call(method, urlPath, { token, body } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`${baseUrl}${urlPath}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  let payload = null;
  try { payload = await response.json(); } catch { /* 500 sin JSON permitido */ }
  return { status: response.status, body: payload };
}

async function roleRows() {
  const { rows } = await pool.query('SELECT email, role, alcance, sede_id, user_id FROM public.user_roles ORDER BY email');
  return rows;
}

before(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'roles-sede-'));
  dataDir = path.join(tempDir, 'data');
  sockDir = path.join(tempDir, 'sock');
  fs.mkdirSync(sockDir);
  const env = { ...process.env, LC_ALL: 'C' };
  execFileSync('initdb', ['-D', dataDir, '-A', 'trust', '-U', 'postgres', '--no-locale', '-E', 'UTF8'], { stdio: 'ignore', env });
  execFileSync('pg_ctl', ['-D', dataDir, '-l', path.join(tempDir, 'server.log'), '-o', `-F -h '' -k ${sockDir} -p ${PORT}`, '-w', 'start'], { stdio: 'ignore', env });
  clusterRunning = true;
  pool = new pg.Pool({ host: sockDir, port: PORT, user: 'postgres', database: 'postgres', max: 4 });
  await pool.query(FIXTURE_SQL);
  await pool.query(fs.readFileSync(new URL('../sql/candidates/20261123_admin_role_assignment_atomic.sql',import.meta.url),'utf8'));

  const state = { failWrites: false, writeAttempts: 0 };
  const db = createDb(pool, state);
  const adminListScopeFromRequest = createScope(db);
  const assertSuperAdminReq = async (req) => {
    const scope = await adminListScopeFromRequest(req);
    if (!scope?.superA) throw Object.assign(new Error('No autorizado'), { status: scope ? 403 : 401 });
    return scope;
  };

  const app = express();
  app.use(express.json());
  mountAdminCoreRoutes(app, {
    supabaseAdmin: db,
    getAuthenticatedUser,
    fetchUserRoleRowForAuthUser: (user) => resolveStoredRoleForVerifiedUser(db, user),
    legacySuperAdminEmails: [],
  });
  mountCommercialReleaseRoutes(app, {
    supabaseAdmin: db,
    runtime: { mode: 'test', outboundDeliveryEnabled: false, pushSendEnabled: false },
    authUserFromBearer: async (req) => (await getAuthenticatedUser(req)).user || null,
    assertSuperAdminReq,
    adminListScopeFromRequest,
    sedesPermitidasPorScope: async () => [],
  });

  server = await new Promise((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  globalThis.__rolesFixtureState = state;
});

beforeEach(async () => {
  const state = globalThis.__rolesFixtureState;
  state.failWrites = false;
  state.writeAttempts = 0;
  await pool.query('TRUNCATE public.user_roles, public.invitaciones_admin');
  await pool.query(SEED_SQL);
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (pool) await pool.end();
  if (clusterRunning) {
    try {
      execFileSync('pg_ctl', ['-D', dataDir, '-m', 'immediate', '-w', 'stop'], { stdio: 'ignore', env: { ...process.env, LC_ALL: 'C' } });
    } catch { /* best effort */ }
  }
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
});

test('GET /api/admin/roles: sólo super_admin; admin_club propio, empleado y otra PP reciben 403; sin sesión 401', async () => {
  const superRead = await call('GET', '/api/admin/roles', { token: 'super' });
  assert.equal(superRead.status, 200, JSON.stringify(superRead.body));
  assert.equal(superRead.body.length, 4);
  assert.deepEqual(superRead.body.map((row) => row.email), [
    'club1@fixture.invalid', 'club2@fixture.invalid', 'empleado@fixture.invalid', 'super@fixture.invalid',
  ]);
  assert.equal(superRead.body.find((row) => row.email === 'club1@fixture.invalid').sede_nombre, 'PP Propia');
  assert.equal(superRead.body.find((row) => row.email === 'super@fixture.invalid').alcance, 'global');

  for (const token of ['club1', 'club2', 'empleado']) {
    const denied = await call('GET', '/api/admin/roles', { token });
    assert.equal(denied.status, 403, `${token} no debe listar roles: ${JSON.stringify(denied.body)}`);
  }
  const anonymous = await call('GET', '/api/admin/roles');
  assert.equal(anonymous.status, 401);
});

test('POST /api/admin/roles: super_admin crea operador según whitelist; reintento idempotente no duplica', async () => {
  const created = await call('POST', '/api/admin/roles', {
    token: 'super',
    body: { email: 'operador1@fixture.invalid', role: 'empleado', alcance: 'sede', sede_id: 9, nombre: 'Operador Uno' },
  });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  assert.equal(created.body.role, 'empleado');
  assert.equal(Number(created.body.sede_id), 9);

  let rows = await roleRows();
  assert.equal(rows.length, 5);
  assert.deepEqual(
    { role: rows.find((r) => r.email === 'operador1@fixture.invalid').role, sede: Number(rows.find((r) => r.email === 'operador1@fixture.invalid').sede_id) },
    { role: 'empleado', sede: 9 },
  );

  // Retry con el mismo email: actualiza la fila existente, no crea duplicados/huérfanos.
  const retried = await call('POST', '/api/admin/roles', {
    token: 'super',
    body: { email: 'operador1@fixture.invalid', role: 'admin_club', alcance: 'sede', sede_id: 9 },
  });
  assert.equal(retried.status, 200, JSON.stringify(retried.body));
  assert.equal(retried.body.role, 'admin_club');
  rows = await roleRows();
  assert.equal(rows.length, 5, 'un único registro por email');
  assert.equal(rows.filter((r) => r.email === 'operador1@fixture.invalid').length, 1);
});

test('BLOQUEO EXPLÍCITO: admin_club no administra operadores ni de su propio PP (GET/POST/DELETE), empleado no escala, otra PP 403', async () => {
  const before = await roleRows();

  // GET/POST/DELETE de roles exigen super_admin en las rutas reales.
  assert.equal((await call('GET', '/api/admin/roles', { token: 'club1' })).status, 403);
  const ownPost = await call('POST', '/api/admin/roles', {
    token: 'club1',
    body: { email: 'operador-propio@fixture.invalid', role: 'empleado', alcance: 'sede', sede_id: 9 },
  });
  assert.equal(ownPost.status, 403, JSON.stringify(ownPost.body));
  const ownDelete = await call('DELETE', '/api/admin/roles/empleado@fixture.invalid', { token: 'club1' });
  assert.equal(ownDelete.status, 403);
  assert.equal((await call('DELETE', '/api/admin/roles/empleado@fixture.invalid', { token: 'club2' })).status, 403);

  // Empleado intentando otorgar un rol más amplio.
  const escalate = await call('POST', '/api/admin/roles', {
    token: 'empleado',
    body: { email: 'escalada@fixture.invalid', role: 'admin_nacional', alcance: 'pais', pais: 'AR' },
  });
  assert.equal(escalate.status, 403, JSON.stringify(escalate.body));

  // Otra PP (sede 8) intentando crear operador en la sede 9.
  const otherPP = await call('POST', '/api/admin/roles', {
    token: 'club2',
    body: { email: 'operador-ajeno@fixture.invalid', role: 'empleado', alcance: 'sede', sede_id: 9 },
  });
  assert.equal(otherPP.status, 403, JSON.stringify(otherPP.body));

  assert.deepEqual(await roleRows(), before, 'ningún rechazo mutó user_roles');
  // No existe endpoint alternativo que permita a admin_club gestionar su PP:
  // los 3 verbo/rutas probados delegan en assertSuperAdminReq/requireSuperAdminUser.
});

test('no hay spoof por body: el rol del body no autentica y super_admin sólo acepta roles del whitelist', async () => {
  const before = await roleRows();
  const noSession = await call('POST', '/api/admin/roles', {
    body: { email: 'spoof@fixture.invalid', role: 'super_admin', alcance: 'global' },
  });
  assert.equal(noSession.status, 401, JSON.stringify(noSession.body));

  const clubSpoof = await call('POST', '/api/admin/roles', {
    token: 'club1',
    body: { email: 'spoof@fixture.invalid', role: 'super_admin', alcance: 'global' },
  });
  assert.equal(clubSpoof.status, 403, JSON.stringify(clubSpoof.body));

  const invalidRole = await call('POST', '/api/admin/roles', {
    token: 'super',
    body: { email: 'spoof@fixture.invalid', role: 'super_admin', alcance: 'global' },
  });
  assert.equal(invalidRole.status, 400, JSON.stringify(invalidRole.body));
  assert.equal(invalidRole.body.error, 'Rol inválido');

  assert.deepEqual(await roleRows(), before, 'ningún spoof creó o modificó filas');
});

test('write fallido: sin 2xx falso ni fila huérfana; el retry posterior confirma una sola fila', async () => {
  const state = globalThis.__rolesFixtureState;
  state.failWrites = true;

  const failedPost = await call('POST', '/api/admin/roles', {
    token: 'super',
    body: { email: 'fallo@fixture.invalid', role: 'empleado', alcance: 'sede', sede_id: 9 },
  });
  assert.equal(failedPost.status, 500, `un write fallido no puede devolver 2xx: ${JSON.stringify(failedPost.body)}`);
  let rows = await roleRows();
  assert.equal(rows.filter((r) => r.email === 'fallo@fixture.invalid').length, 0, 'sin fila huérfana');

  state.failWrites = false;
  const retried = await call('POST', '/api/admin/roles', {
    token: 'super',
    body: { email: 'fallo@fixture.invalid', role: 'empleado', alcance: 'sede', sede_id: 9 },
  });
  assert.equal(retried.status, 200, JSON.stringify(retried.body));
  rows = await roleRows();
  assert.equal(rows.filter((r) => r.email === 'fallo@fixture.invalid').length, 1);

  state.failWrites = true;
  const failedDelete = await call('DELETE', '/api/admin/roles/fallo@fixture.invalid', { token: 'super' });
  assert.equal(failedDelete.status, 500, JSON.stringify(failedDelete.body));
  rows = await roleRows();
  assert.equal(rows.filter((r) => r.email === 'fallo@fixture.invalid').length, 1, 'la fila sigue existiendo');

  state.failWrites = false;
  const deleted = await call('DELETE', '/api/admin/roles/fallo@fixture.invalid', { token: 'super' });
  assert.equal(deleted.status, 200, JSON.stringify(deleted.body));
  rows = await roleRows();
  assert.equal(rows.filter((r) => r.email === 'fallo@fixture.invalid').length, 0);
});

test('invitaciones admin también exigen super_admin (GET/POST 403 para admin_club; super_admin lee 200)', async () => {
  assert.equal((await call('GET', '/api/admin/invitaciones-admin', { token: 'club1' })).status, 403);
  const clubInvite = await call('POST', '/api/admin/invitaciones-admin', {
    token: 'club1',
    body: { email: 'invitado@fixture.invalid', pais: 'AR' },
  });
  assert.equal(clubInvite.status, 403, JSON.stringify(clubInvite.body));
  const superRead = await call('GET', '/api/admin/invitaciones-admin', { token: 'super' });
  assert.equal(superRead.status, 200, JSON.stringify(superRead.body));
  assert.deepEqual(superRead.body, []);
});
