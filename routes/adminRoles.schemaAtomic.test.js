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
const PORT = 55483;
const BEFORE=process.env.ROLES002_BEFORE==='1';
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

const FIXTURE_SQL="CREATE SCHEMA auth;CREATE TABLE auth.users(id uuid PRIMARY KEY);CREATE TABLE organizaciones(id uuid PRIMARY KEY);CREATE TABLE sedes(id bigint PRIMARY KEY,nombre text);INSERT INTO sedes VALUES(8,'Other'),(9,'Own');CREATE TABLE user_roles(id bigserial NOT NULL,user_id uuid,role text NOT NULL,pais text,sede_id bigint,created_at timestamp without time zone DEFAULT now(),email text,nombre text,torneos_oficiales_habilitados boolean DEFAULT false,alcance text DEFAULT 'sede'::text,ciudad text,provincia text,organizacion_id uuid,CONSTRAINT user_roles_organizacion_id_fkey FOREIGN KEY (organizacion_id) REFERENCES organizaciones(id) ON DELETE SET NULL,CONSTRAINT user_roles_pkey PRIMARY KEY (id),CONSTRAINT user_roles_role_check CHECK ((role = ANY (ARRAY['super_admin'::text, 'admin_nacional'::text, 'admin_club'::text, 'empleado'::text, 'editor_contenido'::text]))),CONSTRAINT user_roles_sede_id_fkey FOREIGN KEY (sede_id) REFERENCES sedes(id),CONSTRAINT user_roles_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE); ALTER TABLE user_roles ENABLE ROW LEVEL SECURITY; CREATE ROLE anon NOLOGIN;CREATE ROLE authenticated NOLOGIN;CREATE ROLE service_role NOLOGIN BYPASSRLS;INSERT INTO auth.users VALUES('00000000-0000-4000-8000-000000000001'),('00000000-0000-4000-8000-000000000002'),('00000000-0000-4000-8000-000000000003'),('00000000-0000-4000-8000-000000000004');CREATE TABLE invitaciones_admin(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),email text,pais text,nombre_club text,estado text,created_at timestamptz,expires_at timestamptz,sede_id bigint,invited_role text,invited_alcance text,provincia text,ciudad text);";

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
        if(st.mode==='select' && st.filters.some(([k,,v])=>k==='email'&&v==='race@fixture.invalid') && state.readBarrier)await state.readBarrier();
        if(st.single && result.rows.length>1)return {data:null,error:{code:'PGRST116',message:'Multiple rows for single object'}};
        return { data: st.single ? (result.rows[0] ?? null) : result.rows, error: null };
      } catch (error) {
        return { data: null, error };
      }
    }
    return q;
  }
  return {from,async rpc(name,args){
    assert.equal(name,'asignar_rol_admin_atomico');if(state.beforeRpc)await state.beforeRpc();const c=await pool.connect();
    try{await c.query('BEGIN');await c.query('SET LOCAL ROLE service_role');const r=await c.query('SELECT public.asignar_rol_admin_atomico($1::uuid,$2::jsonb) out',[args.p_actor_id,JSON.stringify(args.p_payload)]);await c.query('COMMIT');return {data:r.rows[0].out,error:null};}
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
  if(!BEFORE)await pool.query(fs.readFileSync(new URL('../sql/candidates/20261123_admin_role_assignment_atomic.sql',import.meta.url),'utf8'));

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


test('effective user_roles schema: concurrency and ambiguous email through actual HTTP',async()=>{
 const target='race@fixture.invalid',payload={email:target,role:'empleado',alcance:'sede',sede_id:9,nombre:'Synthetic operator'};
 assert.equal((await pool.query("SELECT count(*)::int n FROM pg_constraint WHERE conrelid='user_roles'::regclass AND contype='u'")).rows[0].n,0);
 let reached=0,release;const barrier=new Promise(r=>release=r);const state=globalThis.__rolesFixtureState;
 if(BEFORE)state.readBarrier=async()=>{if(++reached===2)release();await barrier;};
 const results=await Promise.all([call('POST','/api/admin/roles',{token:'super',body:payload}),call('POST','/api/admin/roles',{token:'super',body:payload})]);state.readBarrier=null;
 assert.deepEqual(results.map(r=>r.status),[200,200]);
 const rows=async()=>(await pool.query('SELECT * FROM user_roles WHERE lower(trim(email))=$1 ORDER BY id',[target])).rows;
 const concurrent=await rows();assert.equal(concurrent.length,BEFORE?2:1);console.log('CONCURRENT_ROWS',concurrent.length);
 if(!BEFORE){
  const retry=await call('POST','/api/admin/roles',{token:'super',body:payload});assert.equal(retry.status,200);assert.equal((await rows()).length,1);
  await pool.query("INSERT INTO user_roles(email,role,alcance,sede_id) VALUES($1,'empleado','sede',8)",[target]);
 }
 const before=JSON.stringify(await rows());
 const ambiguous=await call('POST','/api/admin/roles',{token:'super',body:{...payload,role:'admin_club'}});
 console.log('AMBIGUOUS',ambiguous.status,(await rows()).length);
 assert.equal(ambiguous.status,BEFORE?200:409);
 if(BEFORE){assert.equal((await rows()).length,3);return;}
 assert.equal(JSON.stringify(await rows()),before,'ambiguous rows preserved exactly');
 await pool.query('DELETE FROM user_roles WHERE email=$1',[target]);
 await pool.query(`CREATE FUNCTION roles002_fail() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'INJECTED_ROLE_WRITE';END$$; CREATE TRIGGER roles002_fail BEFORE INSERT ON user_roles FOR EACH ROW EXECUTE FUNCTION roles002_fail()`);
 const failed=await call('POST','/api/admin/roles',{token:'super',body:payload});assert.equal(failed.status,500);assert.equal((await rows()).length,0);
 await pool.query('DROP TRIGGER roles002_fail ON user_roles');assert.equal((await call('POST','/api/admin/roles',{token:'super',body:payload})).status,200);assert.equal((await rows()).length,1);
 assert.equal((await call('POST','/api/admin/roles',{token:'club1',body:payload})).status,403);
 assert.equal((await call('POST','/api/admin/roles',{token:'super',body:{...payload,role:'super_admin'}})).status,400);
 for(const role of ['anon','authenticated']){const c=await pool.connect();try{await c.query('BEGIN');await c.query(`SET LOCAL ROLE ${role}`);await assert.rejects(c.query("SELECT asignar_rol_admin_atomico($1,'{}'::jsonb)",[SUPER]),e=>e.code==='42501');await c.query('ROLLBACK');}finally{c.release();}}
 const c=await pool.connect();try{await c.query('BEGIN');await c.query('SET LOCAL ROLE service_role');await assert.rejects(c.query('SELECT asignar_rol_admin_atomico($1,$2::jsonb)',[CLUB1,JSON.stringify(payload)]),e=>e.code==='42501');await c.query('ROLLBACK');}finally{c.release();}
 await pool.query("UPDATE user_roles SET alcance='sede' WHERE user_id=$1",[SUPER]);
 const scoped=await pool.connect();try{await scoped.query('BEGIN');await scoped.query('SET LOCAL ROLE service_role');await assert.rejects(scoped.query('SELECT asignar_rol_admin_atomico($1,$2::jsonb)',[SUPER,JSON.stringify(payload)]),e=>e.code==='42501');await scoped.query('ROLLBACK');}finally{scoped.release();}
 await pool.query("UPDATE user_roles SET alcance='global' WHERE user_id=$1",[SUPER]);
 assert.equal((await call('POST','/api/admin/roles',{token:'club1',body:{...payload,p_actor_id:SUPER,role:'super_admin'}})).status,403);
 await pool.query(fs.readFileSync(new URL('../sql/candidates/20261123_admin_role_assignment_atomic.verify-readonly.sql',import.meta.url),'utf8'));
 const beforeUpdateFailure=JSON.stringify(await rows());
 await pool.query('CREATE TRIGGER roles002_fail_update BEFORE UPDATE ON user_roles FOR EACH ROW EXECUTE FUNCTION roles002_fail()');
 assert.equal((await call('POST','/api/admin/roles',{token:'super',body:{...payload,role:'admin_club'}})).status,500);assert.equal(JSON.stringify(await rows()),beforeUpdateFailure);
 await pool.query('DROP TRIGGER roles002_fail_update ON user_roles');
 state.beforeRpc=()=>pool.query("UPDATE user_roles SET role='admin_club',alcance='sede',sede_id=9 WHERE user_id=$1",[SUPER]);
 assert.equal((await call('POST','/api/admin/roles',{token:'super',body:payload})).status,403);assert.equal(JSON.stringify(await rows()),beforeUpdateFailure);
 state.beforeRpc=null;await pool.query("UPDATE user_roles SET role='super_admin',alcance='global',sede_id=NULL WHERE user_id=$1",[SUPER]);
 console.log('PASS EXISTING_ROLE_UPDATE_FAILURE_ROLLBACK_AND_HTTP_ACTOR_REVOCATION');
 const rowsBeforeMissing=JSON.stringify(await rows());
 await pool.query(fs.readFileSync(new URL('../sql/candidates/20261123_admin_role_assignment_atomic.rollback.sql',import.meta.url),'utf8'));
 assert.equal((await call('POST','/api/admin/roles',{token:'super',body:payload})).status,503);assert.equal(JSON.stringify(await rows()),rowsBeforeMissing);
 console.log('PASS EXACT_SCHEMA_CONCURRENT_RETRY_AMBIGUOUS_ROLLBACK_DENIAL_ACL');
});
