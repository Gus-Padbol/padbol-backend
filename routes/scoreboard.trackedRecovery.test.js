import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import pg from 'pg';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mountScoreboardRoutes } from './scoreboard.js';

// El CAS del marcador compara updated_at con precisión de microsegundos: se
// conserva el texto exacto de PostgreSQL en lugar del Date truncado a ms.
pg.types.setTypeParser(1184, (value) => value);
pg.types.setTypeParser(1114, (value) => value);

// TEST ONLY: actual tracked Games transaction/SQL, actual HTTP route, private
// socket PostgreSQL. Reuses local read adapter/schema pattern of recovery test.
// No production code changed. Auth and socket are explicit synthetic boundaries.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ATOMIC_SQL_PATH = path.join(__dirname, '..', 'sql', '20261021120000_scoreboard_atomic_mutation.sql');
const PORT = 55482;
const BOARD = '11111111-1111-4111-8111-111111111111';
const USER9 = '00000000-0000-4000-8000-000000000009';
const USER8 = '00000000-0000-4000-8000-000000000008';
const ADMIN9 = `Bearer ${USER9}`;
const ADMIN8 = `Bearer ${USER8}`;

let tempDir;
let dataDir;
let sockDir;
let clusterRunning = false;
let pool;
let server;
let baseUrl;
let emitted = [];
let ioFail = false;
let recoveryCalls = [];
let recoveryThrow = false;

const io = {
  to(room) {
    return {
      emit(event, payload) {
        emitted.push({ room, event, payload });
        if (ioFail) throw new Error('fixture socket transport down');
      },
    };
  },
};

const getAuthenticatedUser = async (req) => {
  const header = String(req.headers.authorization || '');
  if (header === ADMIN9) return { user: { id: USER9, email: 'admin9@fixture.invalid' } };
  if (header === ADMIN8) return { user: { id: USER8, email: 'admin8@fixture.invalid' } };
  return { user: null, status: 401, error: 'No autorizado' };
};
const fetchUserRoleRowForAuthUser = async (user) =>
  user?.id === USER9 ? { role: 'admin_club', sede_id: 9 }
    : user?.id === USER8 ? { role: 'admin_club', sede_id: 8 }
      : null;

const FIXTURE_SCHEMA_SQL = `
CREATE TABLE public.sedes (id integer PRIMARY KEY, nombre text);
INSERT INTO public.sedes VALUES (9, 'Sede Funcional QA');
CREATE TABLE public.canchas (id integer PRIMARY KEY, sede_id integer, nombre text, orden integer);
INSERT INTO public.canchas VALUES (11, 9, 'Cancha Funcional', 1);
CREATE TABLE public.scoreboard_partidos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sede_id integer,
  torneo_id integer,
  torneo_nombre text,
  cancha text,
  partido_abierto_id bigint,
  reserva_id bigint,
  partido_torneo_id bigint,
  synced_to_torneo_at timestamptz,
  sync_torneo_status text,
  equipo_a_nombre text NOT NULL,
  equipo_b_nombre text NOT NULL,
  equipo_a_jugadores jsonb DEFAULT '[]'::jsonb,
  equipo_b_jugadores jsonb DEFAULT '[]'::jsonb,
  jersey_a1 integer DEFAULT 1, jersey_a2 integer DEFAULT 2,
  jersey_a3 integer DEFAULT 3, jersey_a4 integer DEFAULT 4,
  jersey_b1 integer DEFAULT 1, jersey_b2 integer DEFAULT 2,
  jersey_b3 integer DEFAULT 3, jersey_b4 integer DEFAULT 4,
  color_a text DEFAULT '#1a3a6e', color_b text DEFAULT '#6e1a1a',
  color_uniforme_a1 text, color_uniforme_a2 text,
  color_uniforme_b1 text, color_uniforme_b2 text,
  estado text DEFAULT 'pendiente',
  saque_actual text DEFAULT 'A',
  score_a integer DEFAULT 0, score_b integer DEFAULT 0,
  games_a integer DEFAULT 0, games_b integer DEFAULT 0,
  sets_a integer DEFAULT 0, sets_b integer DEFAULT 0,
  historial_sets jsonb DEFAULT '[]'::jsonb,
  es_tiebreak boolean DEFAULT false,
  ultimo_punto text,
  historial_puntos jsonb DEFAULT '[]'::jsonb,
  cronometro_inicio timestamptz,
  cronometro_pausado boolean DEFAULT false,
  cronometro_segundos integer DEFAULT 0,
  control_token_hash text,
  control_token_created_at timestamptz,
  control_token_revoked_at timestamptz,
  revision bigint DEFAULT 0 NOT NULL,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);
CREATE TABLE public.scoreboard_historial_puntos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partido_id uuid REFERENCES public.scoreboard_partidos(id) ON DELETE CASCADE,
  equipo text NOT NULL,
  score_a_antes text, score_b_antes text,
  set_numero integer,
  games_a_antes integer, games_b_antes integer,
  sets_a_antes jsonb, sets_b_antes jsonb,
  es_tiebreak_antes boolean DEFAULT false,
  estado_antes text,
  historial_sets_antes jsonb,
  saque_actual_antes text,
  timestamp timestamptz DEFAULT now()
);
DO $roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
END
$roles$;
`;

/** PostgREST-like mínimo sobre pg para las tablas que usan estos handlers. */
function createDb(pool) {
  const KNOWN = new Set(['scoreboard_partidos', 'scoreboard_historial_puntos', 'sedes', 'canchas']);
  const ident = (name) => {
    const clean = String(name).trim();
    if (!/^[a-z_][a-z0-9_]*$/i.test(clean)) throw new Error(`identificador inválido: ${clean}`);
    return `"${clean}"`;
  };
  function from(table) {
    if (!/^[a-z_][a-z0-9_]*$/i.test(String(table))) throw new Error('tabla inválida');
    const st = { table, cols: '*', filters: [], order: null, limit: null, mode: 'select', payload: null, single: false };
    const q = {
      select(cols) { st.cols = cols || '*'; return q; },
      eq(column, value) { st.filters.push([column, '=', value]); return q; },
      is(column, value) { st.filters.push([column, 'is', value]); return q; },
      order(column, opts) { st.order = [column, opts?.ascending === false ? 'DESC' : 'ASC']; return q; },
      limit(n) { st.limit = Number(n); return q; },
      maybeSingle() { st.single = true; return q; },
      single() { st.single = true; return q; },
      update(payload) { st.mode = 'update'; st.payload = payload; return q; },
      insert(payload) { st.mode = 'insert'; st.payload = payload; return q; },
      then(resolve, reject) { return execute().then(resolve, reject); },
    };
    async function execute() {
      if (!KNOWN.has(st.table)) return { data: st.single ? null : [], error: null };
      const params = [];
      const where = st.filters.map(([column, op, value]) => {
        const col = ident(column);
        if (op === 'is') return `${col} IS ${value == null ? 'NULL' : 'NOT NULL'}`;
        params.push(value);
        return `${col} = $${params.length}`;
      });
      let text;
      const jsonish = (value) => (value !== null && typeof value === 'object' ? JSON.stringify(value) : value ?? null);
      if (st.mode === 'insert') {
        const row = Array.isArray(st.payload) ? st.payload[0] : st.payload;
        const keys = Object.keys(row);
        const values = keys.map((key) => { params.push(jsonish(row[key])); return `$${params.length}`; });
        text = `INSERT INTO public.${ident(st.table)} (${keys.map(ident).join(', ')}) VALUES (${values.join(', ')})`
          + ` RETURNING ${st.cols === '*' ? '*' : st.cols.split(',').map(ident).join(', ')}`;
      } else if (st.mode === 'update') {
        const keys = Object.keys(st.payload);
        const sets = keys.map((key, index) => { params.push(st.payload[key]); return `${ident(key)} = $${params.length}`; });
        text = `UPDATE public.${ident(st.table)} SET ${sets.join(', ')}`
          + (where.length ? ` WHERE ${where.join(' AND ')}` : '')
          + ` RETURNING ${st.cols === '*' ? '*' : st.cols.split(',').map(ident).join(', ')}`;
      } else {
        text = `SELECT ${st.cols === '*' ? '*' : st.cols.split(',').map(ident).join(', ')} FROM public.${ident(st.table)}`
          + (where.length ? ` WHERE ${where.join(' AND ')}` : '')
          + (st.order ? ` ORDER BY ${ident(st.order[0])} ${st.order[1]}` : '')
          + (st.limit != null ? ` LIMIT ${st.limit}` : '');
      }
      try {
        const result = await pool.query(text, params);
        return { data: st.single ? (result.rows[0] ?? null) : result.rows, error: null };
      } catch (error) {
        return { data: null, error };
      }
    }
    return q;
  }
  return {
    from,
    async rpc(name, args) {
      assert.equal(name, 'scoreboard_commit_mutation', 'sólo se admite la RPC real del marcador');
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SET LOCAL ROLE service_role');
        const result = await client.query(
          `SELECT public.scoreboard_commit_mutation($1::uuid, $2::timestamptz, $3::jsonb, $4::text, $5::jsonb, $6::uuid) AS out`,
          [
            args.p_id,
            args.p_expected_updated_at ?? null,
            JSON.stringify(args.p_next),
            args.p_kind,
            args.p_history == null ? null : JSON.stringify(args.p_history),
            args.p_history_id ?? null,
          ],
        );
        await client.query('COMMIT');
        return { data: result.rows[0]?.out ?? null, error: null };
      } catch (error) {
        try { await client.query('ROLLBACK'); } catch { /* best effort */ }
        return { data: null, error };
      } finally {
        client.release();
      }
    },
  };
}

async function resetBoard() {
  await pool.query('DROP TRIGGER IF EXISTS fixture_slow_update ON public.scoreboard_partidos');
  await pool.query('DROP FUNCTION IF EXISTS public.fixture_slow_update()');
  await pool.query('DROP TRIGGER IF EXISTS fixture_fail_history ON public.scoreboard_historial_puntos');
  await pool.query('DROP FUNCTION IF EXISTS public.fixture_fail_history()');
  await pool.query('TRUNCATE public.scoreboard_historial_puntos');
  await pool.query('DELETE FROM public.scoreboard_partidos WHERE id <> $1', [BOARD]);
  await pool.query(
    `UPDATE public.scoreboard_partidos SET
       estado = 'pendiente', saque_actual = 'A',
       score_a = 0, score_b = 0, games_a = 0, games_b = 0, sets_a = 0, sets_b = 0,
       historial_sets = '[]'::jsonb, es_tiebreak = false, ultimo_punto = NULL,
       historial_puntos = '[]'::jsonb,
       cronometro_inicio = NULL, cronometro_pausado = false, cronometro_segundos = 0,
       control_token_hash = NULL, control_token_created_at = NULL, control_token_revoked_at = NULL,
       synced_to_torneo_at = NULL, sync_torneo_status = NULL,
       updated_at = now()
     WHERE id = $1`,
    [BOARD],
  );
  emitted = [];
  ioFail = false;
}

async function call(method, urlPath, { token, body } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = token;
  const response = await fetch(`${baseUrl}${urlPath}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  let payload = null;
  try { payload = await response.json(); } catch { /* respuestas 500 sin JSON no rompen la prueba */ }
  return { status: response.status, body: payload };
}

const startBoard = () => call('POST', `/api/scoreboard/partidos/${BOARD}/cronometro/start`, { token: ADMIN9 });
const pauseBoard = () => call('POST', `/api/scoreboard/partidos/${BOARD}/cronometro/pause`, { token: ADMIN9 });
const point = (team = 'A', token = ADMIN9) => call('POST', `/api/scoreboard/partidos/${BOARD}/punto/${team}`, { token });
const undo = () => call('POST', `/api/scoreboard/partidos/${BOARD}/undo`, { token: ADMIN9 });
const readBoard = () => call('GET', `/api/scoreboard/partidos/${BOARD}`);

async function boardRow() {
  const { rows } = await pool.query('SELECT * FROM public.scoreboard_partidos WHERE id = $1', [BOARD]);
  return rows[0];
}
async function historyCount() {
  const { rows } = await pool.query('SELECT count(*)::int AS n FROM public.scoreboard_historial_puntos WHERE partido_id = $1', [BOARD]);
  return rows[0].n;
}

before(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scoreboard-tracked-recovery-'));
  dataDir = path.join(tempDir, 'data');
  sockDir = path.join(tempDir, 'sock');
  fs.mkdirSync(sockDir);
  const env = { ...process.env, LC_ALL: 'C' };
  execFileSync('initdb', ['-D', dataDir, '-A', 'trust', '-U', 'postgres', '--no-locale', '-E', 'UTF8'], { stdio: 'ignore', env });
  execFileSync('pg_ctl', ['-D', dataDir, '-l', path.join(tempDir, 'server.log'), '-o', `-F -h '' -k ${sockDir} -p ${PORT}`, '-w', 'start'], { stdio: 'ignore', env });
  clusterRunning = true;
  pool = new pg.Pool({ host: sockDir, port: PORT, user: 'postgres', database: 'postgres', max: 8 });
  await pool.query(FIXTURE_SCHEMA_SQL);
  await pool.query(fs.readFileSync(ATOMIC_SQL_PATH, 'utf8'));
  // Aggregate DDL taken from sql/tests/nations_games_atomic_history_candidate.mjs.
  await pool.query(`CREATE SCHEMA nations_marker_private;
    CREATE TABLE nations_marker_private.nations_marker_match(match_id text PRIMARY KEY,revision int,states jsonb,receipts jsonb,updated_at timestamptz);
    CREATE TABLE nations_marker_private.nations_marker_audit(match_id text,revision int,kind text,actor text,payload jsonb,UNIQUE(match_id,revision));`);
  for(const name of ['nations_games_atomic_history.sql','nations_games_commands.sql','nations_games_legacy_guard.sql'])
    await pool.query(fs.readFileSync(path.join(__dirname,'..','sql','candidates',name),'utf8'));

  await pool.query(
    `INSERT INTO public.scoreboard_partidos (id, sede_id, equipo_a_nombre, equipo_b_nombre, estado)
     VALUES ($1, 9, 'Equipo A QA', 'Equipo B QA', 'pendiente')`,
    [BOARD],
  );
  const app = express();
  app.use(express.json());
  mountScoreboardRoutes(app, {
    supabaseAdmin: createDb(pool),
    getAuthenticatedUser,
    fetchUserRoleRowForAuthUser,
    legacySuperAdminEmails: [],
    io,
    nationsGamesPool: pool,
    nationsGamesEnabled: true,
    recoverNationsFinalization: async id => {
      // The hook sees committed state via a separate pool client, before emit.
      const counts=await pool.query('SELECT count(*)::int AS n FROM nations_marker_private.games_command_receipts WHERE scoreboard_id=$1',[id]);
      recoveryCalls.push({id,receipts:counts.rows[0].n,emits:emitted.length});
      if(recoveryThrow)throw new Error('synthetic reconciliation pending');
    },
  });
  server = await new Promise((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

beforeEach(async () => {
  await pool.query('TRUNCATE nations_marker_private.games_command_receipts, nations_marker_private.games_finalization_intents, nations_marker_private.nations_marker_match, nations_marker_private.nations_marker_audit');
  await resetBoard();
  await pool.query("UPDATE public.scoreboard_partidos SET estado='en_curso',cronometro_inicio=now() WHERE id=$1",[BOARD]);
  const team=(a,b,c)=>({status:'open',active:[a,b],lineup:{iniciales:[a,b],suplentes:[c]}});
  await pool.query("INSERT INTO nations_marker_private.nations_marker_match(match_id,revision,states,receipts,updated_at) VALUES($1,0,$2,'{}',now())",[BOARD,JSON.stringify({A:team('a','b','c'),B:team('d','e','f')})]);
  recoveryCalls=[];recoveryThrow=false;ioFail=true;
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


const trackedPoint=(requestId=crypto.randomUUID(),epoch=0)=>call('POST',`/api/scoreboard/partidos/${BOARD}/punto/A`,{token:ADMIN9,body:{requestId,epoch}});
const receipts=async()=>Number((await pool.query('SELECT count(*) FROM nations_marker_private.games_command_receipts')).rows[0].count);
test('actual tracked point commits once, socket throws, same request+epoch retries without duplicate',async()=>{
 const requestId=crypto.randomUUID();const one=await trackedPoint(requestId);assert.equal(one.status,200,JSON.stringify(one.body));assert.equal(one.body.score_a,15);assert.equal(one.body.gamesEpoch,0);
 assert.equal((await boardRow()).score_a,15);assert.equal(await historyCount(),1);assert.equal(await receipts(),1);assert.equal(emitted.length,1);
 assert.deepEqual(recoveryCalls,[{id:BOARD,receipts:1,emits:0}]);
 const again=await trackedPoint(requestId);assert.equal(again.status,200,JSON.stringify(again.body));assert.equal(again.body.score_a,15);assert.equal(await historyCount(),1);assert.equal(await receipts(),1);assert.equal((await boardRow()).score_a,15);
 assert.equal(recoveryCalls.length,2,'retry still reconciles committed intent');assert.equal(emitted.length,2);
});
test('stale epoch and reused request reject without fake200 or additional durable point',async()=>{
 const requestId=crypto.randomUUID();assert.equal((await trackedPoint(requestId)).status,200);
 const stale=await trackedPoint(crypto.randomUUID(),1);assert.equal(stale.status,409,JSON.stringify(stale.body));
 const reuse=await call('POST',`/api/scoreboard/partidos/${BOARD}/punto/B`,{token:ADMIN9,body:{requestId,epoch:0}});assert.equal(reuse.status,409,JSON.stringify(reuse.body));
 assert.equal((await boardRow()).score_a,15);assert.equal(await historyCount(),1);assert.equal(await receipts(),1);assert.equal(emitted.length,1);
});
test('actual SQL history failure rolls back point and command receipt and never invokes postcommit hooks',async()=>{
 await pool.query(`CREATE FUNCTION public.fixture_fail_history() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'synthetic tracked history failure'; END$$;
 CREATE TRIGGER fixture_fail_history BEFORE INSERT ON scoreboard_historial_puntos FOR EACH ROW EXECUTE FUNCTION fixture_fail_history()`);
 const response=await trackedPoint();assert.equal(response.status,500,JSON.stringify(response.body));assert.equal((await boardRow()).score_a,0);assert.equal(await historyCount(),0);assert.equal(await receipts(),0);assert.equal(emitted.length,0);assert.equal(recoveryCalls.length,0);
});
test('postcommit reconciliation hook failure keeps durable tracked point and safe socket response',async()=>{
 recoveryThrow=true;const response=await trackedPoint();assert.equal(response.status,200,JSON.stringify(response.body));assert.equal(await historyCount(),1);assert.equal(await receipts(),1);assert.equal((await boardRow()).score_a,15);assert.equal(recoveryCalls.length,1);assert.equal(emitted.length,1);
});
