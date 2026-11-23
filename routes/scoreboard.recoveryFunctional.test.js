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

/**
 * MARCADOR-RECUPERACION-001 — prueba funcional focal del marcador existente.
 *
 * Fixture real: PostgreSQL 17 efímero propio (sólo socket, sin TCP), DDL fiel de
 * scoreboard_partidos/scoreboard_historial_puntos (tomado de
 * sql/migrations/rpc_schema_real.sql) y la RPC REAL
 * `public.scoreboard_commit_mutation` aplicada desde
 * sql/20261021120000_scoreboard_atomic_mutation.sql. Express real y HTTP loopback
 * sobre los handlers actuales. Auth, io (socket) y transporte de lectura son
 * fixtures locales explícitos; ninguna DB/Auth externa, ningún outbound.
 *
 * Escenario antes/después: el socket fixture `io.to().emit` lanza SIEMPRE después
 * del commit durable. El PATCH directo (call site sin helper) devuelve 500 y deja
 * la mutación persistida; punto/start/undo (call sites con emitScoreboardUpdateSafe)
 * devuelven 200 y la mutación queda aplicada una sola vez.
 */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ATOMIC_SQL_PATH = path.join(__dirname, '..', 'sql', '20261021120000_scoreboard_atomic_mutation.sql');
const PORT = 55481;
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
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scoreboard-recovery-'));
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
    nationsGamesPool: null,
    nationsGamesEnabled: false,
  });
  server = await new Promise((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

beforeEach(async () => {
  await resetBoard();
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

test('punto con emit que lanza después del commit: 200, estado persistido una sola vez y sin error que invite reintento', async () => {
  const started = await startBoard();
  assert.equal(started.status, 200, JSON.stringify(started.body));
  emitted = [];
  ioFail = true;

  const response = await point('A');

  assert.equal(response.status, 200, `se esperaba 200 y no 500/409: ${JSON.stringify(response.body)}`);
  assert.equal(response.body.error, undefined);
  assert.equal(response.body.score_a, 15);
  assert.equal(response.body.estado, 'en_curso');
  const row = await boardRow();
  assert.equal(row.score_a, 15, 'el punto quedó persistido');
  assert.equal(await historyCount(), 1, 'historial de punto insertado exactamente una vez');
  assert.equal(emitted.length, 1, 'se intentó una única emisión de socket');
  assert.match(String(emitted[0].event), /scoreboard:update/);
  ioFail = false;
});

test('después 002: PATCH y punto con el mismo emit que lanza devuelven 200 y persisten una sola vez (antes 001: PATCH 500)', async () => {
  const started = await startBoard();
  assert.equal(started.status, 200, JSON.stringify(started.body));
  ioFail = true;

  // Evidencia "antes" preservada e inmutable en MARCADOR-RECUPERACION-001/logs/
  // (run previo con el mismo fixture: PATCH => 500 con la mutación ya persistida).
  const patch = await call('PATCH', `/api/scoreboard/partidos/${BOARD}`, {
    token: ADMIN9,
    body: { equipo_a_nombre: 'Renombrado QA' },
  });
  assert.equal(patch.status, 200, `002: el emit posterior al commit ya no convierte el PATCH en 500: ${JSON.stringify(patch.body)}`);
  assert.equal(patch.body.error, undefined);
  let row = await boardRow();
  assert.equal(row.equipo_a_nombre, 'Renombrado QA');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM public.scoreboard_partidos WHERE id = $1', [BOARD])).rows[0].n, 1);

  const pointResponse = await point('A');
  assert.equal(pointResponse.status, 200, `el punto tampoco invita a reintentar: ${JSON.stringify(pointResponse.body)}`);
  row = await boardRow();
  assert.equal(row.score_a, 15);
  assert.equal(await historyCount(), 1, 'una sola aplicación del punto');
  ioFail = false;
});

test('después 002: POST crear partido con socket que lanza devuelve 201 y una única fila persistida', async () => {
  ioFail = true;
  emitted = [];
  const created = await call('POST', '/api/scoreboard/partidos', {
    token: ADMIN9,
    body: { sede_id: 9, equipo_a_nombre: 'Nuevo A QA', equipo_b_nombre: 'Nuevo B QA' },
  });
  assert.equal(created.status, 201, `crear no debe caer a 500 por la notificación: ${JSON.stringify(created.body)}`);
  assert.ok(created.body?.id, 'respuesta con id del marcador creado');
  assert.equal(created.body.error, undefined);
  const { rows } = await pool.query('SELECT id, equipo_a_nombre, estado FROM public.scoreboard_partidos ORDER BY created_at');
  assert.equal(rows.length, 2, 'la fila base + exactamente una fila creada');
  const persisted = rows.find((item) => item.id === created.body.id);
  assert.ok(persisted, 'la fila creada está persistida');
  assert.equal(persisted.equipo_a_nombre, 'Nuevo A QA');
  assert.equal(persisted.estado, 'pendiente');
  assert.equal(emitted.length, 1, 'un único intento de emisión post-commit');
  ioFail = false;
});

test('secuencia start → puntos/game/set → pausa rechaza scoring y preserva → resume → undo consistente → recarga', async () => {
  assert.equal((await startBoard()).status, 200);
  let started = await boardRow();
  assert.equal(started.estado, 'en_curso');
  assert.ok(started.cronometro_inicio);
  assert.equal(started.cronometro_pausado, false);

  // Juego con política Padbol existente: 0→15→30→40→game.
  for (let i = 0; i < 4; i += 1) assert.equal((await point('A')).status, 200);
  let row = await boardRow();
  assert.equal(row.games_a, 1, 'cuarto punto gana el game');
  assert.equal(row.score_a, 0, 'el game reinicia el score');
  assert.equal(row.score_b, 0);

  // Set 6-0: resto de games hasta que la política cierre el set.
  for (let i = 0; i < 40; i += 1) {
    if (Number((await boardRow()).sets_a) >= 1) break;
    assert.equal((await point('A')).status, 200);
  }
  row = await boardRow();
  assert.equal(row.games_a, 0, 'al ganar el set se reinician games');
  assert.equal(row.sets_a, 1, 'set ganado 6-0');
  assert.equal(row.sets_b, 0);
  assert.equal(Array.isArray(row.historial_sets) ? row.historial_sets.length : 0, 1);
  assert.deepEqual(row.historial_sets[0], { set: 1, a: 6, b: 0 });
  assert.equal(row.estado, 'en_curso', 'un set no termina el partido');
  const historyAfterSet = await historyCount();
  assert.equal(historyAfterSet, 24, 'un snapshot por punto');

  // Pausa: rechaza scoring y preserva el estado.
  const paused = await pauseBoard();
  assert.equal(paused.status, 200, JSON.stringify(paused.body));
  row = await boardRow();
  assert.equal(row.cronometro_pausado, true);
  const snapshot = { score_a: row.score_a, score_b: row.score_b, sets_a: row.sets_a, games_a: row.games_a, history: await historyCount() };
  const rejected = await point('A');
  assert.equal(rejected.status, 409, `en pausa el punto debe rechazarse: ${JSON.stringify(rejected.body)}`);
  row = await boardRow();
  assert.deepEqual(
    { score_a: row.score_a, score_b: row.score_b, sets_a: row.sets_a, games_a: row.games_a, history: await historyCount() },
    snapshot,
    'la pausa no muta score ni historial',
  );

  // Resume y nueva anotación.
  const resumed = await startBoard();
  assert.equal(resumed.status, 200, JSON.stringify(resumed.body));
  row = await boardRow();
  assert.equal(row.cronometro_pausado, false);
  const scored = await point('A');
  assert.equal(scored.status, 200, JSON.stringify(scored.body));
  assert.equal(scored.body.score_a, 15);

  // Undo consistente: vuelve al estado previo y elimina el snapshot del punto.
  const undone = await undo();
  assert.equal(undone.status, 200, JSON.stringify(undone.body));
  row = await boardRow();
  assert.equal(row.score_a, 0);
  assert.equal(row.games_a, 0);
  assert.equal(row.sets_a, 1);
  assert.equal(await historyCount(), 24, 'el undo borró exactamente el snapshot del último punto');

  // Recarga desde el mismo estado persistido y DTO sin campos de control.
  const reloaded = await readBoard();
  assert.equal(reloaded.status, 200);
  assert.equal(reloaded.body.score_a, 0);
  assert.equal(reloaded.body.games_a, 0);
  assert.equal(reloaded.body.sets_a, 1);
  assert.equal(reloaded.body.estado, 'en_curso');
  assert.equal(Object.hasOwn(reloaded.body, 'control_token_hash'), false);
  assert.equal(Object.hasOwn(reloaded.body, 'control_token'), false);
  assert.equal(JSON.stringify(reloaded.body).includes(String(row.control_token_hash ?? '\u0000')), false);
});

test('concurrencia stale: una mutación gana y la perdedora recibe 409; el punto confirmado no se pierde', async () => {
  assert.equal((await startBoard()).status, 200);
  // Amplía la ventana de carrera: ambos requests leen el mismo updated_at antes del commit.
  await pool.query(`CREATE FUNCTION public.fixture_slow_update() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN PERFORM pg_sleep(0.08); RETURN NEW; END $$`);
  await pool.query('CREATE TRIGGER fixture_slow_update BEFORE UPDATE ON public.scoreboard_partidos FOR EACH ROW EXECUTE FUNCTION public.fixture_slow_update()');

  const [a, b] = await Promise.all([point('A'), point('B')]);
  await pool.query('DROP TRIGGER fixture_slow_update ON public.scoreboard_partidos');
  await pool.query('DROP FUNCTION public.fixture_slow_update()');

  const statuses = [a.status, b.status].sort((x, y) => x - y);
  assert.deepEqual(statuses, [200, 409], `se esperaba un commit y un stale: ${JSON.stringify([a.status, b.status])}`);
  const row = await boardRow();
  const applied = [a, b].filter((response) => response.status === 200).length;
  assert.equal(await historyCount(), applied, 'cada 200 dejó exactamente su snapshot');
  assert.equal(Number(row.score_a) + Number(row.score_b), 15 * applied, 'no se pierde ni duplica el punto confirmado');
  assert.equal([row.score_a, row.score_b].filter((value) => Number(value) === 15).length, applied);
});

test('commit fallido no deja historial huérfano ni punto aplicado', async () => {
  assert.equal((await startBoard()).status, 200);
  await pool.query(`CREATE FUNCTION public.fixture_fail_history() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'fixture_historial_failure'; END $$`);
  await pool.query('CREATE TRIGGER fixture_fail_history BEFORE INSERT ON public.scoreboard_historial_puntos FOR EACH ROW EXECUTE FUNCTION public.fixture_fail_history()');

  const failed = await point('A');
  await pool.query('DROP TRIGGER fixture_fail_history ON public.scoreboard_historial_puntos');
  await pool.query('DROP FUNCTION public.fixture_fail_history()');

  assert.equal(failed.status, 500, `el fallo de commit debe fallar cerrado: ${JSON.stringify(failed.body)}`);
  const row = await boardRow();
  assert.equal(row.score_a, 0, 'la RPC revirtió el score');
  assert.equal(row.score_b, 0);
  assert.equal(await historyCount(), 0, 'sin snapshot huérfano');
  assert.deepEqual(row.historial_puntos, [], 'sin historial embebido huérfano');
});

test('token de control revocado y admin de otra sede rechazados; DTO sin token/hash', async () => {
  assert.equal((await startBoard()).status, 200);

  const issued = await call('POST', `/api/scoreboard/partidos/${BOARD}/control-token`, { token: ADMIN9 });
  assert.equal(issued.status, 200, JSON.stringify(issued.body));
  const controlToken = issued.body.control_token;
  assert.equal(typeof controlToken, 'string');
  assert.ok(controlToken.length >= 32);
  const expectedHash = crypto.createHash('sha256').update(controlToken).digest('hex');
  let row = await boardRow();
  assert.equal(row.control_token_hash, expectedHash, 'sólo se persiste el hash');
  assert.notEqual(row.control_token_hash, controlToken);
  assert.equal(JSON.stringify(row).includes(controlToken), false);

  ioFail = true;
  const byToken = await call('POST', `/api/scoreboard/control/${controlToken}/punto/A`);
  assert.equal(byToken.status, 200, JSON.stringify(byToken.body));
  assert.equal(byToken.body.score_a, 15);
  ioFail = false;

  const revoked = await call('POST', `/api/scoreboard/partidos/${BOARD}/revoke-control-token`, { token: ADMIN9 });
  assert.equal(revoked.status, 200, JSON.stringify(revoked.body));
  const afterRevoke = await call('POST', `/api/scoreboard/control/${controlToken}/punto/A`);
  assert.equal(afterRevoke.status, 401, `token revocado no muta: ${JSON.stringify(afterRevoke.body)}`);
  const readByToken = await call('GET', `/api/scoreboard/control/${controlToken}`);
  assert.equal(readByToken.status, 401);

  const otherSede = await call('POST', `/api/scoreboard/partidos/${BOARD}/punto/A`, { token: ADMIN8 });
  assert.equal(otherSede.status, 403, `otra sede no controla el marcador: ${JSON.stringify(otherSede.body)}`);

  row = await boardRow();
  assert.equal(row.score_a, 15, 'los rechazos no mutaron el marcador');
  assert.equal(await historyCount(), 1);

  const get = await readBoard();
  assert.equal(get.status, 200);
  const serialized = JSON.stringify(get.body);
  assert.equal(serialized.includes('control_token_hash'), false);
  assert.equal(serialized.includes('control_token'), false);
  assert.equal(serialized.includes(controlToken), false);
  assert.equal(Object.hasOwn(get.body, 'control_token_hash'), false);
});
