import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import pg from 'pg';
import express from 'express';
import { createNationsMarkerDurableRouter } from '../../routes/nationsMarkerDurableHttp.js';
import { mountScoreboardRoutes } from '../../routes/scoreboard.js';

const CS = process.env.NATIONS_PUBLIC_LINEUP_PG_URL;
const it = CS ? test : test.skip;
function assertLocalFixtureUrl(url) {
  const [beforeQuery, query = ''] = String(url || '').split('?');
  const params = new URLSearchParams(query);
  const host = params.get('host') || (/^postgres(?:ql)?:\/\/[^@/]*\/+([^/:]+)/.exec(beforeQuery)?.[1] ?? '');
  const database = decodeURIComponent(beforeQuery.split('/').at(-1) || '');
  if (!['/tmp', '127.0.0.1', 'localhost'].includes(host) || database !== 'nations_public_lineup_test') {
    throw new Error('REFUSE_NON_LOCAL_PG_FIXTURE');
  }
}

const ORIGIN = 'https://fixture-project.supabase.co';
const PHOTO = ORIGIN + '/storage/v1/object/public/scoreboard-fotos/public-player.png';
const U = (n) => `99000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const SID = U(1), actor = U(9999);

function transport(pool) {
  const allowed = new Set(['scoreboard_partidos', 'sedes', 'canchas', 'partidos', 'torneos', 'equipos', 'nations_activation_events']);
  return { supabaseUrl: ORIGIN, from(table) {
    assert(allowed.has(table));
    const filters = [];
    const q = {
      select: () => q,
      eq(k, v) { assert(/^[a-z_]+$/.test(k)); filters.push([k, v]); return q; },
      maybeSingle: async () => {
        const sql = `SELECT * FROM ${table}${filters.length ? ' WHERE ' + filters.map(([k], i) => `${k}=$${i + 1}`).join(' AND ') : ''}`;
        return { data: (await pool.query(sql, filters.map(([, v]) => v))).rows[0] ?? null, error: null };
      },
    };
    return q;
  } };
}

async function fixture({ rosterSize = 4, dorsalFirst = null } = {}) {
  assertLocalFixtureUrl(CS);
  const gate = new pg.Client({ connectionString: CS });
  await gate.connect();
  await gate.query('SELECT pg_advisory_lock(918273)');
  const pool = new pg.Pool({ connectionString: CS, max: 4 });
  await pool.query('DROP SCHEMA IF EXISTS nations_marker_private CASCADE; DROP SCHEMA IF EXISTS auth CASCADE; DROP TABLE IF EXISTS scoreboard_partidos,torneo_partido_alineaciones,equipos,partidos,torneos,sedes,canchas,nations_activation_events,user_roles CASCADE');
  await pool.query("CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY,email_confirmed_at timestamptz,banned_until timestamptz,deleted_at timestamptz); CREATE TABLE user_roles(user_id uuid PRIMARY KEY,role text,sede_id bigint); CREATE TABLE sedes(id bigint PRIMARY KEY,nombre text); INSERT INTO sedes VALUES(3,'Fixture'); CREATE TABLE canchas(id bigint,sede_id bigint,nombre text,orden integer); INSERT INTO canchas VALUES(1,3,'Court',1); CREATE TABLE torneos(id bigint PRIMARY KEY,sede_id bigint,modalidad_plantel text,deporte text,plan_nations jsonb,fecha_inicio date,horas_revelar_equipos numeric); INSERT INTO torneos VALUES(9,3,'selecciones','padbol','{\"roster_publication_approved\":true,\"config\":{\"reveal_at\":\"2000-01-01T00:00:00Z\"}}','2026-11-11',48); CREATE TABLE nations_activation_events(torneo_id bigint,roster_publication_approved boolean); INSERT INTO nations_activation_events VALUES(9,true); CREATE TABLE partidos(id bigint PRIMARY KEY,torneo_id bigint,equipo_a_id bigint,equipo_b_id bigint); INSERT INTO partidos VALUES(77,9,101,102); CREATE TABLE equipos(id bigint PRIMARY KEY,torneo_id bigint,creador_id uuid,jugadores jsonb,inscripcion_estado text); CREATE TABLE torneo_partido_alineaciones(torneo_id bigint,partido_id bigint,equipo_id bigint,iniciales jsonb,suplentes jsonb,revision bigint); CREATE TABLE scoreboard_partidos(id uuid PRIMARY KEY,partido_torneo_id bigint,sede_id bigint,torneo_id bigint,cancha text,estado text DEFAULT 'pendiente',cronometro_inicio timestamptz,cronometro_pausado boolean DEFAULT false,cronometro_segundos integer DEFAULT 0,updated_at timestamptz DEFAULT now(),games_a integer DEFAULT 1,games_b integer DEFAULT 0,score_a integer DEFAULT 0,score_b integer DEFAULT 0,sets_a integer DEFAULT 0,sets_b integer DEFAULT 0,historial_sets jsonb DEFAULT '[]',es_tiebreak boolean DEFAULT false,equipo_a_nombre text,equipo_b_nombre text,equipo_a_jugadores jsonb,equipo_b_jugadores jsonb,control_token_hash text UNIQUE,control_token_created_at timestamptz,control_token_revoked_at timestamptz);");
  const local = fs.readFileSync(new URL('../../sql/local/nations_marker_local_runtime.sql', import.meta.url), 'utf8').split("DO $$ BEGIN\n  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='nations_marker_runtime')")[0];
  await pool.query(local);
  await pool.query("ALTER TABLE nations_marker_private.nations_marker_match ADD COLUMN games_epoch integer NOT NULL DEFAULT 0, ADD COLUMN tracking_status text NOT NULL DEFAULT 'active', ADD COLUMN games_ledger jsonb");
  await pool.query("CREATE TABLE IF NOT EXISTS nations_marker_private.games_command_receipts(scoreboard_id uuid,request_id uuid,command jsonb,result jsonb,PRIMARY KEY(scoreboard_id,request_id)); CREATE TABLE IF NOT EXISTS nations_marker_private.games_reset_archive(match_id text,epoch integer,snapshot jsonb,created_at timestamptz DEFAULT now(),PRIMARY KEY(match_id,epoch)); CREATE TABLE IF NOT EXISTS nations_marker_private.games_finalization_intents(scoreboard_id uuid,epoch integer,effect_kind text DEFAULT 'tournament_finalization',request_id uuid,partido_torneo_id bigint,occurred_at timestamptz DEFAULT now(),final_snapshot jsonb,status text DEFAULT 'pending',attempts integer DEFAULT 0,next_attempt_at timestamptz,last_error text,lease_token uuid,lease_until timestamptz,PRIMARY KEY(scoreboard_id,epoch,effect_kind));");
  await pool.query('INSERT INTO auth.users(id,email_confirmed_at) VALUES($1,now())', [actor]);
  await pool.query('INSERT INTO user_roles VALUES($1,$2,3)', [actor, 'super_admin']);
  const roster = (team, start) => Array.from({ length: rosterSize }, (_, i) => ({ participante_id: U(start + i), nombre: `Public ${team}-${i + 1}`, estado: 'confirmado', email: 'PRIVATE@example.test', documento: 'PRIVATE-DOCUMENT', foto_url: i === 0 ? PHOTO : ORIGIN + '/storage/v1/object/public/avatars/PRIVATE.png', jersey: i === 0 && dorsalFirst ? dorsalFirst : i + 1, ...(i === 0 && dorsalFirst ? { dorsal: dorsalFirst } : {}) }));
  const a = roster(101, 1011), b = roster(102, 1021);
  for (const [team, players] of [[101, a], [102, b]]) {
    await pool.query('INSERT INTO equipos VALUES($1,9,$2,$3,$4)', [team, actor, JSON.stringify(players), 'confirmado']);
    await pool.query('INSERT INTO torneo_partido_alineaciones VALUES(9,77,$1,$2,$3,1)', [team, JSON.stringify(players.slice(0, 2).map((p) => p.participante_id)), JSON.stringify(players.slice(2).map((p) => p.participante_id))]);
  }
  await pool.query('INSERT INTO scoreboard_partidos(id,partido_torneo_id,sede_id,torneo_id,cancha,equipo_a_nombre,equipo_b_nombre,equipo_a_jugadores,equipo_b_jugadores) VALUES($1,77,3,9,$2,$3,$4,$5,$6)', [SID, '1', 'TeamA', 'TeamB', JSON.stringify(a), JSON.stringify(b)]);
  const db = transport(pool), app = express();
  app.use(express.json());
  const durable = createNationsMarkerDurableRouter({ pool, authorize: async () => ({ actorId: actor }) });
  app.use((req, res, next) => req.path.startsWith('/api/nations/marker/') ? durable(req, res) : next());
  mountScoreboardRoutes(app, { supabaseAdmin: db, nationsGamesPool: pool, nationsGamesEnabled: true, getAuthenticatedUser: async () => ({ user: null }), fetchUserRoleRowForAuthUser: async () => null, io: null });
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = async () => { const r = await fetch(`${base}/api/scoreboard/partidos/${SID}`); return { status: r.status, body: await r.json() }; };
  const post = async (path, body) => { const r = await fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };
  return { pool, base, get, post, async start() { return post(`/api/nations/marker/${SID}/start`, { idempotencyKey: 'fixture-start' }); }, async close() { await new Promise((r) => { server.close(r); server.closeAllConnections(); }); await pool.end(); await gate.query('SELECT pg_advisory_unlock(918273)'); await gate.end(); } };
}

const onCourt = (players) => players.filter((p) => p.on_court).map((p) => p.nombre);
const bench = (players) => players.filter((p) => !p.on_court).map((p) => p.nombre);

it('HTTP real: confirmed 2/3-player rosters are not padded and a non-index dorsal is preserved', async () => {
  for (const rosterSize of [2, 3]) {
    const s = await fixture({ rosterSize, dorsalFirst: 14 });
    try {
      assert.equal((await s.start()).status, 200);
      const out = (await s.get()).body;
      assert.equal(out.nations_lineup_status, 'current');
      assert.equal(out.equipo_a_jugadores.length, rosterSize);
      assert.equal(out.equipo_b_jugadores.length, rosterSize);
      assert.equal(out.equipo_a_jugadores.filter((p) => p.on_court).length, 2);
      assert.equal(out.equipo_a_jugadores[0].jersey, '14');
      assert.notEqual(out.equipo_a_jugadores[0].jersey, '1');
    } finally { await s.close(); }
  }
});

it('HTTP real: team lineup revision changed after start becomes unavailable, not current', async () => {
  const s = await fixture();
  try {
    assert.equal((await s.start()).status, 200);
    assert.equal((await s.get()).body.nations_lineup_status, 'current');
    await s.pool.query('UPDATE torneo_partido_alineaciones SET revision=2 WHERE partido_id=77 AND equipo_id=101');
    const out = (await s.get()).body;
    assert.equal(out.nations_lineup_status, 'unavailable');
    assert.deepEqual(out.equipo_a_jugadores, []);
    assert.deepEqual(out.equipo_b_jugadores, []);
  } finally { await s.close(); }
});

it('HTTP real: durable POST single/double swaps change GET immediately, B unchanged, no IDs/PII', async () => {
  const s = await fixture();
  try {
    const before = await s.get();
    assert.equal(before.body.nations_lineup_status, 'unavailable');
    assert.deepEqual(before.body.equipo_a_jugadores, []);
    assert.deepEqual(before.body.equipo_b_jugadores, []);
    assert.equal((await s.start()).status, 200);
    let out = (await s.get()).body;
    assert.equal(out.nations_lineup_status, 'current');
    assert.deepEqual(onCourt(out.equipo_a_jugadores), ['Public 101-1', 'Public 101-2']);
    assert.deepEqual(bench(out.equipo_a_jugadores), ['Public 101-3', 'Public 101-4']);
    const bBefore = out.equipo_b_jugadores.map((p) => [p.nombre, p.on_court]);
    assert.equal((await s.post(`/api/nations/marker/${SID}/team/101/commands`, { type: 'substitution', idempotencyKey: 'single', eventId: 'single', expectedRevision: 0, epoch: 0, outId: U(1011), inId: U(1013) })).status, 200);
    out = (await s.get()).body;
    assert.deepEqual(onCourt(out.equipo_a_jugadores), ['Public 101-2', 'Public 101-3']);
    assert.deepEqual(out.equipo_b_jugadores.map((p) => [p.nombre, p.on_court]), bBefore);
    assert.equal((await s.post(`/api/nations/marker/${SID}/team/101/commands`, { type: 'substitution', idempotencyKey: 'double', eventId: 'double', expectedRevision: 1, epoch: 0, swaps: [{ outId: U(1013), inId: U(1011) }, { outId: U(1012), inId: U(1014) }] })).status, 200);
    out = (await s.get()).body;
    assert.deepEqual(onCourt(out.equipo_a_jugadores), ['Public 101-1', 'Public 101-4']);
    assert.deepEqual(out.equipo_b_jugadores.map((p) => [p.nombre, p.on_court]), bBefore);
    for (const side of ['equipo_a_jugadores', 'equipo_b_jugadores']) for (const player of out[side]) {
      assert(Object.keys(player).every((key) => ['nombre', 'apellido', 'jersey', 'numero', 'role', 'on_court', 'foto_url'].includes(key)), JSON.stringify(player));
    }
    const serialized = JSON.stringify(out);
    assert(!serialized.includes('PRIVATE'));
    assert(!serialized.includes('participante_id'));
    assert(!serialized.includes('user_id'));
    assert(!JSON.stringify([...out.equipo_a_jugadores, ...out.equipo_b_jugadores]).includes('99000000-'));
  } finally { await s.close(); }
});
