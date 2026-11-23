import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { after, test } from 'node:test';
import pg from 'pg';
import { persistGenericTournamentClosure } from './tournamentCompletionService.js';
import { tournamentLocalDate } from './tournamentDates.js';

/**
 * Prueba focal del cierre genérico ATÓMICO contra PostgreSQL efímero local.
 * Sólo corre con CIERRE_ATOMIC_PG_BOOT=1: crea un cluster desechable en /tmp,
 * escucha en 127.0.0.1:55467 y nunca abre otra URL/base. Sin JWT, QA ni prod.
 */
const BOOT = process.env.CIERRE_ATOMIC_PG_BOOT === '1';
const HOST = '127.0.0.1';
const PORT = 55467;
const DATABASE = 'cierre_atomic_test';

// Preserve PostgreSQL timestamp precision as text: Supabase/PostgREST returns
// updated_at as a string and the optimistic lock must keep microseconds.
pg.types.setTypeParser(1114, value => value);
pg.types.setTypeParser(1184, value => value);
pg.types.setTypeParser(1082, value => value);

export function assertSafeCierrePgTarget(host, port, database) {
  if (!['127.0.0.1', 'localhost'].includes(String(host))
    || Number(port) !== PORT || database !== DATABASE) {
    throw new Error('REFUSE_NON_LOCAL_CIERRE_PG');
  }
  return true;
}

test('guarda PG: sólo el cluster local dedicado', () => {
  assert.equal(assertSafeCierrePgTarget(HOST, PORT, DATABASE), true);
  assert.throws(() => assertSafeCierrePgTarget('db.example.com', PORT, DATABASE), /REFUSE/);
  assert.throws(() => assertSafeCierrePgTarget(HOST, 5432, DATABASE), /REFUSE/);
  assert.throws(() => assertSafeCierrePgTarget(HOST, PORT, 'postgres'), /REFUSE/);
});

const SCHEMA = `
  CREATE TABLE public.torneos (
    id bigint PRIMARY KEY,
    nombre text NOT NULL,
    sede_id bigint,
    nivel_torneo text NOT NULL DEFAULT 'club_no_oficial',
    tipo_torneo text NOT NULL DEFAULT 'round_robin',
    estado text NOT NULL DEFAULT 'planificacion',
    fecha_inicio date NOT NULL,
    fecha_fin date NOT NULL,
    cupos_maximos integer,
    deporte text NOT NULL DEFAULT 'padbol',
    modalidad_plantel text NOT NULL DEFAULT 'dobles',
    plan_nations jsonb,
    es_prueba boolean NOT NULL DEFAULT false,
    created_at timestamp NOT NULL DEFAULT now(),
    updated_at timestamp NOT NULL DEFAULT now()
  );
  CREATE TABLE public.equipos (
    id bigint PRIMARY KEY,
    torneo_id bigint,
    nombre text NOT NULL,
    jugadores jsonb DEFAULT '[]'::jsonb,
    puntos_ranking integer DEFAULT 0,
    puntos_totales integer DEFAULT 0,
    posicion integer,
    sets_ganados integer DEFAULT 0,
    sets_perdidos integer DEFAULT 0,
    games_ganados integer DEFAULT 0,
    games_perdidos integer DEFAULT 0,
    partidos_jugados integer DEFAULT 0
  );
  CREATE TABLE public.partidos (
    id bigint PRIMARY KEY,
    torneo_id bigint,
    estado text NOT NULL DEFAULT 'pendiente',
    equipo_a_id bigint,
    equipo_b_id bigint,
    ganador_equipo_id bigint,
    grupo text,
    bracket_round integer,
    bracket_position integer,
    ronda text,
    fase text,
    partido_siguiente_id bigint,
    partido_siguiente_slot text,
    resultado jsonb,
    es_final boolean,
    impacto_tabla boolean
  );
  CREATE TABLE public.tabla_puntos (
    id bigserial PRIMARY KEY,
    torneo_id bigint NOT NULL,
    equipo_id bigint NOT NULL,
    posicion integer NOT NULL,
    puntos integer NOT NULL,
    created_at timestamp NOT NULL DEFAULT now(),
    deporte text NOT NULL DEFAULT 'padbol',
    UNIQUE (torneo_id, equipo_id)
  );
  CREATE TABLE public.config_puntos (
    id bigserial PRIMARY KEY,
    clave text NOT NULL,
    valor jsonb NOT NULL
  );
  CREATE TABLE public.test_failures (phase text PRIMARY KEY);
  CREATE FUNCTION public.test_inject_failure() RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN
    IF EXISTS (SELECT 1 FROM public.test_failures WHERE phase = TG_ARGV[0]) THEN
      RAISE EXCEPTION 'INJECTED_FAILURE:%', TG_ARGV[0] USING ERRCODE='P0001';
    END IF;
    RETURN NEW;
  END $$;
  CREATE TRIGGER test_inject_ledger BEFORE INSERT ON public.tabla_puntos
    FOR EACH ROW EXECUTE FUNCTION public.test_inject_failure('ledger');
  CREATE TRIGGER test_inject_teams BEFORE UPDATE ON public.equipos
    FOR EACH ROW EXECUTE FUNCTION public.test_inject_failure('teams');
  CREATE TRIGGER test_inject_tournament BEFORE UPDATE ON public.torneos
    FOR EACH ROW EXECUTE FUNCTION public.test_inject_failure('tournament');
  CREATE TABLE public.test_suppressions (phase text PRIMARY KEY, equipo_id bigint);
  CREATE FUNCTION public.test_suppress_ledger() RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN
    IF EXISTS (SELECT 1 FROM public.test_suppressions WHERE phase='ledger' AND (equipo_id IS NULL OR equipo_id=NEW.equipo_id)) THEN
      RETURN NULL;
    END IF;
    RETURN NEW;
  END $$;
  CREATE FUNCTION public.test_suppress_tournament() RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN
    IF EXISTS (SELECT 1 FROM public.test_suppressions WHERE phase='tournament') THEN RETURN NULL; END IF;
    RETURN NEW;
  END $$;
  CREATE FUNCTION public.test_mutate_ledger() RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN
    IF EXISTS (SELECT 1 FROM public.test_suppressions WHERE phase='ledger_value') THEN NEW.puntos := 0; END IF;
    RETURN NEW;
  END $$;
  CREATE FUNCTION public.test_mutate_tournament() RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN
    IF EXISTS (SELECT 1 FROM public.test_suppressions WHERE phase='tournament_value') THEN NEW.fecha_fin := DATE '1999-01-01'; END IF;
    RETURN NEW;
  END $$;
  CREATE TRIGGER test_suppress_ledger BEFORE INSERT ON public.tabla_puntos
    FOR EACH ROW EXECUTE FUNCTION public.test_suppress_ledger();
  CREATE TRIGGER test_suppress_tournament BEFORE UPDATE ON public.torneos
    FOR EACH ROW EXECUTE FUNCTION public.test_suppress_tournament();
  CREATE TRIGGER test_mutate_ledger BEFORE INSERT ON public.tabla_puntos
    FOR EACH ROW EXECUTE FUNCTION public.test_mutate_ledger();
  CREATE TRIGGER test_mutate_tournament BEFORE UPDATE ON public.torneos
    FOR EACH ROW EXECUTE FUNCTION public.test_mutate_tournament();
  CREATE ROLE anon;
  CREATE ROLE authenticated;
  CREATE ROLE service_role;
`;

let pool;
let temp;
let cluster;
let httpServer;
let started = false;
const flags = { staleTorneoOnce: false, rpcCalls: 0, rankUpdates: 0 };

function makeDb(pool) {
  return {
    from(table) {
      const state = { table, cols: '*', filters: [], single: false, optional: false };
      const exec = async () => {
        const values = [];
        const where = state.filters.map(([col, val]) => { values.push(val); return `${col} = $${values.length}`; });
        const result = await pool.query(
          `SELECT ${state.cols} FROM public.${table}${where.length ? ` WHERE ${where.join(' AND ')}` : ''}`,
          values,
        );
        if (table === 'torneos' && flags.staleTorneoOnce) {
          flags.staleTorneoOnce = false;
          for (const row of result.rows) row.updated_at = '2000-01-01 00:00:00';
        }
        if (state.single && !state.optional && result.rows.length !== 1) {
          return { data: null, error: { message: 'Expected one row', code: 'PGRST116' } };
        }
        return { data: state.single ? (result.rows[0] ?? null) : result.rows, error: null };
      };
      const api = {
        select(cols) { state.cols = cols || '*'; return api; },
        eq(col, val) { state.filters.push([col, val]); return api; },
        single() { state.single = true; return exec(); },
        maybeSingle() { state.single = true; state.optional = true; return exec(); },
        then(resolve, reject) { return exec().then(resolve, reject); },
      };
      return api;
    },
    async rpc(name, args) {
      flags.rpcCalls += 1;
      const keys = Object.keys(args);
      const values = keys.map(key => {
        const value = args[key];
        return value !== null && typeof value === 'object' ? JSON.stringify(value) : value;
      });
      try {
        const result = await pool.query(
          `SELECT public.${name}(${keys.map((_, index) => `$${index + 1}`).join(',')}) AS data`,
          values,
        );
        return { data: result.rows[0].data, error: null };
      } catch (error) {
        return { data: null, error };
      }
    },
  };
}

const run = (command, args) => execFileSync(command, args, { encoding: 'utf8' });
let db;

if (BOOT) {
  assertSafeCierrePgTarget(HOST, PORT, DATABASE);
  temp = fs.mkdtempSync(path.join(os.tmpdir(), 'padbol-cierre-atomic-'));
  cluster = path.join(temp, 'data');
  try {
    run('initdb', ['-D', cluster, '-U', 'postgres', '--auth=trust', '--no-locale', '-E', 'UTF8']);
    run('pg_ctl', ['-D', cluster, '-o', `-p ${PORT} -c listen_addresses=${HOST} -c timezone=UTC`, '-l', path.join(temp, 'postgres.log'), 'start']);
    started = true;
    run('createdb', ['-h', HOST, '-p', String(PORT), '-U', 'postgres', DATABASE]);
    pool = new pg.Pool({ host: HOST, port: PORT, user: 'postgres', database: DATABASE, max: 8 });
    await pool.query(SCHEMA);
    const closureSql = fs.readFileSync(new URL('../../sql/candidates/20261122_finalizar_torneo_generico_atomico.sql', import.meta.url), 'utf8');
    await pool.query(closureSql);
    db = makeDb(pool);
    const express = (await import('express')).default;
    const { mountTournamentFinalizationRoute } = await import(new URL('../../routes/tournamentLifecycle.js', import.meta.url));
    const app = express();
    app.use(express.json());
    mountTournamentFinalizationRoute(app, {
      supabase: db,
      supabaseAdmin: db,
      requireTorneoAdminByTorneoId: async (req, res) => {
        const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
        if (token !== 'admin') {
          res.status(401).json({ error: 'Sesión requerida' });
          return null;
        }
        return { user: { id: '00000000-0000-4000-8000-0000000000a0' } };
      },
      actualizarRango: async () => { flags.rankUpdates += 1; },
      sendHttpError(res, error) { res.status(error.status ?? 500).json({ ok: false, error: error.message }); },
    });
    httpServer = app.listen(0, HOST);
    await new Promise(resolve => httpServer.once('listening', resolve));
  } catch (error) {
    if (started) { try { run('pg_ctl', ['-D', cluster, 'stop', '-m', 'immediate']); } catch {} }
    fs.rmSync(temp, { recursive: true, force: true });
    throw error;
  }
}

const it = pool ? test : test.skip;

after(async () => {
  if (httpServer) await new Promise(resolve => httpServer.close(resolve));
  if (pool) await pool.end().catch(() => {});
  if (started) { try { run('pg_ctl', ['-D', cluster, 'stop', '-m', 'immediate']); } catch {} }
  if (temp) fs.rmSync(temp, { recursive: true, force: true });
});

async function seed(torneoId = 1, { estado = 'en_curso', withLedger = false } = {}) {
  await pool.query('DELETE FROM test_failures');
  await pool.query('DELETE FROM test_suppressions');
  await pool.query('DELETE FROM tabla_puntos WHERE torneo_id = $1', [torneoId]);
  await pool.query('DELETE FROM partidos WHERE torneo_id = $1', [torneoId]);
  await pool.query('DELETE FROM equipos WHERE torneo_id = $1', [torneoId]);
  await pool.query('DELETE FROM torneos WHERE id = $1', [torneoId]);
  await pool.query('DELETE FROM config_puntos');
  await pool.query(
    `INSERT INTO torneos (id,nombre,nivel_torneo,tipo_torneo,estado,fecha_inicio,fecha_fin,cupos_maximos,deporte,modalidad_plantel)
     VALUES ($1,'Copa Atómica','club_no_oficial','knockout',$2,'2026-09-01','2026-09-30',8,'padbol','dobles')`,
    [torneoId, estado],
  );
  for (const id of [1, 2, 3, 4]) {
    await pool.query(
      'INSERT INTO equipos (id,torneo_id,nombre,jugadores,puntos_ranking) VALUES ($1,$2,$3,\'[]\'::jsonb,$4)',
      [id, torneoId, `Equipo ${id}`, withLedger ? 99 : 0],
    );
  }
  const matches = [
    { a: 1, b: 2, round: 1, pos: 1, ronda: 'semifinal', next: torneoId * 10 + 3, slot: 'A', result: { goles_a: 2, goles_b: 0 }, winner: 1, final: false },
    { a: 3, b: 4, round: 1, pos: 2, ronda: 'semifinal', next: torneoId * 10 + 3, slot: 'B', result: { goles_a: 2, goles_b: 0 }, winner: 3, final: false },
    { a: 1, b: 3, round: 2, pos: 1, ronda: 'final', next: null, slot: null, result: { goles_a: 0, goles_b: 2 }, winner: 3, final: true },
  ];
  let index = 1;
  for (const match of matches) {
    await pool.query(
      `INSERT INTO partidos (id,torneo_id,estado,equipo_a_id,equipo_b_id,ganador_equipo_id,grupo,bracket_round,bracket_position,ronda,partido_siguiente_id,partido_siguiente_slot,resultado,es_final)
       VALUES ($1,$2,'finalizado',$3,$4,$5,NULL,$6,$7,$8,$9,$10,$11::jsonb,$12)`,
      [torneoId * 10 + index++, torneoId, match.a, match.b, match.winner, match.round, match.pos, match.ronda, match.next, match.slot, JSON.stringify(match.result), match.final],
    );
  }
  if (withLedger) {
    for (const id of [1, 2, 3, 4]) {
      await pool.query('INSERT INTO tabla_puntos (torneo_id,equipo_id,posicion,puntos) VALUES ($1,$2,$3,99)', [torneoId, id, id]);
    }
  }
}

async function snapshot(torneoId = 1) {
  return {
    torneo: (await pool.query('SELECT id,estado,fecha_fin,updated_at FROM torneos WHERE id=$1', [torneoId])).rows[0],
    ledger: (await pool.query('SELECT equipo_id,posicion,puntos FROM tabla_puntos WHERE torneo_id=$1 ORDER BY equipo_id', [torneoId])).rows,
    equipos: (await pool.query('SELECT id,puntos_ranking FROM equipos WHERE torneo_id=$1 ORDER BY id', [torneoId])).rows,
  };
}

const expectedLedger = {
  1: { posicion: 2, puntos: 6 },
  2: { posicion: 3, puntos: 4 },
  3: { posicion: 1, puntos: 10 },
  4: { posicion: 4, puntos: 3 },
};
const expectedTeamPoints = { 1: 6, 2: 4, 3: 10, 4: 3 };
const ledgerMap = rows => Object.fromEntries(rows.map(row => [Number(row.equipo_id), { posicion: Number(row.posicion), puntos: Number(row.puntos) }]));
const teamMap = rows => Object.fromEntries(rows.map(row => [Number(row.id), Number(row.puntos_ranking)]));

async function post(torneoId = 1, token = 'admin') {
  const response = await fetch(`http://${HOST}:${httpServer.address().port}/api/torneos/${torneoId}/finalizar`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: '{}',
  });
  return { status: response.status, data: await response.json() };
}

it('éxito: ledger + equipos + estado del torneo se confirman en una sola transacción', async () => {
  await seed(1);
  const before = await snapshot(1);
  flags.rpcCalls = 0;
  flags.rankUpdates = 0;
  const response = await post(1);
  assert.equal(response.status, 200, JSON.stringify(response.data));
  assert.equal(response.data.torneo.estado, 'finalizado');
  assert.equal(response.data.torneo.fecha_fin, tournamentLocalDate({}, new Date()));
  assert.equal(response.data.clasificacion.length, 4);
  assert.ok(response.data.clasificacion.every(row => Object.hasOwn(row, 'equipo_nombre')));
  assert.deepEqual(response.data.clasificacion.map(row => Number(row.equipo_id)), [3, 1, 2, 4]);
  const after = await snapshot(1);
  assert.deepEqual(ledgerMap(after.ledger), expectedLedger);
  assert.deepEqual(teamMap(after.equipos), expectedTeamPoints);
  assert.equal(after.ledger.length, 4);
  assert.equal(after.torneo.estado, 'finalizado');
  assert.notEqual(after.torneo.updated_at, before.torneo.updated_at);
  assert.equal(flags.rpcCalls, 1);
  assert.equal(flags.rankUpdates, 0);
});

it('retry: devuelve el ledger inmutable aunque cambie la política global', async () => {
  await seed(1);
  assert.equal((await post(1)).status, 200);
  const ledgerBefore = JSON.stringify((await snapshot(1)).ledger);
  const torneoBefore = (await snapshot(1)).torneo;
  await pool.query('INSERT INTO config_puntos (clave,valor) VALUES (\'niveles\',$1::jsonb)', [JSON.stringify({ club_no_oficial: 999 })]);
  const retry = await post(1);
  assert.equal(retry.status, 200, JSON.stringify(retry.data));
  assert.equal(retry.data.status, 'idempotent');
  assert.equal(retry.data.source, 'historical_ledger');
  assert.equal(retry.data.clasificacion.length, 4);
  assert.equal(JSON.stringify((await snapshot(1)).ledger), ledgerBefore);
  assert.deepEqual((await snapshot(1)).torneo, torneoBefore);
});

it('concurrencia: dos cierres simultáneos se serializan y no duplican el ledger', async () => {
  await seed(1);
  flags.rpcCalls = 0;
  // Hold the tournament row so both real HTTP closures block inside the RPC:
  // the test proves the row lock, not just a request that arrives late.
  const blocker = await pool.connect();
  let pending;
  let observed = 0;
  try {
    await blocker.query('BEGIN');
    await blocker.query('SELECT id FROM torneos WHERE id = 1 FOR UPDATE');
    pending = Promise.all([post(1), post(1)]);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const { rows } = await pool.query(
        "SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE '%finalizar_torneo_generico%'",
      );
      observed = rows[0].n;
      if (observed >= 2) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    await blocker.query('COMMIT');
  } finally {
    try { await blocker.query('ROLLBACK'); } catch {}
    blocker.release();
  }
  const [first, second] = await pending;
  assert.ok(observed >= 2, `expected two lock waiters, observed ${observed}`);
  assert.equal(first.status, 200, JSON.stringify(first.data));
  assert.equal(second.status, 200, JSON.stringify(second.data));
  assert.equal([first, second].filter(response => response.data.status === 'idempotent').length, 1);
  const after = await snapshot(1);
  assert.equal(after.torneo.estado, 'finalizado');
  assert.deepEqual(ledgerMap(after.ledger), expectedLedger);
  assert.deepEqual(teamMap(after.equipos), expectedTeamPoints);
  assert.equal(after.ledger.length, 4);
  assert.equal(flags.rpcCalls, 2);
});

it('CAS: una lectura vieja devuelve 409 y no escribe nada', async () => {
  await seed(1);
  const before = await snapshot(1);
  flags.staleTorneoOnce = true;
  flags.rpcCalls = 0;
  const response = await post(1);
  flags.staleTorneoOnce = false;
  assert.equal(response.status, 409, JSON.stringify(response.data));
  assert.equal(response.data.code, 'TORNEO_CHANGED_RETRY');
  assert.equal(flags.rpcCalls, 1);
  assert.deepEqual(await snapshot(1), before);
});

for (const phase of ['ledger', 'teams', 'tournament']) {
  it(`fallo inyectado en ${phase}: rollback total, sin mutaciones parciales`, async () => {
    await seed(1, { withLedger: true });
    const before = await snapshot(1);
    assert.equal(before.ledger.length, 4);
    await pool.query('INSERT INTO test_failures (phase) VALUES ($1)', [phase]);
    const response = await post(1);
    assert.equal(response.status, 503, JSON.stringify(response.data));
    assert.deepEqual(await snapshot(1), before);
    await pool.query('DELETE FROM test_failures');
  await pool.query('DELETE FROM test_suppressions');
  });
}

it('retry después de un fallo inyectado cierra correctamente', async () => {
  await seed(1, { withLedger: true });
  await pool.query("INSERT INTO test_failures (phase) VALUES ('ledger')");
  assert.equal((await post(1)).status, 503);
  await pool.query('DELETE FROM test_failures');
  await pool.query('DELETE FROM test_suppressions');
  const retry = await post(1);
  assert.equal(retry.status, 200, JSON.stringify(retry.data));
  assert.deepEqual(ledgerMap((await snapshot(1)).ledger), expectedLedger);
});

it('supresión silenciosa de una fila del ledger: RAISE dentro del RPC y rollback total', async () => {
  await seed(1, { withLedger: true });
  const before = await snapshot(1);
  await pool.query("INSERT INTO test_suppressions (phase,equipo_id) VALUES ('ledger',1)");
  const response = await post(1);
  assert.equal(response.status, 503, JSON.stringify(response.data));
  assert.deepEqual(await snapshot(1), before);
  await pool.query('DELETE FROM test_suppressions');
  const retry = await post(1);
  assert.equal(retry.status, 200, JSON.stringify(retry.data));
  assert.deepEqual(ledgerMap((await snapshot(1)).ledger), expectedLedger);
});

it('supresión silenciosa del UPDATE torneos: RAISE dentro del RPC y rollback total', async () => {
  await seed(1, { withLedger: true });
  const before = await snapshot(1);
  await pool.query("INSERT INTO test_suppressions (phase) VALUES ('tournament')");
  const response = await post(1);
  assert.equal(response.status, 503, JSON.stringify(response.data));
  assert.deepEqual(await snapshot(1), before);
  await pool.query('DELETE FROM test_suppressions');
});

it('mutación silenciosa de puntos del ledger: RAISE y rollback total', async () => {
  await seed(1, { withLedger: true });
  const before = await snapshot(1);
  await pool.query("INSERT INTO test_suppressions (phase) VALUES ('ledger_value')");
  const response = await post(1);
  assert.equal(response.status, 503, JSON.stringify(response.data));
  assert.deepEqual(await snapshot(1), before);
  await pool.query('DELETE FROM test_suppressions');
});

it('mutación silenciosa de fecha_fin del torneo: RAISE y rollback total', async () => {
  await seed(1, { withLedger: true });
  const before = await snapshot(1);
  await pool.query("INSERT INTO test_suppressions (phase) VALUES ('tournament_value')");
  const response = await post(1);
  assert.equal(response.status, 503, JSON.stringify(response.data));
  assert.deepEqual(await snapshot(1), before);
  await pool.query('DELETE FROM test_suppressions');
});

it('snapshot inválido (posiciones duplicadas) se rechaza sin escribir', async () => {
  await seed(1);
  const before = await snapshot(1);
  const torneo = (await pool.query('SELECT * FROM torneos WHERE id=1')).rows[0];
  const equipos = (await pool.query('SELECT * FROM equipos WHERE torneo_id=1')).rows;
  const tampered = [
    { torneo_id: 1, equipo_id: 1, posicion: 1, puntos: 5 },
    { torneo_id: 1, equipo_id: 2, posicion: 1, puntos: 5 },
    { torneo_id: 1, equipo_id: 3, posicion: 2, puntos: 4 },
    { torneo_id: 1, equipo_id: 4, posicion: 3, puntos: 3 },
  ];
  await assert.rejects(
    persistGenericTournamentClosure(db, { torneo, equipos, puntosData: tampered, fechaFin: '2026-11-22' }),
    error => error.status === 409 && error.code === 'TORNEO_CLOSURE_ATOMIC_UNCONFIRMED',
  );
  assert.deepEqual(await snapshot(1), before);
});

it('histórico incompleto: no recalcula ni completa el ledger cerrado', async () => {
  await seed(1, { estado: 'finalizado' });
  await pool.query("INSERT INTO tabla_puntos (torneo_id,equipo_id,posicion,puntos) VALUES (1,1,1,10),(1,2,2,6)");
  const before = await snapshot(1);
  const response = await post(1);
  assert.equal(response.status, 409);
  assert.equal(response.data.code, 'TORNEO_HISTORICAL_LEDGER_INCOMPLETE');
  assert.deepEqual(await snapshot(1), before);
});

it('permisos: sin sesión no hay RPC; anon/authenticated no pueden ejecutar y service_role sí', async () => {
  await seed(1);
  const before = await snapshot(1);
  flags.rpcCalls = 0;
  const unauthorized = await post(1, null);
  assert.equal(unauthorized.status, 401);
  assert.equal(flags.rpcCalls, 0);
  assert.deepEqual(await snapshot(1), before);

  const client = await pool.connect();
  try {
    for (const role of ['anon', 'authenticated']) {
      await client.query(`SET ROLE ${role}`);
      await assert.rejects(
        client.query("SELECT public.finalizar_torneo_generico(1::bigint,'en_curso'::text,NULL::timestamp,'2026-11-22'::date,'[]'::jsonb)"),
        error => error.code === '42501',
        role,
      );
      await client.query('RESET ROLE');
    }
    await client.query('SET ROLE service_role');
    const granted = await client.query(
      "SELECT public.finalizar_torneo_generico(999::bigint,'en_curso'::text,NULL::timestamp,'2026-11-22'::date,'[]'::jsonb) AS data",
    );
    assert.equal(granted.rows[0].data.ok, false);
    assert.equal(granted.rows[0].data.status, 'not_found');
    await client.query('RESET ROLE');
  } finally {
    try { await client.query('RESET ROLE'); } catch {}
    client.release();
  }
  assert.deepEqual(await snapshot(1), before);
});
