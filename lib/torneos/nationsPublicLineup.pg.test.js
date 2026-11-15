import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { safeNationsScoreboardProjection } from './nationsPublicAccess.js';
import { projectCurrentNationsLineup, trustedScoreboardPhoto } from './nationsPublicLineup.js';

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

const U = (n) => `99000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const SID = '11111111-1111-4111-8111-111111111111';
const PHOTO = 'https://fixture-project.supabase.co/storage/v1/object/public/scoreboard-fotos/a.png';

function db(pool) {
  return { supabaseUrl: 'https://fixture-project.supabase.co', from(table) {
    const filters = []; const q = { select: () => q, eq(k, v) { filters.push([k, v]); return q; }, maybeSingle: async () => {
      const sql = `SELECT * FROM ${table}${filters.length ? ' WHERE ' + filters.map(([k], i) => `${k}=$${i + 1}`).join(' AND ') : ''}`;
      return { data: (await pool.query(sql, filters.map(([, v]) => v))).rows[0] ?? null, error: null };
    } }; return q;
  } };
}
async function fixture() {
  assertLocalFixtureUrl(CS);
  const gate = new pg.Client({ connectionString: CS });
  await gate.connect();
  await gate.query('SELECT pg_advisory_lock(918273)');
  const pool = new pg.Pool({ connectionString: CS, max: 2 });
  await pool.query(`DROP TABLE IF EXISTS scoreboard_partidos, torneo_partido_alineaciones, equipos, partidos, torneos, sedes, canchas, nations_activation_events CASCADE; DROP TABLE IF EXISTS nations_marker_private.nations_marker_match CASCADE; DROP SCHEMA IF EXISTS nations_marker_private CASCADE;
  CREATE SCHEMA nations_marker_private; CREATE TABLE sedes(id bigint PRIMARY KEY,nombre text); INSERT INTO sedes VALUES(3,'Fixture'); CREATE TABLE canchas(id bigint,sede_id bigint,nombre text,orden integer); INSERT INTO canchas VALUES(1,3,'Court',1);
  CREATE TABLE torneos(id bigint PRIMARY KEY,sede_id bigint,modalidad_plantel text,deporte text,plan_nations jsonb); INSERT INTO torneos VALUES(9,3,'selecciones','padbol','{"roster_publication_approved":true,"config":{"reveal_at":"2000-01-01T00:00:00Z"}}');
  CREATE TABLE nations_activation_events(torneo_id bigint,roster_publication_approved boolean); INSERT INTO nations_activation_events VALUES(9,true);
  CREATE TABLE partidos(id bigint PRIMARY KEY,torneo_id bigint,equipo_a_id bigint,equipo_b_id bigint); INSERT INTO partidos VALUES(77,9,101,102);
  CREATE TABLE equipos(id bigint PRIMARY KEY,torneo_id bigint,creador_id uuid,jugadores jsonb,inscripcion_estado text);
  CREATE TABLE torneo_partido_alineaciones(torneo_id bigint,partido_id bigint,equipo_id bigint,iniciales jsonb,suplentes jsonb,revision bigint);
  CREATE TABLE scoreboard_partidos(id uuid PRIMARY KEY,partido_torneo_id bigint,sede_id bigint,torneo_id bigint,cancha text,estado text,updated_at timestamptz DEFAULT now(),cronometro_inicio timestamptz,cronometro_pausado boolean,cronometro_segundos integer,equipo_a_nombre text,equipo_b_nombre text,equipo_a_jugadores jsonb,equipo_b_jugadores jsonb);
  CREATE TABLE nations_marker_private.nations_marker_match(match_id text PRIMARY KEY,revision integer NOT NULL,states jsonb NOT NULL,tracking_status text NOT NULL,receipts jsonb NOT NULL);`);
  const roster = (team, start) => Array.from({ length: 4 }, (_, i) => ({ participante_id: U(start + i), nombre: `Public ${team}-${i + 1}`, estado: 'confirmado', email: 'PRIVATE@example.test', documento: 'PRIVATE-DOCUMENT', jersey: i + 1, foto_url: i === 0 ? PHOTO : 'https://fixture-project.supabase.co/storage/v1/object/public/avatars/private.png' }));
  const a = roster(101, 1011), b = roster(102, 1021);
  for (const [team, rows] of [[101, a], [102, b]]) {
    await pool.query('INSERT INTO equipos VALUES($1,9,$2,$3,$4)', [team, U(9999), JSON.stringify(rows), 'confirmado']);
    await pool.query('INSERT INTO torneo_partido_alineaciones VALUES(9,77,$1,$2,$3,1)', [team, JSON.stringify(rows.slice(0, 2).map((p) => p.participante_id)), JSON.stringify(rows.slice(2).map((p) => p.participante_id))]);
  }
  const states = { 101: { status: 'open', active: [U(1011), U(1012)], lineup: { iniciales: [U(1011), U(1012)], suplentes: [U(1013), U(1014)] }, roster: a.map((p) => p.participante_id) }, 102: { status: 'open', active: [U(1021), U(1022)], lineup: { iniciales: [U(1021), U(1022)], suplentes: [U(1023), U(1024)] }, roster: b.map((p) => p.participante_id) } };
  await pool.query('INSERT INTO scoreboard_partidos(id,partido_torneo_id,sede_id,torneo_id,cancha,estado,equipo_a_nombre,equipo_b_nombre,equipo_a_jugadores,equipo_b_jugadores) VALUES($1,77,3,9,$2,$3,$4,$5,$6,$7)', [SID, '1', 'en_curso', 'Team A', 'Team B', JSON.stringify(a), JSON.stringify(b)]);
  await pool.query('INSERT INTO nations_marker_private.nations_marker_match VALUES($1,3,$2,$3,$4)', [SID, JSON.stringify(states), 'active', JSON.stringify({start:{lineup:{101:1,102:1}}})]);
  return { pool, db: db(pool), async close() { await pool.end(); await gate.query('SELECT pg_advisory_unlock(918273)'); await gate.end(); } };
}
test('real PG fixture refuses non-loopback or non-dedicated databases', () => {
  assert.throws(() => assertLocalFixtureUrl('postgresql://postgres@db.supabase.co/nations_public_lineup_test'), /REFUSE_NON_LOCAL_PG_FIXTURE/);
  assert.throws(() => assertLocalFixtureUrl('postgresql://postgres@/production?host=/tmp'), /REFUSE_NON_LOCAL_PG_FIXTURE/);
  assert.doesNotThrow(() => assertLocalFixtureUrl('postgresql://postgres@/nations_public_lineup_test?host=/tmp'));
});

it('real PG: durable single/double swaps project publicly and strip PII', async () => {
  const f = await fixture();
  try {
    const row = (await f.pool.query('SELECT * FROM scoreboard_partidos WHERE id=$1', [SID])).rows[0];
    let out = await safeNationsScoreboardProjection(f.db, row, { pool: f.pool });
    assert.equal(out.nations_lineup_status, 'current');
    assert.deepEqual(out.equipo_a_jugadores.map((p) => [p.nombre, p.on_court]), [['Public 101-1', true], ['Public 101-2', true], ['Public 101-3', false], ['Public 101-4', false]]);
    assert.equal(out.equipo_a_jugadores[0].foto_url, PHOTO);
    assert.equal(out.equipo_a_jugadores[1].foto_url, undefined);
    assert(!JSON.stringify(out).includes('PRIVATE'));
    for (const player of [...out.equipo_a_jugadores, ...out.equipo_b_jugadores]) assert(Object.keys(player).every((key) => ['nombre','apellido','jersey','numero','role','on_court','foto_url'].includes(key)));
    const bBefore = out.equipo_b_jugadores.map((p) => [p.nombre, p.on_court]);
    await f.pool.query("UPDATE nations_marker_private.nations_marker_match SET states=jsonb_set(states,'{101,active}','[\"99000000-0000-4000-8000-000000001012\",\"99000000-0000-4000-8000-000000001013\"]') WHERE match_id=$1", [SID]);
    out = await safeNationsScoreboardProjection(f.db, row, { pool: f.pool });
    assert.deepEqual(out.equipo_a_jugadores.filter((p) => p.on_court).map((p) => p.nombre), ['Public 101-2', 'Public 101-3']);
    assert.deepEqual(out.equipo_b_jugadores.map((p) => [p.nombre, p.on_court]), bBefore);
    await f.pool.query("UPDATE nations_marker_private.nations_marker_match SET states=jsonb_set(states,'{101,active}','[\"99000000-0000-4000-8000-000000001013\",\"99000000-0000-4000-8000-000000001014\"]') WHERE match_id=$1", [SID]);
    out = await safeNationsScoreboardProjection(f.db, row, { pool: f.pool });
    assert.deepEqual(out.equipo_a_jugadores.filter((p) => p.on_court).map((p) => p.nombre), ['Public 101-3', 'Public 101-4']);
    assert.deepEqual(out.equipo_b_jugadores.map((p) => [p.nombre, p.on_court]), bBefore);
    await f.pool.query("UPDATE nations_marker_private.nations_marker_match SET tracking_status='reset_pending' WHERE match_id=$1", [SID]);
    const unavailable = await safeNationsScoreboardProjection(f.db, row, { pool: f.pool });
    assert.equal(unavailable.nations_lineup_status, 'unavailable');
    assert.deepEqual(unavailable.equipo_a_jugadores, []);
    assert.deepEqual(unavailable.equipo_b_jugadores, []);
  } finally { await f.close(); }
});
it('real PG: unavailable pool/context never returns active flags or PII', async () => {
  const f = await fixture();
  try {
    const row = (await f.pool.query('SELECT * FROM scoreboard_partidos WHERE id=$1', [SID])).rows[0];
    assert.equal((await safeNationsScoreboardProjection(f.db, row, { pool: null })).nations_lineup_status, 'unavailable');
    const badPool = { connect: async () => { throw Error('private'); } };
    assert.equal((await safeNationsScoreboardProjection(f.db, row, { pool: badPool })).nations_lineup_status, 'unavailable');
  } finally { await f.close(); }
});
