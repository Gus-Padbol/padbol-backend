import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { mountCommercialReleaseRoutes } from './commercialRelease.js';
import { buildSedeReleaseInsert } from '../lib/sedeReleaseContract.js';

// Prueba realHTTP/Express + PostgreSQL 17 aislado para el alta atómica de club.
//
// - Se aplica el SQL candidato EXACTO (sql/candidates/20261123170000_...sql)
//   al cluster descartable; el éxito de la ruta NO usa un stub de RPC.
// - El route real se monta en Express y se llama por loopback HTTP.
// - Auth/email son fixtures locales explícitos: nunca se instancia un cliente
//   Supabase real, no se envía correo/WhatsApp/ Make y no se toca ninguna DB
//   externa. Ejecutar con BACKEND_RUNTIME_MODE=test,
//   OUTBOUND_DELIVERY_ENABLED=false y LC_ALL=C.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SQL_DIR = path.join(__dirname, '..', 'sql', 'candidates');
const CANDIDATE_PATH = path.join(SQL_DIR, '20261123170000_invitacion_club_atomica.sql');
const ROLLBACK_PATH = path.join(SQL_DIR, '20261123170000_invitacion_club_atomica.rollback.sql');
const CANDIDATE_SQL = fs.readFileSync(CANDIDATE_PATH, 'utf8');
const ROLLBACK_SQL = fs.readFileSync(ROLLBACK_PATH, 'utf8');

const EMAIL = 'atomica-club@fixture.invalid';
const TOKEN = 'fixture-atomic-invitation-token-003';
const EMAIL_CONC = 'atomica-concurrente@fixture.invalid';
const TOKEN_CONC = 'fixture-atomic-concurrent-token-003';

const BODY = {
  nombre: 'Club Atómico',
  ciudad: 'Rosario',
  pais: 'Argentina',
  email_contacto: EMAIL,
  telefono: '+5493415550003',
  horario_apertura: '09:00',
  horario_cierre: '22:00',
  precio_turno: 1500,
  cantidad_canchas: 3,
  moneda: 'ARS',
  metodo_pago: 'mercadopago',
  nombre_admin: 'Admin Atómico',
  direccion: 'Calle Atómica 100',
  latitud: -32.95,
  longitud: -60.65,
  google_maps_url: 'https://maps.example.invalid/?q=-32.95,-60.65',
  mp_access_token: 'SECRET-MP-TOKEN-3',
  mp_public_key: 'SECRET-MP-PUBLIC-3',
  stripe_account_id: 'acct_SECRET_3',
  deportes: [{ deporte: 'padbol', cantidad: 2 }, { deporte: 'padel', cantidad: 1 }],
};

const BODY_ONE_COURT = {
  ...BODY,
  email_contacto: EMAIL_CONC,
  nombre: 'Club Concurrente',
  nombre_admin: 'Admin Concurrente',
  cantidad_canchas: 1,
  mp_access_token: null,
  mp_public_key: null,
  stripe_account_id: null,
  deportes: [{ deporte: 'padbol', cantidad: 1 }],
};

// Guard de salida real: sólo se permite loopback; cualquier otro destino falla.
const externalFetches = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = typeof input === 'string' ? input : input?.url || String(input);
  if (!/^http:\/\/127\.0\.0\.1:\d+\//.test(url)) externalFetches.push(String(url));
  return originalFetch(input, init);
};
after(() => { globalThis.fetch = originalFetch; });

const PG_CFG = {};
let pgAdmin; // Client superuser del cluster (fixtures + aserciones)
let pgPool; // Pool usado por el adaptador del route (rol service_role por query)
let clusterDir = null;
let clusterRunning = false;
let pgVersion = '';

const quoteIdent = (name) => {
  if (!/^[a-z_][a-z0-9_]*$/.test(String(name))) throw new Error(`Identificador inválido: ${name}`);
  return `"${name}"`;
};
const quoteLiteral = (value) => `'${String(value).replaceAll("'", "''")}'`;

// ---- esquema fiel a METADATOS-ALTAS-ROOT.json (subconjunto de las 4 tablas) --
// Sólo se agregan los objetos FK (auth.users, organizaciones) que el metadata
// no describe y el trigger reportado con cuerpo stub (el body real no estaba en
// el metadata; no participa del alta atómica).
const BOOTSTRAP_SQL = `
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN BYPASSRLS;

CREATE SCHEMA auth;
CREATE TABLE auth.users (id uuid PRIMARY KEY, email text);

CREATE TABLE public.organizaciones (id uuid PRIMARY KEY DEFAULT gen_random_uuid());

CREATE TABLE public.sedes (
  id bigserial PRIMARY KEY,
  nombre text NOT NULL,
  pais text NOT NULL,
  ciudad text NOT NULL,
  idioma text NOT NULL DEFAULT 'es',
  cantidad_canchas integer,
  horario_apertura text,
  horario_cierre text,
  duracion_reserva_minutos integer NOT NULL DEFAULT 90,
  precio_por_reserva integer,
  moneda text NOT NULL DEFAULT 'ARS',
  estado text NOT NULL DEFAULT 'activo',
  google_maps_url text,
  google_maps_lat numeric,
  google_maps_lng numeric,
  imagen_portada text,
  descripcion_corta text,
  whatsapp_contacto text,
  email_contacto text,
  zona_horaria text NOT NULL DEFAULT 'America/Argentina/Buenos_Aires',
  created_at timestamp without time zone DEFAULT now(),
  updated_at timestamp without time zone DEFAULT now(),
  direccion text,
  telefono text,
  precio_turno numeric,
  numero_licencia text,
  fecha_licencia date,
  licencia_activa boolean DEFAULT true,
  logo_url text,
  fotos_urls jsonb DEFAULT '[]'::jsonb,
  descripcion text,
  mp_access_token text,
  latitud numeric,
  longitud numeric,
  instagram text,
  facebook text,
  tiktok text,
  twitter text,
  youtube text,
  website text,
  precio_manana numeric,
  precio_tarde numeric,
  color_nombre text,
  color_fondo_logo text DEFAULT '#000000',
  franjas_horarias jsonb DEFAULT '[]'::jsonb,
  fotos_destacadas jsonb DEFAULT '[]'::jsonb,
  color_hero_primario text DEFAULT '#4C1D95',
  color_hero_secundario text DEFAULT '#7C3AED',
  color_borde_hero text DEFAULT '#6D28D9',
  provincia text,
  historia text,
  metodo_pago text DEFAULT 'mercadopago',
  stripe_account_id text,
  pago_manual_instrucciones text,
  stripe_customer_id text,
  stripe_subscription_id text,
  suscripcion_estado text,
  suscripcion_proximo_cobro timestamp with time zone,
  timezone text DEFAULT 'America/Argentina/Buenos_Aires',
  anio_fundacion integer,
  tipo_licencia text DEFAULT 'club_afiliado',
  mp_public_key text,
  slogan text,
  amenities jsonb DEFAULT '[]'::jsonb,
  precio_60min integer,
  precio_90min integer,
  precio_120min integer,
  foto_portada text,
  surge_activo boolean DEFAULT false,
  surge_precio_minimo integer,
  surge_precio_maximo integer,
  foto_url text,
  deportes_disponibles text[] DEFAULT ARRAY['padbol'::text],
  es_prueba boolean NOT NULL DEFAULT false,
  tipo_sede text NOT NULL DEFAULT 'reservable',
  CONSTRAINT sedes_anio_fundacion_check CHECK (anio_fundacion IS NULL OR (anio_fundacion >= 1800 AND anio_fundacion <= 2100)),
  CONSTRAINT sedes_metodo_pago_check CHECK (metodo_pago = ANY (ARRAY['mercadopago'::text, 'stripe'::text, 'manual'::text, 'efectivo'::text])),
  CONSTRAINT sedes_reserva_completa_si_reservable CHECK (tipo_sede = 'torneo'::text OR (cantidad_canchas IS NOT NULL AND horario_apertura IS NOT NULL AND horario_cierre IS NOT NULL AND precio_por_reserva IS NOT NULL AND whatsapp_contacto IS NOT NULL)),
  CONSTRAINT sedes_tipo_sede_valido CHECK (tipo_sede = ANY (ARRAY['reservable'::text, 'torneo'::text]))
);

CREATE TABLE public.canchas_por_deporte (
  id serial PRIMARY KEY,
  sede_id integer REFERENCES public.sedes(id) ON DELETE CASCADE,
  deporte text NOT NULL,
  cantidad integer NOT NULL DEFAULT 1,
  activo boolean DEFAULT true,
  created_at timestamp with time zone DEFAULT now()
);

CREATE TABLE public.user_roles (
  id bigserial PRIMARY KEY,
  user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  role text NOT NULL,
  pais text,
  sede_id bigint REFERENCES public.sedes(id),
  created_at timestamp without time zone DEFAULT now(),
  email text,
  nombre text,
  torneos_oficiales_habilitados boolean DEFAULT false,
  alcance text DEFAULT 'sede',
  ciudad text,
  provincia text,
  organizacion_id uuid REFERENCES public.organizaciones(id) ON DELETE SET NULL,
  CONSTRAINT user_roles_role_check CHECK (role = ANY (ARRAY['super_admin'::text, 'admin_nacional'::text, 'admin_club'::text, 'empleado'::text, 'editor_contenido'::text]))
);

CREATE TABLE public.invitaciones_admin (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  token text NOT NULL,
  pais text NOT NULL,
  nombre_club text,
  estado text NOT NULL DEFAULT 'pendiente',
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  expires_at timestamp with time zone NOT NULL,
  sede_id bigint REFERENCES public.sedes(id) ON DELETE SET NULL,
  invited_role text NOT NULL DEFAULT 'admin_club',
  invited_alcance text,
  provincia text,
  ciudad text,
  organizacion_id uuid REFERENCES public.organizaciones(id) ON DELETE SET NULL,
  CONSTRAINT invitaciones_admin_estado_check CHECK (estado = ANY (ARRAY['pendiente'::text, 'completada'::text, 'expirada'::text, 'cancelada'::text])),
  CONSTRAINT invitaciones_admin_token_key UNIQUE (token)
);

ALTER TABLE public.sedes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.canchas_por_deporte ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.invitaciones_admin ENABLE ROW LEVEL SECURITY;

-- Metadata sólo trae el CREATE TRIGGER, no el cuerpo de la función. Se replica
-- con un stub que deja pasar el INSERT del alta (mismo criterio del verify).
CREATE FUNCTION public.protect_torneo_qa_marker() RETURNS trigger LANGUAGE plpgsql AS $stub$
BEGIN
  RETURN NEW;
END
$stub$;
CREATE TRIGGER protect_sede_qa_marker
  BEFORE INSERT OR UPDATE OF es_prueba ON public.sedes
  FOR EACH ROW EXECUTE FUNCTION public.protect_torneo_qa_marker();

GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.sedes, public.canchas_por_deporte,
  public.user_roles, public.invitaciones_admin TO service_role;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO service_role;
`;

function startCluster() {
  clusterDir = fs.mkdtempSync(path.join(os.tmpdir(), 'altas003-atomic-'));
  const dataDir = path.join(clusterDir, 'data');
  const port = 30000 + Math.floor(Math.random() * 20000);
  execFileSync('initdb', ['-D', dataDir, '-A', 'trust', '--no-locale', '--encoding=UTF8'],
    { stdio: 'ignore', env: { ...process.env, LC_ALL: 'C' } });
  execFileSync('pg_ctl', ['-D', dataDir, '-l', path.join(clusterDir, 'server.log'),
    '-o', `-F -h '' -k ${clusterDir} -p ${port}`, '-w', 'start'],
  { stdio: 'ignore', env: { ...process.env, LC_ALL: 'C' } });
  clusterRunning = true;
  Object.assign(PG_CFG, {
    host: clusterDir,
    port,
    user: os.userInfo().username,
    database: 'postgres',
  });
}

async function applyCandidate(client) {
  await client.query(CANDIDATE_SQL);
}

// ---- adaptador Supabase-compatible sobre PostgreSQL real -------------------
// from() y rpc() ejecutan SQL real con el rol service_role (igual que el cliente
// server-side de Supabase). La RPC es la función candidata real, no un stub.
function createSupabaseAdapter(pool, options = {}) {
  const state = {
    authCalls: 0,
    deliveries: 0,
    writes: [],
    lastAuthEmail: null,
    authMode: options.authMode || 'existing',
    outbound: options.outbound === true,
  };
  const allowed = new Set(['invitaciones_admin', 'sedes', 'canchas_por_deporte', 'user_roles']);

  async function runAsService(sql, params = []) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE service_role');
      const result = await client.query(sql, params);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* transacción ya abortada */ }
      throw error;
    } finally {
      client.release();
    }
  }

  const supabase = {
    auth: {
      admin: {
        createUser: async (credentials = {}) => {
          state.authCalls += 1;
          state.lastAuthEmail = String(credentials.email || '').trim().toLowerCase();
          if (state.authMode === 'unavailable') {
            return { data: { user: null }, error: { status: 503, message: 'Fixture Auth temporalmente no disponible' } };
          }
          if (state.authMode === 'new') {
            return { data: { user: { id: '00000000-0000-4000-8000-000000000003', email: state.lastAuthEmail } }, error: null };
          }
          return { data: { user: null }, error: { status: 422, code: 'user_already_exists', message: 'Fixture account exists' } };
        },
      },
      resetPasswordForEmail: async (email) => {
        state.deliveries += 1;
        state.lastAuthEmail = String(email || '').trim().toLowerCase();
        return { data: {}, error: null };
      },
    },

    from(table) {
      if (!allowed.has(table)) throw new Error(`Tabla inesperada en from(): ${table}`);
      const filters = [];
      let mode = 'select';
      let values = null;
      let single = false;
      let limitN = null;
      let orderBy = null;

      const whereSql = (params) => filters.map((filter) => {
        if (filter.op === 'is') {
          if (filter.value === null) return `${quoteIdent(filter.key)} IS NULL`;
          params.push(filter.value);
          return `${quoteIdent(filter.key)} IS $${params.length}`;
        }
        if (filter.op === 'in') {
          params.push(filter.value);
          return `${quoteIdent(filter.key)} = ANY($${params.length})`;
        }
        params.push(filter.value);
        return `${quoteIdent(filter.key)} ${filter.op === 'neq' ? '<>' : '='} $${params.length}`;
      }).join(' AND ');

      const query = {
        select() { return query; },
        eq(key, value) { filters.push({ op: 'eq', key, value }); return query; },
        neq(key, value) { filters.push({ op: 'neq', key, value }); return query; },
        is(key, value) { filters.push({ op: 'is', key, value }); return query; },
        in(key, value) { filters.push({ op: 'in', key, value }); return query; },
        order(key, opts = {}) { orderBy = { key, dir: opts.ascending === false ? 'DESC' : 'ASC' }; return query; },
        limit(n) { limitN = n; return query; },
        maybeSingle() { single = true; return query; },
        single() { single = true; return query; },
        insert(payload) { mode = 'insert'; values = Array.isArray(payload) ? payload : [payload]; return query; },
        update(payload) { mode = 'update'; values = payload; return query; },
        delete() { mode = 'delete'; return query; },
        async then(resolve, reject) {
          try {
            let rows;
            if (mode === 'insert') {
              rows = [];
              for (const row of values) {
                const params = [];
                const cols = Object.keys(row);
                const placeholders = cols.map((key) => { params.push(row[key]); return `$${params.length}`; });
                const result = await runAsService(
                  `INSERT INTO public.${quoteIdent(table)} (${cols.map(quoteIdent).join(', ')})
                   VALUES (${placeholders.join(', ')}) RETURNING *`, params,
                );
                rows.push(result.rows[0]);
              }
              state.writes.push({ table, mode });
            } else if (mode === 'update') {
              const params = [];
              const where = whereSql(params);
              const cols = Object.keys(values);
              const sets = cols.map((key) => { params.push(values[key]); return `${quoteIdent(key)} = $${params.length}`; });
              const result = await runAsService(
                `UPDATE public.${quoteIdent(table)} SET ${sets.join(', ')}${where ? ` WHERE ${where}` : ''} RETURNING *`, params,
              );
              rows = result.rows;
              state.writes.push({ table, mode });
            } else if (mode === 'delete') {
              const params = [];
              const where = whereSql(params);
              const result = await runAsService(
                `DELETE FROM public.${quoteIdent(table)}${where ? ` WHERE ${where}` : ''} RETURNING *`, params,
              );
              rows = result.rows;
              state.writes.push({ table, mode });
            } else {
              const params = [];
              const where = whereSql(params);
              const suffix = orderBy ? ` ORDER BY ${quoteIdent(orderBy.key)} ${orderBy.dir}` : '';
              const limitSql = limitN != null ? ` LIMIT ${Number(limitN)}` : '';
              const result = await runAsService(
                `SELECT * FROM public.${quoteIdent(table)}${where ? ` WHERE ${where}` : ''}${suffix}${limitSql}`, params,
              );
              rows = result.rows;
            }
            return resolve({ data: single ? rows[0] ?? null : rows, error: null });
          } catch (error) {
            return reject(error);
          }
        },
      };
      return query;
    },

    async rpc(name, params = {}) {
      if (name !== 'completar_invitacion_club_atomica') {
        return { data: null, error: { code: 'PGRST202', message: `Could not find the function ${name}` } };
      }
      try {
        const result = await runAsService(
          `SELECT public.completar_invitacion_club_atomica($1::text, $2::text, $3::text, $4::jsonb, $5::jsonb) AS out`,
          [params.p_token ?? null, params.p_email ?? null, params.p_nombre_admin ?? null,
            JSON.stringify(params.p_sede ?? null), JSON.stringify(params.p_deportes ?? null)],
        );
        return { data: result.rows[0].out, error: null };
      } catch (error) {
        return { data: null, error: { code: error.code, message: error.message, details: error.detail } };
      }
    },
  };
  return { state, supabase };
}

// ---- fixtures SQL ----------------------------------------------------------
async function seedInvitation(overrides = {}) {
  const row = {
    token: TOKEN,
    email: EMAIL,
    pais: 'Argentina',
    nombre_club: 'Club Atómico',
    expires_at: '2099-12-31T00:00:00Z',
    invited_role: 'admin_club',
    invited_alcance: null,
    estado: 'pendiente',
    ...overrides,
  };
  const result = await pgAdmin.query(
    `INSERT INTO public.invitaciones_admin (token, email, pais, nombre_club, expires_at, invited_role, invited_alcance, estado)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [row.token, row.email, row.pais, row.nombre_club, row.expires_at, row.invited_role,
      row.invited_alcance, row.estado],
  );
  return result.rows[0];
}

async function seedSede(overrides = {}) {
  const row = {
    nombre: 'Sede Previa Atómica',
    pais: 'Argentina',
    ciudad: 'Rosario',
    horario_apertura: '08:00',
    horario_cierre: '23:00',
    precio_por_reserva: 1000,
    cantidad_canchas: 1,
    whatsapp_contacto: '+5493415559999',
    email_contacto: 'previa@fixture.invalid',
    ...overrides,
  };
  const result = await pgAdmin.query(
    `INSERT INTO public.sedes (nombre, pais, ciudad, horario_apertura, horario_cierre,
       precio_por_reserva, cantidad_canchas, whatsapp_contacto, email_contacto)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [row.nombre, row.pais, row.ciudad, row.horario_apertura, row.horario_cierre,
      row.precio_por_reserva, row.cantidad_canchas, row.whatsapp_contacto, row.email_contacto],
  );
  return result.rows[0];
}

async function seedRole(overrides = {}) {
  const row = {
    email: EMAIL,
    role: 'admin_club',
    alcance: 'sede',
    nombre: 'Rol Previo',
    pais: 'Argentina',
    sede_id: null,
    ...overrides,
  };
  const result = await pgAdmin.query(
    `INSERT INTO public.user_roles (email, role, alcance, nombre, pais, sede_id)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [row.email, row.role, row.alcance, row.nombre, row.pais, row.sede_id],
  );
  return result.rows[0];
}

async function dbCounts() {
  const result = await pgAdmin.query(`SELECT
    (SELECT count(*)::int FROM public.sedes) AS sedes,
    (SELECT count(*)::int FROM public.canchas_por_deporte) AS canchas,
    (SELECT count(*)::int FROM public.user_roles) AS roles`);
  return result.rows[0];
}

async function invitationByToken(token) {
  const result = await pgAdmin.query('SELECT * FROM public.invitaciones_admin WHERE token = $1', [token]);
  return result.rows[0] ?? null;
}

async function roleByEmail(email) {
  const result = await pgAdmin.query(
    'SELECT * FROM public.user_roles WHERE lower(btrim(coalesce(email, \'\'))) = lower($1) ORDER BY id LIMIT 1', [email],
  );
  return result.rows[0] ?? null;
}

async function sedeById(id) {
  const result = await pgAdmin.query('SELECT * FROM public.sedes WHERE id = $1', [id]);
  return result.rows[0] ?? null;
}

async function canchasBySede(id) {
  const result = await pgAdmin.query(
    'SELECT deporte, cantidad, activo FROM public.canchas_por_deporte WHERE sede_id = $1 ORDER BY deporte', [id],
  );
  return result.rows;
}

const jsonClone = (value) => JSON.parse(JSON.stringify(value));

function assertNoSecretValues(body) {
  const blob = JSON.stringify(body);
  for (const forbidden of ['mp_access_token', 'mp_public_key', 'stripe_account_id',
    'SECRET-MP-TOKEN-3', 'SECRET-MP-PUBLIC-3', 'acct_SECRET_3',
    'tempPassword', 'temp_password', 'access_token', 'refresh_token', 'invite_url']) {
    assert.equal(blob.includes(forbidden), false, `la respuesta expone ${forbidden}: ${blob}`);
  }
}

function assertNoCredentialFields(body) {
  const blob = JSON.stringify(body);
  for (const forbidden of ['tempPassword', 'temp_password', 'access_token', 'refresh_token', 'invite_url']) {
    assert.equal(blob.includes(forbidden), false, `la respuesta expone ${forbidden}`);
  }
}

const clubPayload = (overrides = {}) => ({ ...BODY, ...overrides });

function directSede(overrides = {}) {
  return buildSedeReleaseInsert({
    nombre: 'Sede RPC Directa',
    pais: 'Argentina',
    ciudad: 'Rosario',
    provincia: null,
    timezone: 'America/Argentina/Buenos_Aires',
    direccion: null,
    email_contacto: EMAIL,
    telefono: '+5493415550003',
    horario_apertura: '09:00',
    horario_cierre: '22:00',
    precio_turno: 1500,
    moneda: 'ARS',
    metodo_pago: 'mercadopago',
    stripe_account_id: null,
    mp_access_token: null,
    mp_public_key: null,
    pago_manual_instrucciones: null,
    latitud: null,
    longitud: null,
    google_maps_url: null,
    cantidad_canchas: 1,
    ...overrides,
  });
}

async function startServer(t, options = {}) {
  const { state, supabase } = createSupabaseAdapter(pgPool, options);
  if (options.withoutRpc === true) delete supabase.rpc;
  const app = express();
  app.use(express.json());
  mountCommercialReleaseRoutes(app, {
    supabaseAdmin: supabase,
    runtime: { outboundDeliveryEnabled: options.outbound === true },
    authUserFromBearer: async () => null,
    assertSuperAdminReq: async () => { throw Object.assign(new Error('FIXTURE_FORBIDDEN'), { status: 403 }); },
    adminListScopeFromRequest: async () => null,
    sedesPermitidasPorScope: async () => ({ sedes: [] }),
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections?.(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = async (token, body = BODY) => {
    const result = await originalFetch(`${base}/api/invitacion/${encodeURIComponent(token)}/completar`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: result.status, body: await result.json() };
  };
  return { state, supabase, post };
}

before(async () => {
  startCluster();
  pgAdmin = new pg.Client(PG_CFG);
  await pgAdmin.connect();
  const version = await pgAdmin.query('SELECT version() AS v');
  pgVersion = version.rows[0].v;
  console.log(`# PG_VERSION ${pgVersion}`);
  console.log(`# CLUSTER ${clusterDir} port=${PG_CFG.port}`);
  await pgAdmin.query(BOOTSTRAP_SQL);
  await applyCandidate(pgAdmin);
  pgPool = new pg.Pool({ ...PG_CFG, max: 12 });
});

after(async () => {
  if (pgPool) await pgPool.end().catch(() => {});
  if (pgAdmin) await pgAdmin.end().catch(() => {});
  if (clusterRunning && clusterDir) {
    try {
      execFileSync('pg_ctl', ['-D', path.join(clusterDir, 'data'), '-m', 'immediate', '-w', 'stop'],
        { stdio: 'ignore', env: { ...process.env, LC_ALL: 'C' } });
    } catch { /* cluster ya detenido */ }
    clusterRunning = false;
  }
  if (clusterDir) fs.rmSync(clusterDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await pgAdmin.query(`
    DROP TRIGGER IF EXISTS test_slow_sede_insert ON public.sedes;
    DROP FUNCTION IF EXISTS public.test_slow_sede_insert() CASCADE;
    DROP TRIGGER IF EXISTS test_fail_invitation_commit ON public.invitaciones_admin;
    DROP FUNCTION IF EXISTS public.test_fail_invitation_commit() CASCADE;
  `);
  await pgAdmin.query('TRUNCATE public.canchas_por_deporte, public.user_roles, public.invitaciones_admin, public.sedes RESTART IDENTITY CASCADE');
  const present = await pgAdmin.query(`SELECT prosrc LIKE '%INVITACION_ATOMICA_FINAL_MISMATCH%' AS ok
    FROM pg_proc WHERE oid = 'public.completar_invitacion_club_atomica(text,text,text,jsonb,jsonb)'::regprocedure`);
  if (present.rows[0]?.ok !== true) await applyCandidate(pgAdmin);
});

// ===========================================================================
// 1. Camino feliz + replay (respuesta perdida) sobre PG real.
// ===========================================================================
test('club atómico: 201 con una sede/canchas/rol; replay 410 no duplica', async (t) => {
  const invitation = await seedInvitation();
  const { state, post } = await startServer(t, { authMode: 'existing' });

  const first = await post(TOKEN, BODY);
  assert.equal(first.status, 201, JSON.stringify(first.body));
  assert.equal(first.body.ok, true);
  assert.equal(first.body.access_state, 'sign_in_or_recovery');
  assert.equal(first.body.welcome_delivery, 'not_requested_existing_account');
  const sedeId = Number(first.body.sede_id);
  assert.ok(Number.isFinite(sedeId));
  assert.equal(Number(first.body.sede.id), sedeId);
  assert.equal(first.body.sede.nombre, 'Club Atómico');
  assert.equal(first.body.sede.ciudad, 'Rosario');
  assert.equal(Number(first.body.sede.cantidad_canchas), 3);
  assert.equal(Number(first.body.sede.precio_por_reserva), 1500);
  assert.equal(first.body.sede.email_contacto, EMAIL);
  assert.equal(first.body.sede.mercadopago_configurado, true);
  assert.equal(first.body.sede.stripe_configurado, true);
  assert.equal(first.body.sede.tipo_sede, 'reservable');
  assertNoSecretValues(first.body);
  assertNoCredentialFields(first.body);

  // La escritura la hizo la RPC atómica: from() sólo leyó la invitación.
  assert.deepEqual(state.writes, []);
  assert.equal(state.authCalls, 1);
  assert.equal(state.deliveries, 0);

  const counts = await dbCounts();
  assert.deepEqual(counts, { sedes: 1, canchas: 2, roles: 1 });
  assert.deepEqual(await canchasBySede(sedeId), [
    { deporte: 'padbol', cantidad: 2, activo: true },
    { deporte: 'padel', cantidad: 1, activo: true },
  ]);

  const role = await roleByEmail(EMAIL);
  assert.equal(role.role, 'admin_club');
  assert.equal(role.alcance, 'sede');
  assert.equal(Number(role.sede_id), sedeId);
  assert.equal(role.nombre, 'Admin Atómico');

  const stored = await invitationByToken(TOKEN);
  assert.equal(stored.estado, 'completada');
  assert.equal(Number(stored.sede_id), sedeId);

  // Secretos sí persistidos en la fila; nunca devueltos por HTTP.
  const sedeRow = await sedeById(sedeId);
  assert.equal(sedeRow.mp_access_token, 'SECRET-MP-TOKEN-3');
  assert.equal(sedeRow.stripe_account_id, 'acct_SECRET_3');

  // Respuesta perdida: el cliente reintenta el mismo token.
  const writesBefore = state.writes.length;
  const replay = await post(TOKEN, BODY);
  assert.equal(replay.status, 410, JSON.stringify(replay.body));
  assert.equal(replay.body.error, 'Esta invitación ya no está activa');
  assert.equal(replay.body.estado, 'completada');
  assert.equal(state.authCalls, 1, 'el replay no vuelve a provisionar Auth');
  assert.equal(state.writes.length, writesBefore, 'el replay no escribe por REST');
  assert.deepEqual(await dbCounts(), counts);
  assert.equal(Number((await invitationByToken(TOKEN)).sede_id), sedeId);
});

// ===========================================================================
// 2. Concurrencia real: dos HTTP simultáneos, mismo token.
// ===========================================================================
test('concurrencia: dos requests simultáneos mismo token → un 201 y un 410; 1 sede/1 rol/1 cancha', async (t) => {
  await seedInvitation({ token: TOKEN_CONC, email: EMAIL_CONC, nombre_club: 'Club Concurrente' });
  // Trigger test-only que fuerza el solapamiento dentro de la transacción.
  await pgAdmin.query(`
    CREATE FUNCTION public.test_slow_sede_insert() RETURNS trigger LANGUAGE plpgsql AS $slow$
    BEGIN
      PERFORM pg_sleep(0.6);
      RETURN NEW;
    END
    $slow$;
    CREATE TRIGGER test_slow_sede_insert BEFORE INSERT ON public.sedes
      FOR EACH ROW EXECUTE FUNCTION public.test_slow_sede_insert();
  `);
  const { state, post } = await startServer(t, { authMode: 'existing' });
  try {
    const [a, b] = await Promise.all([
      post(TOKEN_CONC, BODY_ONE_COURT),
      post(TOKEN_CONC, BODY_ONE_COURT),
    ]);
    const statuses = [a.status, b.status].sort((x, y) => x - y);
    assert.deepEqual(statuses, [201, 410], JSON.stringify([a.body, b.body]));
    const winner = a.status === 201 ? a : b;
    const loser = a.status === 410 ? a : b;
    assert.equal(loser.body.error, 'Esta invitación ya no está activa');
    assert.equal(loser.body.estado, 'completada');

    const sedeId = Number(winner.body.sede_id);
    assert.deepEqual(await dbCounts(), { sedes: 1, canchas: 1, roles: 1 });
    assert.deepEqual(await canchasBySede(sedeId), [{ deporte: 'padbol', cantidad: 1, activo: true }]);
    const role = await roleByEmail(EMAIL_CONC);
    assert.equal(role.role, 'admin_club');
    assert.equal(Number(role.sede_id), sedeId);
    const stored = await invitationByToken(TOKEN_CONC);
    assert.equal(stored.estado, 'completada');
    assert.equal(Number(stored.sede_id), sedeId);
    assert.deepEqual(state.writes, []);
  } finally {
    await pgAdmin.query('DROP TRIGGER IF EXISTS test_slow_sede_insert ON public.sedes');
    await pgAdmin.query('DROP FUNCTION IF EXISTS public.test_slow_sede_insert() CASCADE');
  }
});

// ===========================================================================
// 3. Fallo inyectado después de sede/canchas/rol y antes del commit final.
// ===========================================================================
test('fallo inyectado antes del commit → 500, 0 huérfanos, rol previo intacto, invitación pendiente; retry exacto', async (t) => {
  const previousSede = await seedSede({ nombre: 'Sede Previa Intacta' });
  const previousRole = await seedRole({ sede_id: previousSede.id, nombre: 'Rol Previo Intacto' });
  await seedInvitation();
  await pgAdmin.query(`
    CREATE FUNCTION public.test_fail_invitation_commit() RETURNS trigger LANGUAGE plpgsql AS $fail$
    BEGIN
      IF OLD.estado = 'pendiente' AND NEW.estado = 'completada' AND OLD.token = TG_ARGV[0] THEN
        RAISE EXCEPTION 'TEST_INJECTED_FAILURE_AFTER_ROLE';
      END IF;
      RETURN NEW;
    END
    $fail$;
    CREATE TRIGGER test_fail_invitation_commit BEFORE UPDATE ON public.invitaciones_admin
      FOR EACH ROW EXECUTE FUNCTION public.test_fail_invitation_commit(${quoteLiteral(TOKEN)});
  `);
  const { state, post } = await startServer(t, { authMode: 'existing' });
  try {
    const failed = await post(TOKEN, BODY);
    assert.equal(failed.status, 500, JSON.stringify(failed.body));
    assert.equal(failed.body.code, 'INVITACION_ATOMIC_FAILED');
    assert.equal(failed.body.retry, true);
    assert.equal(JSON.stringify(failed.body).includes('TEST_INJECTED_FAILURE'), false, 'no filtra detalle de DB');

    assert.deepEqual(await dbCounts(), { sedes: 1, canchas: 0, roles: 1 });
    assert.deepEqual(jsonClone(await roleByEmail(EMAIL)), jsonClone(previousRole));
    assert.equal((await invitationByToken(TOKEN)).estado, 'pendiente');
    assert.equal(state.authCalls, 1, 'Auth quedó fuera de la transacción (semántica aceptada)');
    assert.equal(state.deliveries, 0);
  } finally {
    await pgAdmin.query('DROP TRIGGER IF EXISTS test_fail_invitation_commit ON public.invitaciones_admin');
    await pgAdmin.query('DROP FUNCTION IF EXISTS public.test_fail_invitation_commit() CASCADE');
  }

  // Retry: exactamente una vez, reutiliza el rol previo sin duplicarlo.
  const retried = await post(TOKEN, BODY);
  assert.equal(retried.status, 201, JSON.stringify(retried.body));
  const sedeId = Number(retried.body.sede_id);
  assert.deepEqual(await dbCounts(), { sedes: 2, canchas: 2, roles: 1 });
  const roleAfter = await roleByEmail(EMAIL);
  assert.equal(roleAfter.id, previousRole.id);
  assert.equal(Number(roleAfter.sede_id), sedeId);
  assert.equal(roleAfter.role, 'admin_club');
  assert.equal(roleAfter.alcance, 'sede');
  assert.equal(roleAfter.nombre, 'Admin Atómico');
  assert.equal((await invitationByToken(TOKEN)).estado, 'completada');
  assert.equal(Number((await invitationByToken(TOKEN)).sede_id), sedeId);

  const counts = await dbCounts();
  const replay = await post(TOKEN, BODY);
  assert.equal(replay.status, 410);
  assert.deepEqual(await dbCounts(), counts);
});

// ===========================================================================
// 4. Inválidos deterministas antes de Auth/RPC/writes (HTTP).
// ===========================================================================
test('email/token/payload/rol/expiración inválidos antes de writes', async (t) => {
  const { state, post } = await startServer(t, { authMode: 'existing' });

  // email distinto: 400 antes de Auth y de cualquier write.
  await seedInvitation({ token: 'fixture-atomic-email-token-003' });
  const authBefore = state.authCalls;
  const wrongEmail = await post('fixture-atomic-email-token-003', clubPayload({ email_contacto: 'otro@fixture.invalid' }));
  assert.equal(wrongEmail.status, 400);
  assert.equal(state.authCalls, authBefore);
  assert.deepEqual(await dbCounts(), { sedes: 0, canchas: 0, roles: 0 });
  assert.equal((await invitationByToken('fixture-atomic-email-token-003')).estado, 'pendiente');

  // token inexistente / demasiado corto: 404 sin Auth.
  const missing = await post('fixture-atomic-token-inexistente-003', BODY);
  assert.equal(missing.status, 404);
  const shortToken = await post('short', BODY);
  assert.equal(shortToken.status, 404);
  assert.equal(state.authCalls, authBefore);
  assert.deepEqual(await dbCounts(), { sedes: 0, canchas: 0, roles: 0 });

  // payloads inválidos: 400 antes de Auth/RPC.
  const invalidPayloads = [
    { horario_apertura: '' },
    { horario_apertura: '25:00' },
    { deportes: [] },
    { deportes: [{ deporte: 'inventado', cantidad: 1 }] },
    { cantidad_canchas: -1 },
    { precio_turno: null },
  ];
  for (const [index, override] of invalidPayloads.entries()) {
    const token = `fixture-atomic-payload-token-${String(index).padStart(2, '0')}`;
    await seedInvitation({ token });
    const result = await post(token, clubPayload(override));
    assert.equal(result.status, 400, `${JSON.stringify(override)} → ${JSON.stringify(result.body)}`);
    assert.equal(state.authCalls, authBefore, 'payload inválido no llama Auth');
    assert.equal((await invitationByToken(token)).estado, 'pendiente');
  }
  assert.deepEqual(await dbCounts(), { sedes: 0, canchas: 0, roles: 0 });

  // rol no permitido en el flujo club: 409 sin writes de negocio.
  await seedInvitation({
    token: 'fixture-atomic-role-token-003',
    email: 'atomica-role@fixture.invalid',
    invited_role: 'admin_nacional',
    invited_alcance: null,
  });
  const roleBefore = state.authCalls;
  const wrongRole = await post('fixture-atomic-role-token-003',
    clubPayload({ email_contacto: 'atomica-role@fixture.invalid' }));
  assert.equal(wrongRole.status, 409, JSON.stringify(wrongRole.body));
  assert.equal(wrongRole.body.code, 'INVITACION_FLOW_MISMATCH');
  assert.ok(state.authCalls > roleBefore, 'Auth ocurre antes de la RPC (semántica aceptada)');
  assert.deepEqual(await dbCounts(), { sedes: 0, canchas: 0, roles: 0 });
  assert.equal((await invitationByToken('fixture-atomic-role-token-003')).estado, 'pendiente');

  // invitación expirada: 410, sin Auth, sin sede/rol, queda expirada.
  await seedInvitation({
    token: 'fixture-atomic-expired-token-003',
    email: 'atomica-expired@fixture.invalid',
    expires_at: '2000-01-01T00:00:00Z',
  });
  const expiredAuth = state.authCalls;
  const expired = await post('fixture-atomic-expired-token-003',
    clubPayload({ email_contacto: 'atomica-expired@fixture.invalid' }));
  assert.equal(expired.status, 410);
  assert.equal(expired.body.error, 'Invitación expirada');
  assert.equal(state.authCalls, expiredAuth);
  assert.deepEqual(await dbCounts(), { sedes: 0, canchas: 0, roles: 0 });
  assert.equal((await invitationByToken('fixture-atomic-expired-token-003')).estado, 'expirada');
});

// ===========================================================================
// 5. Defensa en profundidad dentro de la función (RPC directo, PG real).
// ===========================================================================
test('validaciones dentro de la RPC (directo): not_found/email/rol/expired/payload sin writes', async (t) => {
  const { supabase } = await startServer(t, { authMode: 'existing' });
  const args = (overrides = {}) => ({
    p_token: TOKEN,
    p_email: EMAIL,
    p_nombre_admin: 'Admin RPC',
    p_sede: directSede(),
    p_deportes: [{ deporte: 'padbol', cantidad: 1 }],
    ...overrides,
  });

  const notFound = await supabase.rpc('completar_invitacion_club_atomica', args({ p_token: 'fixture-atomic-no-existe-003' }));
  assert.equal(notFound.error, null);
  assert.deepEqual(notFound.data, { ok: false, reason: 'not_found' });
  assert.deepEqual(await dbCounts(), { sedes: 0, canchas: 0, roles: 0 });

  await seedInvitation();
  const emailMismatch = await supabase.rpc('completar_invitacion_club_atomica',
    args({ p_email: 'otro@fixture.invalid' }));
  assert.deepEqual(emailMismatch.data, { ok: false, reason: 'email_mismatch' });
  assert.deepEqual(await dbCounts(), { sedes: 0, canchas: 0, roles: 0 });

  const invalidSede = await supabase.rpc('completar_invitacion_club_atomica',
    args({ p_sede: { ...directSede(), horario_apertura: null } }));
  assert.equal(invalidSede.data.ok, false);
  assert.equal(invalidSede.data.reason, 'invalid_payload');
  const invalidSports = await supabase.rpc('completar_invitacion_club_atomica',
    args({ p_deportes: [] }));
  assert.equal(invalidSports.data.ok, false);
  assert.equal(invalidSports.data.reason, 'invalid_payload');
  assert.deepEqual(await dbCounts(), { sedes: 0, canchas: 0, roles: 0 });
  assert.equal((await invitationByToken(TOKEN)).estado, 'pendiente');

  await seedInvitation({
    token: 'fixture-atomic-rpc-role-003',
    email: 'rpc-role@fixture.invalid',
    invited_role: 'admin_nacional',
    invited_alcance: null,
  });
  const roleRejected = await supabase.rpc('completar_invitacion_club_atomica',
    args({
      p_token: 'fixture-atomic-rpc-role-003',
      p_email: 'rpc-role@fixture.invalid',
      p_sede: directSede({ email_contacto: 'rpc-role@fixture.invalid' }),
    }));
  assert.equal(roleRejected.data.ok, false);
  assert.equal(roleRejected.data.reason, 'role_not_allowed');
  assert.deepEqual(await dbCounts(), { sedes: 0, canchas: 0, roles: 0 });

  await seedInvitation({
    token: 'fixture-atomic-rpc-expired-003',
    email: 'rpc-expired@fixture.invalid',
    expires_at: '2000-01-01T00:00:00Z',
  });
  const expired = await supabase.rpc('completar_invitacion_club_atomica',
    args({
      p_token: 'fixture-atomic-rpc-expired-003',
      p_email: 'rpc-expired@fixture.invalid',
      p_sede: directSede({ email_contacto: 'rpc-expired@fixture.invalid' }),
    }));
  assert.deepEqual(expired.data, { ok: false, reason: 'expired' });
  assert.deepEqual(await dbCounts(), { sedes: 0, canchas: 0, roles: 0 });
  assert.equal((await invitationByToken('fixture-atomic-rpc-expired-003')).estado, 'expirada');
});

// ===========================================================================
// 6. RPC ausente: fail-closed 503, sin fallback REST; retry tras redeploy.
// ===========================================================================
test('RPC ausente → 503 sin fallback REST; cliente sin rpc → 503; retry tras redeploy 201', async (t) => {
  await seedInvitation();
  const normal = await startServer(t, { authMode: 'existing' });
  const noRpc = await startServer(t, { authMode: 'existing', withoutRpc: true });

  try {
    await pgAdmin.query(ROLLBACK_SQL);
    const absent = await normal.post(TOKEN, BODY);
    assert.equal(absent.status, 503, JSON.stringify(absent.body));
    assert.equal(absent.body.code, 'INVITACION_ATOMIC_RPC_UNAVAILABLE');
    assert.equal(absent.body.retry, false);
    assert.equal(normal.state.authCalls, 1, 'Auth ocurre antes de detectar la RPC ausente');
    assert.deepEqual(normal.state.writes, [], 'no hay fallback REST de sede/rol/invitación');
    assert.deepEqual(await dbCounts(), { sedes: 0, canchas: 0, roles: 0 });
    assert.equal((await invitationByToken(TOKEN)).estado, 'pendiente');

    const clientWithoutRpc = await noRpc.post(TOKEN, BODY);
    assert.equal(clientWithoutRpc.status, 503, JSON.stringify(clientWithoutRpc.body));
    assert.equal(clientWithoutRpc.body.code, 'INVITACION_ATOMIC_RPC_UNAVAILABLE');
    assert.equal(clientWithoutRpc.body.retry, false);
    assert.deepEqual(noRpc.state.writes, []);
    assert.deepEqual(await dbCounts(), { sedes: 0, canchas: 0, roles: 0 });
  } finally {
    await applyCandidate(pgAdmin);
  }

  const retried = await normal.post(TOKEN, BODY);
  assert.equal(retried.status, 201, JSON.stringify(retried.body));
  assert.deepEqual(await dbCounts(), { sedes: 1, canchas: 2, roles: 1 });
  assert.equal((await invitationByToken(TOKEN)).estado, 'completada');
});

// ===========================================================================
// 7. Roles reales de PostgreSQL: anon/authenticated sin EXECUTE; service_role sí.
// ===========================================================================
test('roles PG reales: anon y authenticated no ejecutan la RPC; service_role sí', async (t) => {
  await seedInvitation({ token: 'fixture-atomic-roles-003', email: 'roles@fixture.invalid' });
  const args = ['fixture-atomic-roles-003', 'roles@fixture.invalid', 'Admin Roles',
    JSON.stringify(directSede({ email_contacto: 'roles@fixture.invalid' })),
    JSON.stringify([{ deporte: 'padbol', cantidad: 1 }])];
  const call = `SELECT public.completar_invitacion_club_atomica($1::text,$2::text,$3::text,$4::jsonb,$5::jsonb) AS out`;

  for (const role of ['anon', 'authenticated']) {
    const client = new pg.Client(PG_CFG);
    await client.connect();
    try {
      await client.query(`SET ROLE ${role}`);
      const before = await dbCounts();
      await assert.rejects(
        () => client.query(call, args),
        (error) => {
          assert.equal(error.code, '42501', `${role}: ${error.code}`);
          assert.match(error.message, /permission denied for function/i);
          return true;
        },
      );
      const after = await dbCounts();
      assert.deepEqual(after, before, `${role} no debe escribir`);
    } finally {
      await client.query('RESET ROLE').catch(() => {});
      await client.end().catch(() => {});
    }
  }
  assert.deepEqual(await dbCounts(), { sedes: 0, canchas: 0, roles: 0 });
  assert.equal((await invitationByToken('fixture-atomic-roles-003')).estado, 'pendiente');

  const client = new pg.Client(PG_CFG);
  await client.connect();
  try {
    await client.query('SET ROLE service_role');
    const result = await client.query(call, args);
    assert.equal(result.rows[0].out.ok, true);
    assert.equal(result.rows[0].out.estado, 'completada');
  } finally {
    await client.query('RESET ROLE').catch(() => {});
    await client.end().catch(() => {});
  }
  assert.deepEqual(await dbCounts(), { sedes: 1, canchas: 1, roles: 1 });
  assert.equal((await invitationByToken('fixture-atomic-roles-003')).estado, 'completada');
});

// ===========================================================================
// 8. Auth no disponible: 503 retry, sin writes de negocio; retry 201.
// ===========================================================================
test('Auth no disponible → 503 retry, 0 writes, invitación pendiente; retry 201', async (t) => {
  await seedInvitation();
  const { state, post } = await startServer(t, { authMode: 'unavailable' });
  const failed = await post(TOKEN, BODY);
  assert.equal(failed.status, 503, JSON.stringify(failed.body));
  assert.equal(failed.body.code, 'SEDE_ACCESS_PROVISION_UNAVAILABLE');
  assert.equal(failed.body.retry, true);
  assert.deepEqual(state.writes, []);
  assert.deepEqual(await dbCounts(), { sedes: 0, canchas: 0, roles: 0 });
  assert.equal((await invitationByToken(TOKEN)).estado, 'pendiente');

  state.authMode = 'existing';
  const retried = await post(TOKEN, BODY);
  assert.equal(retried.status, 201, JSON.stringify(retried.body));
  assert.equal(retried.body.access_state, 'sign_in_or_recovery');
  assert.deepEqual(await dbCounts(), { sedes: 1, canchas: 2, roles: 1 });
  assert.equal((await invitationByToken(TOKEN)).estado, 'completada');
});

// ===========================================================================
// 9. Nunca un 2xx falso: recibo inconsistente → 500 BAD_RECEIPT.
// ===========================================================================
test('recibo RPC inconsistente → 500 BAD_RECEIPT; jamás 2xx falso', async (t) => {
  await seedInvitation();
  const { post } = await startServer(t, { authMode: 'existing' });
  try {
    await pgAdmin.query(`
      CREATE OR REPLACE FUNCTION public.completar_invitacion_club_atomica(
        p_token text, p_email text, p_nombre_admin text, p_sede jsonb, p_deportes jsonb
      ) RETURNS jsonb LANGUAGE sql AS $stub$
        SELECT jsonb_build_object('ok', true, 'sede_id', 999999,
          'sede', jsonb_build_object('id', 1), 'estado', 'completada')
      $stub$;
      GRANT EXECUTE ON FUNCTION public.completar_invitacion_club_atomica(text, text, text, jsonb, jsonb)
        TO service_role;
    `);
    const bad = await post(TOKEN, BODY);
    assert.equal(bad.status, 500, JSON.stringify(bad.body));
    assert.equal(bad.body.code, 'INVITACION_ATOMIC_BAD_RECEIPT');
    assert.equal(bad.body.ok, undefined);
    assert.deepEqual(await dbCounts(), { sedes: 0, canchas: 0, roles: 0 });
    assert.equal((await invitationByToken(TOKEN)).estado, 'pendiente');
  } finally {
    await applyCandidate(pgAdmin);
  }
  const retried = await post(TOKEN, BODY);
  assert.equal(retried.status, 201, JSON.stringify(retried.body));
  assert.deepEqual(await dbCounts(), { sedes: 1, canchas: 2, roles: 1 });
});

// ===========================================================================
// 10. Tokens/usuarios distintos completan de forma independiente.
// ===========================================================================
test('tokens y usuarios distintos completan independientes con su propia sede/rol', async (t) => {
  const firstEmail = 'atomica-uno@fixture.invalid';
  const secondEmail = 'atomica-dos@fixture.invalid';
  const firstToken = 'fixture-atomic-independent-token-uno-003';
  const secondToken = 'fixture-atomic-independent-token-dos-003';
  await seedInvitation({ token: firstToken, email: firstEmail, nombre_club: 'Club Uno' });
  await seedInvitation({ token: secondToken, email: secondEmail, nombre_club: 'Club Dos' });
  const { post } = await startServer(t, { authMode: 'existing' });

  const [first, second] = await Promise.all([
    post(firstToken, clubPayload({ email_contacto: firstEmail, nombre: 'Sede Uno', nombre_admin: 'Admin Uno' })),
    post(secondToken, clubPayload({ email_contacto: secondEmail, nombre: 'Sede Dos', nombre_admin: 'Admin Dos' })),
  ]);
  assert.equal(first.status, 201, JSON.stringify(first.body));
  assert.equal(second.status, 201, JSON.stringify(second.body));
  assert.notEqual(first.body.sede_id, second.body.sede_id);
  assert.deepEqual(await dbCounts(), { sedes: 2, canchas: 4, roles: 2 });

  const roleOne = await roleByEmail(firstEmail);
  const roleTwo = await roleByEmail(secondEmail);
  assert.equal(Number(roleOne.sede_id), Number(first.body.sede_id));
  assert.equal(Number(roleTwo.sede_id), Number(second.body.sede_id));
  assert.notEqual(roleOne.sede_id, roleTwo.sede_id);
  assert.equal(Number((await invitationByToken(firstToken)).sede_id), Number(first.body.sede_id));
  assert.equal(Number((await invitationByToken(secondToken)).sede_id), Number(second.body.sede_id));
  assert.deepEqual(await canchasBySede(Number(first.body.sede_id)), [
    { deporte: 'padbol', cantidad: 2, activo: true },
    { deporte: 'padel', cantidad: 1, activo: true },
  ]);
});

// ===========================================================================
// Guard de salida: no hubo ninguna llamada externa real.
// ===========================================================================
test('outbound: la suite no realizó ninguna llamada externa real', () => {
  assert.deepEqual(externalFetches, []);
});
