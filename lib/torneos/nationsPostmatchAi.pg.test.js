import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import pg from 'pg';
import express from 'express';
import { enqueueNationsPostmatchForPartido, processOneNationsPostmatchJob, recoverStaleNationsPostmatchJobs } from './nationsPostmatchAi.js';
import { mountNationsPostmatchRoutes } from './nationsPostmatchRoutes.js';

const CS = process.env.NATIONS_POSTMATCH_PG_URL;
const it = CS ? test : test.skip;
const U = (n) => `77000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const BOARD = U(1), TEAM_A = 101, TEAM_B = 102, MATCH = 77, EVENT = 9, USER = U(9);
const provider = () => ({ name: 'stub', calls: 0, lastPayload: '', async completeChat({ userMessage }) { this.calls += 1; this.lastPayload = userMessage; const p = JSON.parse(userMessage); return { reply: JSON.stringify({ title: 'Nations', summary: `Resultado ${p.marcador.a}-${p.marcador.b}; A1 y Equipo A compitieron.`, highlights: [{ type: 'stats', text: `Puntos observados: ${p.observed.team_totals.A.points}-${p.observed.team_totals.B.points}.` }], disclaimers: ['Sólo stats registradas.'] }) }; } });

function guard(url) {
  const [before, query = ''] = String(url || '').split('?'); const params = new URLSearchParams(query);
  const host = params.get('host') || (/^postgres(?:ql)?:\/\/[^@/]*\/+([^/:]+)/.exec(before)?.[1] ?? '');
  const db = decodeURIComponent(before.split('/').at(-1) || '');
  if (!['/tmp', '127.0.0.1', 'localhost'].includes(host) || db !== 'nations_postmatch_ai_test') throw Error('REFUSE_NON_LOCAL_POSTMATCH_PG');
}

async function fixture({ noPoints = false } = {}) {
  guard(CS);
  const gate = new pg.Client({ connectionString: CS }); await gate.connect(); await gate.query('SELECT pg_advisory_lock(918274)');
  const pool = new pg.Pool({ connectionString: CS, max: 4 });
  await pool.query('DROP SCHEMA IF EXISTS nations_postmatch_ai CASCADE; DROP SCHEMA IF EXISTS nations_marker_private CASCADE; DROP TABLE IF EXISTS scoreboard_historial_puntos, scoreboard_partidos, torneo_partido_alineaciones, equipos, partidos, torneos, sedes, canchas CASCADE');
  await pool.query(`CREATE TABLE sedes(id bigint PRIMARY KEY,nombre text); INSERT INTO sedes VALUES(3,'Sede'); CREATE TABLE canchas(id bigint,sede_id bigint,nombre text,orden integer);
  CREATE TABLE torneos(id bigint PRIMARY KEY,sede_id bigint,modalidad_plantel text,deporte text,plan_nations jsonb); INSERT INTO torneos VALUES(9,3,'selecciones','padbol','{"roster_publication_approved":true}');
  CREATE TABLE partidos(id bigint PRIMARY KEY,torneo_id bigint,equipo_a_id bigint,equipo_b_id bigint); INSERT INTO partidos VALUES(77,9,101,102);
  CREATE TABLE equipos(id bigint PRIMARY KEY,torneo_id bigint,creador_id uuid,jugadores jsonb,inscripcion_estado text);
  CREATE TABLE torneo_partido_alineaciones(torneo_id bigint,partido_id bigint,equipo_id bigint,iniciales jsonb,suplentes jsonb,revision bigint);
  CREATE TABLE scoreboard_partidos(id uuid PRIMARY KEY,partido_torneo_id bigint,sede_id bigint,torneo_id bigint,cancha text,estado text,cronometro_inicio timestamptz,cronometro_pausado boolean,cronometro_segundos integer,updated_at timestamptz,score_a integer,score_b integer,games_a integer,games_b integer,sets_a integer,sets_b integer,historial_sets jsonb DEFAULT '[]',equipo_a_nombre text,equipo_b_nombre text,equipo_a_jugadores jsonb,equipo_b_jugadores jsonb);
  CREATE TABLE scoreboard_historial_puntos(id uuid DEFAULT gen_random_uuid() PRIMARY KEY,partido_id uuid,timestamp timestamptz,equipo text);
  CREATE SCHEMA nations_marker_private;
  CREATE TABLE nations_marker_private.nations_marker_match(match_id text PRIMARY KEY,revision integer,states jsonb,tracking_status text,games_ledger jsonb);
  CREATE TABLE nations_marker_private.games_finalization_intents(scoreboard_id uuid,status text);
  `);
  await pool.query(fs.readFileSync(new URL('../../sql/migrations/20261115_nations_postmatch_ai.sql', import.meta.url), 'utf8'));
  const roster = (team, start) => Array.from({ length: 3 }, (_, i) => ({ user_id: U(start + i), nombre: `Jugador ${team}-${i + 1}`, estado: 'confirmado' }));
  const a = roster(101, 1), b = roster(102, 11);
  for (const [team, list] of [[101, a], [102, b]]) {
    await pool.query('INSERT INTO equipos VALUES($1,9,$2,$3,$4)', [team, USER, JSON.stringify(list), 'confirmado']);
    await pool.query('INSERT INTO torneo_partido_alineaciones VALUES(9,77,$1,$2,$3,1)', [team, JSON.stringify(list.slice(0, 2).map((p) => p.user_id)), JSON.stringify(list.slice(2).map((p) => p.user_id))]);
  }
  const start = '2026-11-15T10:00:00.000Z';
  const states = {
    101: { status: 'closed', startedAt: Date.parse(start), active: [a[2].user_id, a[1].user_id], lineup: { iniciales: [a[0].user_id, a[1].user_id], suplentes: [a[2].user_id] }, roster: a.map((p) => p.user_id), events: [{ type: 'substitution', outId: a[0].user_id, inId: a[2].user_id, serverAt: Date.parse('2026-11-15T10:01:00.000Z') }] },
    102: { status: 'closed', startedAt: Date.parse(start), active: [b[0].user_id, b[1].user_id], lineup: { iniciales: [b[0].user_id, b[1].user_id], suplentes: [b[2].user_id] }, roster: b.map((p) => p.user_id), events: [] },
  };
  await pool.query(`INSERT INTO scoreboard_partidos(id,partido_torneo_id,sede_id,torneo_id,cancha,estado,updated_at,score_a,score_b,games_a,games_b,sets_a,sets_b,historial_sets,equipo_a_nombre,equipo_b_nombre,equipo_a_jugadores,equipo_b_jugadores)
    VALUES($1,77,3,9,'1','finalizado',$2,1,0,1,0,0,0,'[]','Equipo A','Equipo B',$3,$4)`, [BOARD, '2026-11-15T10:02:00Z', JSON.stringify(a), JSON.stringify(b)]);
  if (!noPoints) await pool.query(`INSERT INTO scoreboard_historial_puntos(partido_id,timestamp,equipo) VALUES($1,'2026-11-15T10:01:00Z','A')`, [BOARD]);
  await pool.query('INSERT INTO nations_marker_private.nations_marker_match VALUES($1,1,$2,$3,$4)', [BOARD, JSON.stringify(states), 'active', JSON.stringify({ version: 1, total: 1, events: [], active: [] })]);
  await pool.query('INSERT INTO nations_marker_private.games_finalization_intents VALUES($1,$2)', [BOARD, 'completed']);
  return { pool, async close() { await pool.end(); await gate.query('SELECT pg_advisory_unlock(918274)'); await gate.end(); } };
}

it('enqueue + worker generates ready summary once; exact swap timestamp is half-open and no PII', async () => {
  const f = await fixture();
  try {
    const enq = await enqueueNationsPostmatchForPartido({ pool: f.pool, torneoId: EVENT, partidoId: MATCH });
    assert.equal(enq.status, 'queued');
    const stub = provider();
    const first = await processOneNationsPostmatchJob({ pool: f.pool, provider: stub });
    assert.equal(first.status, 'ready'); assert.equal(stub.calls, 1);
    const row = (await f.pool.query('SELECT status,summary,observed FROM nations_postmatch_ai.jobs WHERE scoreboard_id=$1', [BOARD])).rows[0];
    assert.equal(row.status, 'ready'); assert(!stub.lastPayload.includes('Jugador')); assert(!stub.lastPayload.includes('77000000-')); assert(row.summary.summary.includes('Jugador 101-2')); assert.equal(row.observed.players.find((p) => p.name === 'Jugador 101-1').points_observed, 0);
    assert.equal(row.observed.players.find((p) => p.name === 'Jugador 101-3').points_observed, 1);
    assert.equal(JSON.stringify(row.observed).includes('77000000-'), false);
    const second = await processOneNationsPostmatchJob({ pool: f.pool, provider: stub });
    assert.equal(second.status, 'idle'); assert.equal(stub.calls, 1);
  } finally { await f.close(); }
});

it('provider uncertainty is explicit and never retried automatically', async () => {
  const f = await fixture();
  try {
    await enqueueNationsPostmatchForPartido({ pool: f.pool, torneoId: EVENT, partidoId: MATCH });
    const stub = { name: 'stub', calls: 0, async completeChat() { this.calls += 1; throw Error('timeout'); } };
    const first = await processOneNationsPostmatchJob({ pool: f.pool, provider: stub });
    assert.equal(first.status, 'uncertain');
    await recoverStaleNationsPostmatchJobs({ pool: f.pool });
    const second = await processOneNationsPostmatchJob({ pool: f.pool, provider: stub });
    assert.equal(second.status, 'idle'); assert.equal(stub.calls, 1);
  } finally { await f.close(); }
});

it('missing observed points is explicit insufficient, never invented', async () => {
  const f = await fixture({ noPoints: true });
  try {
    await enqueueNationsPostmatchForPartido({ pool: f.pool, torneoId: EVENT, partidoId: MATCH });
    const out = await processOneNationsPostmatchJob({ pool: f.pool, provider: provider() });
    assert.equal(out.status, 'insufficient');
    const row = (await f.pool.query('SELECT status,error_code FROM nations_postmatch_ai.jobs WHERE scoreboard_id=$1', [BOARD])).rows[0];
    assert.equal(row.status, 'insufficient'); assert.equal(row.error_code, 'NATIONS_POSTMATCH_INSUFFICIENT_DATA');
  } finally { await f.close(); }
});

it('authenticated route returns ready summary only to participant', async () => {
  const f = await fixture();
  try {
    await enqueueNationsPostmatchForPartido({ pool: f.pool, torneoId: EVENT, partidoId: MATCH });
    await processOneNationsPostmatchJob({ pool: f.pool, provider: provider() });
    const tables = {
      partidos: { id: 77, torneo_id: 9, equipo_a_id: 101, equipo_b_id: 102 },
      torneos: { id: 9, sede_id: 3, plan_nations: { roster_publication_approved: true, config: { reveal_at: '2000-01-01T00:00:00Z' } }, modalidad_plantel: 'selecciones', fecha_inicio: '2026-11-15', horas_revelar_equipos: 48 },
      equipos: [{ id: 101, torneo_id: 9, creador_id: USER, jugadores: [] }, { id: 102, torneo_id: 9, creador_id: null, jugadores: [] }],
      nations_activation_events: { torneo_id: 9, roster_publication_approved: true },
    };
    const supabaseAdmin = { from(table) {
      const rows = Array.isArray(tables[table]) ? tables[table] : (tables[table] ? [tables[table]] : []);
      const q = { select: () => q, eq: (k, v) => { for (let i = rows.length - 1; i >= 0; i--) if (String(rows[i]?.[k]) !== String(v)) rows.splice(i, 1); return q; }, maybeSingle: async () => ({ data: rows[0] ?? null, error: null }), then: (resolve) => Promise.resolve({ data: rows, error: null }).then(resolve) };
      return q;
    } };
    const app = express();
    mountNationsPostmatchRoutes(app, { pool: f.pool, supabaseAdmin, enabled: true, getRole: async () => null, getAuthenticatedUser: async (req) => req.headers['x-user'] === 'participant' ? { user: { id: USER } } : req.headers['x-user'] === 'spectator' ? { user: { id: U(99) } } : { user: null, status: 401 } });
    const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    try {
      const base = `http://127.0.0.1:${server.address().port}/api/nations/partidos/${BOARD}/resumen`;
      assert.equal((await fetch(base)).status, 401);
      const ok = await fetch(base, { headers: { 'x-user': 'participant' } }); assert.equal(ok.status, 200);
      const body = await ok.json(); assert.equal(body.state, 'ready'); assert.equal(JSON.stringify(body).includes('77000000-'), false);
      const spectator = await fetch(base, { headers: { 'x-user': 'spectator' } }); assert.equal(spectator.status, 200);
    } finally { await new Promise((r) => { server.close(r); server.closeAllConnections(); }); }
  } finally { await f.close(); }
});
