import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import pg from 'pg';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mountTournamentPlanningRoutes } from './tournamentPlanning.js';

/**
 * SORTEOS-HORARIOS-001 — recorrido funcional LOCAL de sorteo/fixture y
 * programación de partidos sobre las rutas y el SQL REALES del repo.
 *
 * - Express real + HTTP loopback (routes/tournamentPlanning.js).
 * - PostgreSQL 17 efímero propio (sólo socket) con el DDL sintético fiel y la
 *   migración real sql/migrations/20261016100000_tournament_planning.sql
 *   (planificar_fixture_torneo / programar_partido_torneo + triggers).
 * - Datos 100% sintéticos; sin Auth/JWT real, sin DB externa, outbound false.
 */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLANNING_SQL_PATH = path.join(__dirname, '..', 'sql', 'migrations', '20261016100000_tournament_planning.sql');
const PORT = 55483;
const TORNEO = 901;
const SEDE = 8;
const ACTOR = '11111111-1111-4111-8111-111111111111';
const TZ = 'America/Argentina/Buenos_Aires';

let tempDir;
let dataDir;
let sockDir;
let clusterRunning = false;
let pool;
let server;
let baseUrl;

const DDL_SQL = `
CREATE TABLE public.sedes (id bigint PRIMARY KEY, nombre text, timezone text);
INSERT INTO public.sedes VALUES (8, 'Sede Fixture', '${TZ}'), (9, 'Sede Ajena', '${TZ}');
CREATE TABLE public.user_roles (user_id uuid, role text, sede_id bigint);
INSERT INTO public.user_roles VALUES ('${ACTOR}', 'admin_club', 8);
CREATE TABLE public.torneos (
  id bigint PRIMARY KEY, sede_id bigint, tipo_torneo text, estado text, deporte text,
  fecha_inicio date, fecha_fin date, plan_nations jsonb, modalidad_plantel text,
  updated_at timestamptz DEFAULT now()
);
INSERT INTO public.torneos (id, sede_id, tipo_torneo, estado, deporte, fecha_inicio, fecha_fin)
VALUES (${TORNEO}, ${SEDE}, 'knockout', 'abierto', 'padbol', '2026-11-20', '2026-11-21');
CREATE TABLE public.equipos (
  id bigint PRIMARY KEY, torneo_id bigint, nombre text, jugadores jsonb, inscripcion_estado text
);
INSERT INTO public.equipos VALUES
  (1, ${TORNEO}, 'Equipo 1', '[]', 'confirmada'),
  (2, ${TORNEO}, 'Equipo 2', '[]', 'confirmada'),
  (3, ${TORNEO}, 'Equipo 3', '[]', 'confirmada'),
  (4, ${TORNEO}, 'Equipo 4', '[]', 'confirmada');
CREATE TABLE public.canchas (
  id bigint PRIMARY KEY, sede_id bigint, nombre text, orden integer, estado text, deporte text
);
INSERT INTO public.canchas VALUES
  (11, 8, 'Cancha 1', 1, 'activa', 'padbol'),
  (12, 8, 'Cancha 2', 2, 'activa', 'padbol'),
  (14, 8, 'Cancha Inactiva', 3, 'inactiva', 'padbol'),
  (13, 9, 'Cancha Ajena', 1, 'activa', 'padbol');
CREATE TABLE public.partidos (
  id bigserial PRIMARY KEY, torneo_id bigint, sede_id bigint,
  equipo_a_id bigint, equipo_b_id bigint, estado text, grupo text, ronda integer,
  bracket_round integer, bracket_position integer,
  partido_siguiente_id bigint, partido_siguiente_slot text,
  fecha_hora timestamp, cancha_id bigint, cancha text
);
CREATE TABLE public.reservas (
  id bigserial PRIMARY KEY, sede_id bigint, sede text, fecha text, hora text,
  cancha integer, estado text, duracion_minutos integer
);
CREATE TABLE public.clases (id bigserial PRIMARY KEY, cancha_id bigint, activo boolean);
CREATE TABLE public.clases_horarios (
  id bigserial PRIMARY KEY, clase_id bigint, dia_semana integer, hora_inicio time, hora_fin time
);
CREATE TABLE public.scoreboard_partidos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), partido_torneo_id bigint, estado text, cancha text
);
CREATE TABLE public.torneo_nations_programacion (
  partido_id bigint, torneo_id bigint, court_id bigint, inicio timestamptz, duration_minutes integer
);
DO $roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
END
$roles$;
`;

/** PostgREST-like mínimo sobre pg para las lecturas que usa el router. */
function createDb(pool) {
  const KNOWN = new Set(['torneos', 'equipos', 'partidos', 'torneo_partidos_programacion']);
  const ident = (name) => {
    const clean = String(name).trim();
    if (!/^[a-z_][a-z0-9_]*$/i.test(clean)) throw new Error(`identificador inválido: ${clean}`);
    return `"${clean}"`;
  };
  function from(table) {
    const st = { table, cols: '*', filters: [], order: null, limit: null, single: false };
    const q = {
      select(cols) { st.cols = cols || '*'; return q; },
      eq(column, value) { st.filters.push([column, value]); return q; },
      order(column, opts) { st.order = [column, opts?.ascending === false ? 'DESC' : 'ASC']; return q; },
      limit(n) { st.limit = Number(n); return q; },
      maybeSingle() { st.single = true; return q; },
      single() { st.single = true; return q; },
      then(resolve, reject) { return execute().then(resolve, reject); },
    };
    async function execute() {
      if (!KNOWN.has(st.table)) return { data: st.single ? null : [], error: null };
      const params = [];
      const where = st.filters.map(([column, value]) => { params.push(value); return `${ident(column)} = $${params.length}`; });
      const text = `SELECT ${st.cols === '*' ? '*' : st.cols.split(',').map(ident).join(', ')} FROM public.${ident(st.table)}`
        + (where.length ? ` WHERE ${where.join(' AND ')}` : '')
        + (st.order ? ` ORDER BY ${ident(st.order[0])} ${st.order[1]}` : '')
        + (st.limit != null ? ` LIMIT ${st.limit}` : '');
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
      const signatures = {
        planificar_fixture_torneo: `SELECT public.planificar_fixture_torneo($1::bigint,$2::uuid,$3::bigint[],$4::text,$5::jsonb) AS out`,
        programar_partido_torneo: `SELECT public.programar_partido_torneo($1::bigint,$2::bigint,$3::uuid,$4::bigint,$5::timestamptz,$6::integer) AS out`,
      };
      const sql = signatures[name];
      if (!sql) return { data: null, error: { code: 'FIXTURE_RPC_UNKNOWN', message: name } };
      const values = name === 'planificar_fixture_torneo'
        ? [args.p_torneo_id, args.p_actor_id, args.p_equipo_ids, args.p_origen, JSON.stringify(args.p_partidos)]
        : [args.p_torneo_id, args.p_partido_id, args.p_actor_id, args.p_court_id, args.p_inicio, args.p_duration];
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SET LOCAL ROLE service_role');
        const result = await client.query(sql, values);
        await client.query('COMMIT');
        return { data: result.rows[0]?.out ?? null, error: null };
      } catch (error) {
        try { await client.query('ROLLBACK'); } catch { /* best effort */ }
        return { data: null, error: { code: error.code, message: error.message } };
      } finally {
        client.release();
      }
    },
  };
}

async function call(method, urlPath, body) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(`${baseUrl}${urlPath}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  let payload = null;
  try { payload = await response.json(); } catch { /* respuestas de error sin JSON no rompen la prueba */ }
  return { status: response.status, body: payload };
}

const generateFixture = () => call('POST', `/api/torneos/${TORNEO}/generar-partidos`, { origen: 'automatico' });
const schedule = (partidoId, body) => call('PUT', `/api/torneos/${TORNEO}/partidos/${partidoId}/programacion`, body);

async function count(table, where = '', params = []) {
  const { rows } = await pool.query(`SELECT count(*)::int AS n FROM public.${table} ${where}`, params);
  return rows[0].n;
}
async function partidos() {
  const { rows } = await pool.query('SELECT id, bracket_round, bracket_position, equipo_a_id, equipo_b_id, fecha_hora, cancha_id, cancha, estado FROM public.partidos WHERE torneo_id = $1 ORDER BY id', [TORNEO]);
  return rows;
}
async function matchById(id) {
  const { rows } = await pool.query('SELECT * FROM public.partidos WHERE id = $1', [id]);
  return rows[0];
}
async function programacionRows() {
  const { rows } = await pool.query('SELECT partido_id, court_id, inicio, duration_minutes FROM public.torneo_partidos_programacion ORDER BY partido_id');
  return rows;
}

before(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sorteos-horarios-'));
  dataDir = path.join(tempDir, 'data');
  sockDir = path.join(tempDir, 'sock');
  fs.mkdirSync(sockDir);
  const env = { ...process.env, LC_ALL: 'C' };
  execFileSync('initdb', ['-D', dataDir, '-A', 'trust', '-U', 'postgres', '--no-locale', '-E', 'UTF8'], { stdio: 'ignore', env });
  execFileSync('pg_ctl', ['-D', dataDir, '-l', path.join(tempDir, 'server.log'), '-o', `-F -h '' -k ${sockDir} -p ${PORT}`, '-w', 'start'], { stdio: 'ignore', env });
  clusterRunning = true;
  pool = new pg.Pool({ host: sockDir, port: PORT, user: 'postgres', database: 'postgres', max: 6 });
  await pool.query(DDL_SQL);
  await pool.query(fs.readFileSync(PLANNING_SQL_PATH, 'utf8'));

  const app = express();
  app.use(express.json());
  mountTournamentPlanningRoutes(app, {
    db: createDb(pool),
    requireTorneoAdmin: async () => ({ user: { id: ACTOR } }),
  });
  server = await new Promise((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

beforeEach(async () => {
  await pool.query('TRUNCATE public.torneo_partidos_programacion, public.torneo_fixture_planes, public.partidos, public.reservas, public.clases, public.clases_horarios, public.scoreboard_partidos RESTART IDENTITY');
  await pool.query('DELETE FROM public.torneo_nations_programacion');
  await pool.query(`UPDATE public.torneos SET estado = 'abierto', updated_at = now() WHERE id = $1`, [TORNEO]);
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

test('generar fixture: crea 3 cruces y enlaza progresión; reintento no duplica el sorteo', async () => {
  const first = await generateFixture();
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.ok, true);
  assert.equal(first.body.total, 3);
  assert.equal(first.body.origen, 'automatico');
  assert.equal(first.body.estado, 'abierto', 'planificar no inicia el torneo');

  let rows = await partidos();
  assert.equal(rows.length, 3);
  assert.equal(rows.filter((row) => row.bracket_round === 1).length, 2);
  assert.equal(rows.filter((row) => row.bracket_round === 2).length, 1);
  const firstRoundTeamIds = rows.filter((row) => row.bracket_round === 1).flatMap((row) => [row.equipo_a_id, row.equipo_b_id]).sort((a, b) => Number(a) - Number(b));
  assert.deepEqual(firstRoundTeamIds.map(Number), [1, 2, 3, 4]);
  assert.equal(await count('torneo_fixture_planes'), 1);
  const { rows: links } = await pool.query('SELECT count(*)::int AS n FROM public.partidos WHERE torneo_id = $1 AND partido_siguiente_id IS NOT NULL', [TORNEO]);
  assert.equal(links[0].n, 2, 'los dos cruces de semifinal apuntan a la final');

  // Reintento de la MISMA operación: la SQL preserva el fixture existente.
  const retry = await generateFixture();
  assert.equal(retry.status, 409, `el reintento debe rechazarse sin duplicar: ${JSON.stringify(retry.body)}`);
  rows = await partidos();
  assert.equal(rows.length, 3, 'sin cruces duplicados');
  assert.equal(await count('torneo_fixture_planes'), 1, 'un único plan persistido');
  const { rows: state } = await pool.query('SELECT estado FROM public.torneos WHERE id = $1', [TORNEO]);
  assert.equal(state[0].estado, 'abierto', 'el reintento no altera el estado del torneo');
});

test('programar partido en cancha/tiempo válidos persiste agenda y permite reintento idempotente', async () => {
  assert.equal((await generateFixture()).status, 200);
  const rows = await partidos();
  const semifinal = rows.find((row) => row.bracket_round === 1);

  const scheduled = await schedule(semifinal.id, {
    court_id: 11, fecha_hora: '2026-11-20T13:00:00Z', duration_minutes: 60,
  });
  assert.equal(scheduled.status, 200, JSON.stringify(scheduled.body));
  assert.equal(scheduled.body.ok, true);
  assert.equal(scheduled.body.partido_id, Number(semifinal.id));
  assert.equal(scheduled.body.cancha, '1');
  assert.equal(scheduled.body.duration_minutes, 60);

  const persisted = await matchById(semifinal.id);
  assert.ok(persisted.fecha_hora, 'fecha_hora persistida');
  assert.equal(Number(persisted.cancha_id), 11);
  assert.equal(String(persisted.cancha), '1');
  assert.equal((await programacionRows()).length, 1);

  const retry = await schedule(semifinal.id, {
    court_id: 11, fecha_hora: '2026-11-20T13:00:00Z', duration_minutes: 60,
  });
  assert.equal(retry.status, 200, JSON.stringify(retry.body));
  const programacion = await programacionRows();
  assert.equal(programacion.length, 1, 'el reintento no duplica la programación');
  assert.equal((await matchById(semifinal.id)).fecha_hora.getTime(), persisted.fecha_hora.getTime());
});

test('rechaza solape con reserva y con clase, sin mutar la agenda', async () => {
  assert.equal((await generateFixture()).status, 200);
  const rows = await partidos();
  const primera = rows.filter((row) => row.bracket_round === 1)[0];
  const segunda = rows.filter((row) => row.bracket_round === 1)[1];

  // Solape con reserva de cancha (misma sede, cancha orden 1, 10:30-11:30 local).
  await pool.query(
    `INSERT INTO public.reservas (sede_id, sede, fecha, hora, cancha, estado, duracion_minutos)
     VALUES ($1, 'Sede Fixture', '2026-11-20', '10:30', 1, 'confirmada', 60)`,
    [SEDE],
  );
  const reservationConflict = await schedule(primera.id, {
    court_id: 11, fecha_hora: '2026-11-20T13:00:00Z', duration_minutes: 60,
  });
  assert.equal(reservationConflict.status, 409, JSON.stringify(reservationConflict.body));
  assert.equal((await programacionRows()).length, 0, 'el conflicto no crea programación');
  assert.equal((await matchById(primera.id)).fecha_hora, null);
  await pool.query('DELETE FROM public.reservas');

  // Solape con clase activa en la misma cancha, viernes 10:30-11:30 local.
  const { rows: claseRows } = await pool.query(
    'INSERT INTO public.clases (cancha_id, activo) VALUES (11, true) RETURNING id',
  );
  await pool.query(
    `INSERT INTO public.clases_horarios (clase_id, dia_semana, hora_inicio, hora_fin)
     VALUES ($1, 5, '10:30', '11:30')`,
    [claseRows[0].id],
  );
  const classConflict = await schedule(primera.id, {
    court_id: 11, fecha_hora: '2026-11-20T13:00:00Z', duration_minutes: 60,
  });
  assert.equal(classConflict.status, 409, JSON.stringify(classConflict.body));
  assert.equal((await programacionRows()).length, 0, 'el conflicto de clase no crea programación');
  assert.equal((await matchById(primera.id)).fecha_hora, null);
  assert.equal((await matchById(segunda.id)).fecha_hora, null);
  await pool.query('TRUNCATE public.clases_horarios, public.clases RESTART IDENTITY');
});

test('rechaza cancha no elegible y tiempo inválido; conserva estado y no crea agenda', async () => {
  assert.equal((await generateFixture()).status, 200);
  const rows = await partidos();
  const partido = rows.find((row) => row.bracket_round === 1);
  const before = { partidos: (await partidos()).length, planes: await count('torneo_fixture_planes'), programacion: (await programacionRows()).length };

  const otherVenue = await schedule(partido.id, { court_id: 13, fecha_hora: '2026-11-20T13:00:00Z', duration_minutes: 60 });
  assert.equal(otherVenue.status, 409, JSON.stringify(otherVenue.body), 'cancha de otra sede');

  const inactiveCourt = await schedule(partido.id, { court_id: 14, fecha_hora: '2026-11-20T13:00:00Z', duration_minutes: 60 });
  assert.equal(inactiveCourt.status, 409, JSON.stringify(inactiveCourt.body), 'cancha inactiva');

  const outsideDates = await schedule(partido.id, { court_id: 11, fecha_hora: '2026-11-25T13:00:00Z', duration_minutes: 60 });
  assert.equal(outsideDates.status, 409, JSON.stringify(outsideDates.body), 'fuera de fechas del torneo');

  const invalidDuration = await schedule(partido.id, { court_id: 11, fecha_hora: '2026-11-20T13:00:00Z', duration_minutes: 0 });
  assert.equal(invalidDuration.status, 400, JSON.stringify(invalidDuration.body), 'duración inválida');

  const missingTimezone = await schedule(partido.id, { court_id: 11, fecha_hora: '2026-11-20T13:00:00', duration_minutes: 60 });
  assert.equal(missingTimezone.status, 400, JSON.stringify(missingTimezone.body), 'fecha sin zona horaria');

  assert.deepEqual(
    { partidos: (await partidos()).length, planes: await count('torneo_fixture_planes'), programacion: (await programacionRows()).length },
    before,
    'los rechazos conservan el estado persistido',
  );
  assert.equal((await matchById(partido.id)).fecha_hora, null);
});

test('estado final: agenda válida de dos cruces en canchas distintas y final sin programar', async () => {
  assert.equal((await generateFixture()).status, 200);
  const rows = await partidos();
  const [primera, segunda] = rows.filter((row) => row.bracket_round === 1);
  const final = rows.find((row) => row.bracket_round === 2);

  assert.equal((await schedule(primera.id, { court_id: 11, fecha_hora: '2026-11-20T13:00:00Z', duration_minutes: 60 })).status, 200);
  assert.equal((await schedule(segunda.id, { court_id: 12, fecha_hora: '2026-11-20T13:00:00Z', duration_minutes: 60 })).status, 200);

  const agenda = await programacionRows();
  assert.equal(agenda.length, 2, 'una fila de agenda por partido, sin duplicados');
  assert.deepEqual(agenda.map((row) => Number(row.court_id)).sort((a, b) => a - b), [11, 12]);
  assert.equal((await matchById(final.id)).fecha_hora, null, 'la final sigue pendiente de programar');
  assert.equal((await partidos()).length, 3);
  assert.equal(await count('torneo_fixture_planes'), 1);
});
