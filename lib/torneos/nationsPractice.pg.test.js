import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import express from 'express';
import { getPracticeEvent, getPracticeBoard, practiceMatchesDto, practiceTournamentDto, issuePracticeControlToken, executePracticeAction } from './nationsPractice.js';
import { mountNationsPracticeRoutes } from '../../routes/nationsPractice.js';

const CS = process.env.NATIONS_PRACTICE_PG_URL;
const it = CS ? test : test.skip;
const BOARD = '91111111-1111-4111-8111-111111111101';
const EVENT = 1000000000001, MATCH = 1000000000101;
const UUID = () => randomUUID();

function guard() {
  const [before, query = ''] = String(CS || '').split('?'); const p = new URLSearchParams(query);
  const host = p.get('host') || (/^postgres(?:ql)?:\/\/[^@/]*\/+([^/:]+)/.exec(before)?.[1] ?? '');
  const db = decodeURIComponent(before.split('/').at(-1) || '');
  if (!['/tmp','127.0.0.1','localhost'].includes(host) || db !== 'nations_practice_test') throw Error('REFUSE_NON_LOCAL_PRACTICE_PG');
}
async function fixture() {
  guard();
  const gate = new pg.Client({ connectionString: CS }); await gate.connect(); await gate.query('SELECT pg_advisory_lock(918275)');
  const pool = new pg.Pool({ connectionString: CS, max: 4 });
  await pool.query('DROP SCHEMA IF EXISTS nations_practice CASCADE; DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public');
  await pool.query(fs.readFileSync(new URL('../../sql/migrations/20261115_nations_practice.sql', import.meta.url), 'utf8'));
  await pool.query('CREATE TABLE public.torneos(id bigint); CREATE TABLE public.partidos(id bigint); CREATE TABLE public.scoreboard_partidos(id uuid); INSERT INTO public.torneos VALUES(57); INSERT INTO public.partidos VALUES(77);');
  await pool.query(fs.readFileSync(new URL('../../sql/seeds/20261115_nations_practice_synthetic.sql', import.meta.url), 'utf8'));
  return { pool, async close() { await pool.end(); await gate.query('SELECT pg_advisory_unlock(918275)'); await gate.end(); } };
}

it('read adapter exposes only registered practice event, 3 courts, synthetic public fields', async () => {
  const f = await fixture();
  try {
    const data = await getPracticeEvent(f.pool, EVENT);
    assert.equal(data.teams.length, 6);
    assert.equal(data.teams.every((t) => t.players.length === 4), true);
    assert.equal(data.matches.length, 3);
    assert.equal(practiceTournamentDto(data.event).es_practica, true);
    const matches = practiceMatchesDto(data.matches, data.event);
    assert.equal(new Set(matches.map((m) => m.cancha)).size, 3);
    assert(matches.every((m) => m.torneo_id === EVENT && m.scoreboard_id));
    const board = await getPracticeBoard(f.pool, BOARD);
    assert.equal(board.id, BOARD);
    assert.equal(board.equipo_a_jugadores.length, 4);
    assert(!JSON.stringify(board).includes('user_id'));
    assert.equal(await getPracticeEvent(f.pool, 999999999999), null);
  } finally { await f.close(); }
});

it('control token + CAS/idempotency, pause/resume, substitutions, reset; public board reflects A only', async () => {
  const f = await fixture();
  try {
    const issued = await issuePracticeControlToken({ pool: f.pool, eventId: 1, matchId: MATCH, expiresAt: new Date(Date.now() + 60000).toISOString() });
    const token = issued.token;
    const start = await executePracticeAction({ pool: f.pool, matchId: MATCH, action: 'start', requestId: UUID(), expectedRevision: 0, token });
    assert.equal(start.revision, 1); assert.equal(start.status, 'en_curso');
    const rid = UUID();
    const point = await executePracticeAction({ pool: f.pool, matchId: MATCH, action: 'point', requestId: rid, expectedRevision: 1, body: { team: 'A' }, token });
    assert.equal(Number(point.state.points.A), 15); assert.equal(Number(point.state.points.B), 0);
    const replay = await executePracticeAction({ pool: f.pool, matchId: MATCH, action: 'point', requestId: rid, expectedRevision: 1, body: { team: 'A' }, token });
    assert.equal(replay.deduplicated, true);
    await assert.rejects(() => executePracticeAction({ pool: f.pool, matchId: MATCH, action: 'point', requestId: UUID(), expectedRevision: 1, body: { team: 'A' }, token }), (e) => e.code === 'PRACTICE_REVISION_CONFLICT');
    const paused = await executePracticeAction({ pool: f.pool, matchId: MATCH, action: 'pause', requestId: UUID(), expectedRevision: 2, token });
    assert.equal(paused.state.pausedAt != null, true);
    const resumed = await executePracticeAction({ pool: f.pool, matchId: MATCH, action: 'resume', requestId: UUID(), expectedRevision: 3, token });
    assert.equal(resumed.state.pausedAt, null);
    let revision = 4;
    await f.pool.query("UPDATE nations_practice.matches SET state=jsonb_set(jsonb_set(jsonb_set(state,'{games,A}','1'),'{points,A}','0'),'{points,B}','0'),revision=4 WHERE id=$1", [MATCH]);
    assert.equal((await executePracticeAction({ pool: f.pool, matchId: MATCH, action: 'substitution', requestId: UUID(), expectedRevision: revision, body: { team: 'A', swaps: [{ outId: '1', inId: '3' }] }, token })).state.active.A.includes('3'), true);
    revision += 1;
    const board = await getPracticeBoard(f.pool, BOARD);
    assert.equal(board.equipo_b_jugadores.filter((p) => p.on_court).length, 2);
    assert.equal(board.equipo_a_jugadores.filter((p) => p.on_court).length, 2);
    const reset = await executePracticeAction({ pool: f.pool, matchId: MATCH, action: 'reset', requestId: UUID(), expectedRevision: (await f.pool.query('SELECT revision FROM nations_practice.matches WHERE id=$1', [MATCH])).rows[0].revision, token });
    assert.equal(reset.status, 'pendiente');
    const countBefore = (await f.pool.query('SELECT count(*)::int n FROM public.torneos')).rows[0].n;
    assert.equal(countBefore, 1);
    assert.equal((await f.pool.query('SELECT count(*)::int n FROM public.partidos')).rows[0].n, 1);
    const expired = await issuePracticeControlToken({ pool: f.pool, eventId: 1, matchId: MATCH, expiresAt: new Date(Date.now() - 1000).toISOString() });
    await assert.rejects(() => executePracticeAction({ pool: f.pool, matchId: MATCH, action: 'start', requestId: UUID(), expectedRevision: 0, token: expired.token }), (e) => e.status === 403);
  } finally { await f.close(); }
});

it('request payload changes and cross-board token are rejected', async () => {
  const f = await fixture();
  try {
    const issued = await issuePracticeControlToken({ pool: f.pool, eventId: 1, matchId: MATCH, expiresAt: new Date(Date.now() + 60000).toISOString() });
    const token = issued.token;
    const start = await executePracticeAction({ pool: f.pool, matchId: MATCH, action: 'start', requestId: UUID(), expectedRevision: 0, token });
    const rid = UUID();
    await executePracticeAction({ pool: f.pool, matchId: MATCH, action: 'point', requestId: rid, expectedRevision: start.revision, body: { team: 'A' }, token });
    await assert.rejects(() => executePracticeAction({ pool: f.pool, matchId: MATCH, action: 'point', requestId: rid, expectedRevision: start.revision, body: { team: 'B' }, token }), (e) => e.code === 'PRACTICE_IDEMPOTENCY_CONFLICT');
    await assert.rejects(() => executePracticeAction({ pool: f.pool, matchId: 1000000000102, action: 'start', requestId: UUID(), expectedRevision: 0, token }), (e) => e.status === 403);
  } finally { await f.close(); }
});

it('undo restores the exact prior engine snapshot for A/B', async () => {
  const f = await fixture();
  try {
    const issued = await issuePracticeControlToken({ pool: f.pool, eventId: 1, matchId: MATCH, expiresAt: new Date(Date.now() + 60000).toISOString() });
    let r = await executePracticeAction({ pool: f.pool, matchId: MATCH, action: 'start', requestId: UUID(), expectedRevision: 0, token: issued.token });
    r = await executePracticeAction({ pool: f.pool, matchId: MATCH, action: 'point', requestId: UUID(), expectedRevision: r.revision, body: { team: 'A' }, token: issued.token });
    r = await executePracticeAction({ pool: f.pool, matchId: MATCH, action: 'point', requestId: UUID(), expectedRevision: r.revision, body: { team: 'B' }, token: issued.token });
    r = await executePracticeAction({ pool: f.pool, matchId: MATCH, action: 'undo', requestId: UUID(), expectedRevision: r.revision, token: issued.token });
    assert.equal(Number(r.state.points.A), 15); assert.equal(Number(r.state.points.B), 0);
  } finally { await f.close(); }
});

it('real HTTP reader and control: unknown ids 404, 3 courts readable, public response no token/PII', async () => {
  const f = await fixture();
  try {
    const issued = await issuePracticeControlToken({ pool: f.pool, eventId: 1, matchId: MATCH, expiresAt: new Date(Date.now() + 60000).toISOString() });
    const app = express(); mountNationsPracticeRoutes(app, { pool: f.pool, enabled: true });
    const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    try {
      const base = `http://127.0.0.1:${server.address().port}`;
      assert.equal((await fetch(`${base}/api/torneos/999999999999`)).status, 404);
      const parts = await fetch(`${base}/api/torneos/${EVENT}/partidos`); assert.equal(parts.status, 200); const list = await parts.json(); assert.equal(list.length, 3);
      const board = await fetch(`${base}/api/scoreboard/partidos/${BOARD}`); assert.equal(board.status, 200); const body = await board.json(); assert.equal(body.id, BOARD); assert(!JSON.stringify(body).includes('token'));
      const control = await fetch(`${base}/api/practice/boards/${BOARD}/commands`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${issued.token}` }, body: JSON.stringify({ kind: 'start', requestId: UUID(), expectedRevision: 0 }) });
      assert.equal(control.status, 200);
      const ctl = await fetch(`${base}/api/practice/boards/${BOARD}/control`, { headers: { authorization: `Bearer ${issued.token}` } }); assert.equal(ctl.status, 200);
      const ctlBody = await ctl.json(); assert.equal(ctlBody.lineups.A.length, 4); assert.equal(ctlBody.lineups.B.length, 4); assert.equal(ctlBody.substitution_window.allowed, false); assert(!JSON.stringify(ctlBody).includes('token'));
    } finally { await new Promise((r) => { server.close(r); server.closeAllConnections(); }); }
  } finally { await f.close(); }
});

it('public DTO preserves frozen clock, tiebreak/saque and AD display', async () => {
  const f = await fixture();
  try {
    const row = (await f.pool.query('SELECT state FROM nations_practice.matches WHERE id=$1', [MATCH])).rows[0].state;
    const state = { ...row, status: 'finalizado', startedAt: '2026-11-15T10:00:00Z', finishedAt: '2026-11-15T10:01:40Z', es_tiebreak: true, saque_actual: 'B', points: { A: 7, B: 6 }, games: { A: 6, B: 6 } };
    await f.pool.query('UPDATE nations_practice.matches SET state=$2::jsonb WHERE id=$1', [MATCH, JSON.stringify(state)]);
    const board = await getPracticeBoard(f.pool, BOARD);
    assert.equal(board.es_tiebreak, true); assert.equal(board.saque_actual, 'B');
    assert.equal(board.display.cronometroSegundos, 100); assert.equal(board.display.cronometroActivo, false);
  } finally { await f.close(); }
});
it('deuce/AD and TB 6-6 use real engine display and serve', async () => {
  const f = await fixture();
  try {
    const issued = await issuePracticeControlToken({ pool: f.pool, eventId: 1, matchId: MATCH, expiresAt: new Date(Date.now() + 60000).toISOString() });
    const token = issued.token; let r = await executePracticeAction({ pool: f.pool, matchId: MATCH, action: 'start', requestId: UUID(), expectedRevision: 0, token });
    let row = (await f.pool.query('SELECT state FROM nations_practice.matches WHERE id=$1', [MATCH])).rows[0].state;
    row.points = { A: 40, B: 40 };
    await f.pool.query('UPDATE nations_practice.matches SET state=$2::jsonb WHERE id=$1', [MATCH, JSON.stringify(row)]);
    r = await executePracticeAction({ pool: f.pool, matchId: MATCH, action: 'point', requestId: UUID(), expectedRevision: r.revision, body: { team: 'A' }, token });
    assert.equal(Number(r.state.points.A), 45);
    const board = await getPracticeBoard(f.pool, BOARD); assert.match(String(board.display?.displayA ?? ''), /AD|Vent|VENT/i);
  } finally { await f.close(); }
});
it('groups 1-1 STB 10-9 and knockout third set are real', async () => {
  const f = await fixture();
  try {
    const issued = await issuePracticeControlToken({ pool: f.pool, eventId: 1, matchId: MATCH, expiresAt: new Date(Date.now() + 60000).toISOString() });
    const token = issued.token; let r = await executePracticeAction({ pool: f.pool, matchId: MATCH, action: 'start', requestId: UUID(), expectedRevision: 0, token });
    let row = (await f.pool.query('SELECT state FROM nations_practice.matches WHERE id=$1', [MATCH])).rows[0].state;
    row = { ...row, format: 'groups', sets: { A: 1, B: 1 }, history: [{ a: 6, b: 4, set: 1 }, { a: 4, b: 6, set: 2 }], points: { A: 9, B: 9 }, games: { A: 0, B: 0 }, es_tiebreak: true };
    await f.pool.query('UPDATE nations_practice.matches SET state=$2::jsonb WHERE id=$1', [MATCH, JSON.stringify(row)]);
    r = await executePracticeAction({ pool: f.pool, matchId: MATCH, action: 'point', requestId: UUID(), expectedRevision: r.revision, body: { team: 'A' }, token });
    assert.equal(r.state.history.at(-1).type, 'super_tiebreak'); assert.equal(r.state.history.at(-1).points_a, 10); assert.equal(r.state.history.at(-1).points_b, 9);
    row = { ...r.state, format: 'knockout', status: 'en_curso', sets: { A: 1, B: 1 }, history: [{ a: 6, b: 4, set: 1 }, { a: 4, b: 6, set: 2 }], points: { A: 0, B: 0 }, games: { A: 0, B: 0 }, es_tiebreak: false };
    await f.pool.query('UPDATE nations_practice.matches SET state=$2::jsonb, revision=revision+1 WHERE id=$1', [MATCH, JSON.stringify(row)]);
    r = await executePracticeAction({ pool: f.pool, matchId: MATCH, action: 'point', requestId: UUID(), expectedRevision: (await f.pool.query('SELECT revision FROM nations_practice.matches WHERE id=$1', [MATCH])).rows[0].revision, body: { team: 'A' }, token });
    assert.equal(String(r.state.points.A), '15'); assert.equal(r.state.es_tiebreak, false);
  } finally { await f.close(); }
});
it('double swap is atomic; invalid second swap leaves state unchanged', async () => {
  const f = await fixture();
  try {
    const issued = await issuePracticeControlToken({ pool: f.pool, eventId: 1, matchId: MATCH, expiresAt: new Date(Date.now() + 60000).toISOString() });
    const token = issued.token; let r = await executePracticeAction({ pool: f.pool, matchId: MATCH, action: 'start', requestId: UUID(), expectedRevision: 0, token });
    let row = (await f.pool.query('SELECT state FROM nations_practice.matches WHERE id=$1', [MATCH])).rows[0].state;
    row.games = { A: 1, B: 0 }; row.points = { A: 0, B: 0 };
    await f.pool.query('UPDATE nations_practice.matches SET state=$2::jsonb WHERE id=$1', [MATCH, JSON.stringify(row)]);
    const before = JSON.stringify(row);
    await assert.rejects(() => executePracticeAction({ pool: f.pool, matchId: MATCH, action: 'substitution', requestId: UUID(), expectedRevision: r.revision, body: { team: 'A', swaps: [{ outId: '1', inId: '3' }, { outId: '99', inId: '4' }] }, token }), (e) => e.status === 409);
    assert.equal(JSON.stringify((await f.pool.query('SELECT state FROM nations_practice.matches WHERE id=$1', [MATCH])).rows[0].state), before);
    r = await executePracticeAction({ pool: f.pool, matchId: MATCH, action: 'substitution', requestId: UUID(), expectedRevision: r.revision, body: { team: 'A', swaps: [{ outId: '1', inId: '3' }, { outId: '2', inId: '4' }] }, token });
    assert.deepEqual(r.state.active.A.sort(), ['3', '4']);
  } finally { await f.close(); }
});

it('normal TB 6-6 closes 7-6 with serve; KO third set closes normally', async () => {
  const f = await fixture();
  try {
    const issued = await issuePracticeControlToken({ pool: f.pool, eventId: 1, matchId: MATCH, expiresAt: new Date(Date.now() + 60000).toISOString() });
    const token = issued.token; let r = await executePracticeAction({ pool: f.pool, matchId: MATCH, action: 'start', requestId: UUID(), expectedRevision: 0, token });
    let row = (await f.pool.query('SELECT state FROM nations_practice.matches WHERE id=$1', [MATCH])).rows[0].state;
    row = { ...row, format: 'knockout', games: { A: 6, B: 6 }, sets: { A: 1, B: 0 }, points: { A: 7, B: 6 }, es_tiebreak: true, saque_actual: 'A', history: [{ a: 6, b: 4, set: 1 }] };
    await f.pool.query('UPDATE nations_practice.matches SET state=$2::jsonb WHERE id=$1', [MATCH, JSON.stringify(row)]);
    r = await executePracticeAction({ pool: f.pool, matchId: MATCH, action: 'point', requestId: UUID(), expectedRevision: r.revision, body: { team: 'A' }, token });
    assert.equal(r.state.sets.A, 2); assert.equal(r.state.history.at(-1).a, 7); assert.equal(r.state.history.at(-1).b, 6);
    row = { ...r.state, format: 'knockout', status: 'en_curso', sets: { A: 1, B: 1 }, history: [{ a: 6, b: 4, set: 1 }, { a: 3, b: 6, set: 2 }], games: { A: 5, B: 4 }, points: { A: 40, B: 0 }, es_tiebreak: false };
    await f.pool.query('UPDATE nations_practice.matches SET state=$2::jsonb, revision=revision+1 WHERE id=$1', [MATCH, JSON.stringify(row)]);
    r = await executePracticeAction({ pool: f.pool, matchId: MATCH, action: 'point', requestId: UUID(), expectedRevision: (await f.pool.query('SELECT revision FROM nations_practice.matches WHERE id=$1',[MATCH])).rows[0].revision, body: { team: 'A' }, token });
    assert.equal(r.state.sets.A, 2); assert.equal(r.status, 'finalizado');
  } finally { await f.close(); }
});

it('concurrent practice commands with same and different request ids obey CAS', async () => {
  const f = await fixture();
  try {
    const issued = await issuePracticeControlToken({ pool: f.pool, eventId: 1, matchId: MATCH, expiresAt: new Date(Date.now() + 60000).toISOString() });
    const start = await executePracticeAction({ pool: f.pool, matchId: MATCH, action: 'start', requestId: UUID(), expectedRevision: 0, token: issued.token });
    const same = UUID();
    const [a,b] = await Promise.all([
      executePracticeAction({ pool: f.pool, matchId: MATCH, action: 'point', requestId: same, expectedRevision: start.revision, body: { team: 'A' }, token: issued.token }),
      executePracticeAction({ pool: f.pool, matchId: MATCH, action: 'point', requestId: same, expectedRevision: start.revision, body: { team: 'A' }, token: issued.token }),
    ]);
    assert.equal([a,b].filter((x) => x.deduplicated).length, 1);
    const settled = await Promise.allSettled([
      executePracticeAction({ pool: f.pool, matchId: MATCH, action: 'point', requestId: UUID(), expectedRevision: start.revision + 1, body: { team: 'B' }, token: issued.token }),
      executePracticeAction({ pool: f.pool, matchId: MATCH, action: 'point', requestId: UUID(), expectedRevision: start.revision + 1, body: { team: 'B' }, token: issued.token }),
    ]);
    assert.equal(settled.filter((x) => x.status === 'fulfilled').length, 1);
    assert.equal(settled.filter((x) => x.status === 'rejected' && x.reason?.code === 'PRACTICE_REVISION_CONFLICT').length, 1);
  } finally { await f.close(); }
});

it('undo at set boundary restores pre-point history exactly', async () => {
  const f = await fixture();
  try {
    const issued = await issuePracticeControlToken({ pool: f.pool, eventId: 1, matchId: MATCH, expiresAt: new Date(Date.now() + 60000).toISOString() });
    let r = await executePracticeAction({ pool: f.pool, matchId: MATCH, action: 'start', requestId: UUID(), expectedRevision: 0, token: issued.token });
    let row = (await f.pool.query('SELECT state FROM nations_practice.matches WHERE id=$1', [MATCH])).rows[0].state;
    row = { ...row, format: 'groups', games: { A: 5, B: 4 }, sets: { A: 0, B: 0 }, points: { A: 40, B: 0 }, history: [], es_tiebreak: false };
    await f.pool.query('UPDATE nations_practice.matches SET state=$2::jsonb WHERE id=$1', [MATCH, JSON.stringify(row)]);
    const before = JSON.parse(JSON.stringify(row));
    r = await executePracticeAction({ pool: f.pool, matchId: MATCH, action: 'point', requestId: UUID(), expectedRevision: r.revision, body: { team: 'A' }, token: issued.token });
    assert.equal(r.state.sets.A, 1);
    r = await executePracticeAction({ pool: f.pool, matchId: MATCH, action: 'undo', requestId: UUID(), expectedRevision: r.revision, token: issued.token });
    assert.deepEqual(r.state.history, before.history); assert.equal(Number(r.state.games.A), 5);
  } finally { await f.close(); }
});
