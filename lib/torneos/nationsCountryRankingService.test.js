import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildNationsCountryRanking,
  loadNationsCountryRanking,
} from './nationsCountryRankingService.js';

const ISOS = ['AR', 'IT', 'ES', 'FR', 'GB', 'US', 'BR', 'DE', 'PT', 'BE', 'NL', 'CH', 'AT', 'AU', 'UY'];
const revealed = () => true;
const baseEvent = (over = {}) => {
  const id = over.id ?? 1;
  const teams = Array.from({ length: 15 }, (_, index) => ({ id: 100 + index, torneo_id: id }));
  const mapping = Object.fromEntries(teams.map((team, index) => [team.id, ISOS[index]]));
  return {
    id,
    nombre: `Nations ${id}`,
    estado: 'finalizado',
    deporte: 'padbol',
    modalidad_plantel: 'selecciones',
    fecha_inicio: '2026-01-01',
    fecha_fin: '2026-01-02',
    es_prueba: false,
    plan_nations: { config: { country_by_team: mapping } },
    ...over,
  };
};
const teamsOf = (event) => Array.from({ length: 15 }, (_, index) => ({ id: 100 + index, torneo_id: event.id }));
const awards = (event, values) => teamsOf(event).map((team, index) => ({
  torneo_id: event.id,
  equipo_id: team.id,
  posicion: index + 1,
  puntos: values[index] ?? 0,
}));

test('fifteen countries receive one approved contribution each and the roster never multiplies it', () => {
  const event = baseEvent();
  const teams = teamsOf(event).map((team, index) => ({
    ...team,
    // Roster size must be irrelevant; the country row is built from the plan.
    jugadores: Array.from({ length: index % 2 ? 4 : 8 }, (_, player) => ({ id: player + 1 })),
  }));
  const values = Array.from({ length: 15 }, (_, index) => 300 - index * 10);
  const rows = buildNationsCountryRanking(
    { torneos: [event], equipos: teams, puntos: awards(event, values) },
    { isRevealed: revealed },
  );

  assert.equal(rows.length, 15);
  assert.equal(rows.reduce((total, row) => total + row.puntos_total, 0), values.reduce((a, b) => a + b, 0));
  assert(rows.every((row) => row.torneos_count === 1));
  assert.deepEqual(rows.map((row) => row.pais), ISOS);
  assert.deepEqual(rows.slice(0, 3).map((row) => row.posicion), [1, 2, 3]);
  assert.equal(rows[0].puntos_total, 300);
});

test('the same award is identical for a four-player and an eight-player roster', () => {
  const buildFor = (rosterSize) => {
    const event = baseEvent({ id: 1 });
    const roster = Array.from({ length: rosterSize }, (_, index) => ({ id: index + 1 }));
    const teams = teamsOf(event);
    teams[0] = { ...teams[0], jugadores: roster };
    return buildNationsCountryRanking(
      { torneos: [event], equipos: teams, puntos: [{ torneo_id: 1, equipo_id: 100, posicion: 1, puntos: 300 }] },
      { isRevealed: revealed },
    ).find((row) => row.pais === 'AR');
  };

  const four = buildFor(4);
  const eight = buildFor(8);
  assert.equal(four.puntos_total, 300);
  assert.equal(eight.puntos_total, 300);
  assert.equal(four.torneos_count, 1);
  assert.equal(eight.torneos_count, 1);
});

test('sums several tournaments and keeps one contribution per country per tournament', () => {
  const first = baseEvent({ id: 1 });
  const second = baseEvent({ id: 2, nombre: 'Nations II' });
  const puntos = [
    { torneo_id: 1, equipo_id: 100, posicion: 1, puntos: 300 },
    { torneo_id: 2, equipo_id: 100, posicion: 1, puntos: 180 },
    // Every other selection still contributes a real award in each event.
    ...teamsOf(first).slice(1).map((team, index) => ({ torneo_id: 1, equipo_id: team.id, posicion: index + 2, puntos: 10 })),
    ...teamsOf(second).slice(1).map((team, index) => ({ torneo_id: 2, equipo_id: team.id, posicion: index + 2, puntos: 10 })),
  ];
  const rows = buildNationsCountryRanking(
    { torneos: [first, second], equipos: [...teamsOf(first), ...teamsOf(second)], puntos },
    { isRevealed: revealed },
  );

  const argentina = rows.find((row) => row.pais === 'AR');
  assert.equal(argentina.puntos_total, 480);
  assert.equal(argentina.torneos_count, 2);
  assert.deepEqual(argentina.torneos.map((row) => row.torneo_id), [1, 2]);
  assert(rows.every((row) => row.torneos_count <= 2));
});

test('a stored zero is a real zero while a missing award stays pending', () => {
  const event = baseEvent();
  const rows = buildNationsCountryRanking(
    {
      torneos: [event],
      equipos: teamsOf(event),
      // Only Argentina has a stored ledger row, and it is a real zero.
      puntos: [{ torneo_id: 1, equipo_id: 100, posicion: 15, puntos: 0 }],
    },
    { isRevealed: revealed },
  );

  const argentina = rows.find((row) => row.pais === 'AR');
  const italy = rows.find((row) => row.pais === 'IT');
  assert.equal(argentina.puntos_total, 0);
  assert.equal(argentina.torneos_count, 1);
  assert.equal(argentina.pendiente, false);
  assert.equal(argentina.posicion, 1);
  assert.equal(italy.puntos_total, 0);
  assert.equal(italy.torneos_count, 0);
  assert.equal(italy.torneos_pendientes, 1);
  assert.equal(italy.pendiente, true);
  assert.equal(italy.posicion, null);
  assert.equal(rows[0].pais, 'AR');
});

test('tied totals share the position and tournament count is never an invented tie-break', () => {
  const first = baseEvent({ id: 1 });
  const second = baseEvent({ id: 2 });
  const puntos = [
    { torneo_id: 1, equipo_id: 100, posicion: 1, puntos: 300 }, // AR in one event
    { torneo_id: 1, equipo_id: 101, posicion: 2, puntos: 150 }, // IT split over two events
    { torneo_id: 2, equipo_id: 101, posicion: 2, puntos: 150 },
    { torneo_id: 1, equipo_id: 102, posicion: 3, puntos: 100 }, // ES below the tie
  ];
  const rows = buildNationsCountryRanking(
    { torneos: [first, second], equipos: [...teamsOf(first), ...teamsOf(second)], puntos },
    { isRevealed: revealed },
  );

  const ar = rows.find((row) => row.pais === 'AR');
  const it = rows.find((row) => row.pais === 'IT');
  const es = rows.find((row) => row.pais === 'ES');
  assert.equal(ar.puntos_total, 300);
  assert.equal(it.puntos_total, 300);
  assert.equal(ar.torneos_count, 1);
  assert.equal(it.torneos_count, 2);
  assert.equal(ar.posicion, 1);
  assert.equal(it.posicion, 1);
  assert.equal(es.posicion, 3);
});

test('drafts, QA events, unrevealed events and legacy selections are isolated before any award is read', () => {
  const real = baseEvent({ id: 1 });
  const qa = baseEvent({ id: 2, es_prueba: true });
  const draft = baseEvent({ id: 3, estado: 'abierto' });
  const unrevealed = baseEvent({ id: 4 });
  const legacy = { ...baseEvent({ id: 5 }), plan_nations: null };
  const torneos = [real, qa, draft, unrevealed, legacy];
  const equipos = torneos.flatMap((event) => teamsOf(event));
  const puntos = torneos.map((event, index) => ({
    torneo_id: event.id,
    equipo_id: 100,
    posicion: 1,
    puntos: [300, 9999, 500, 400, 700][index],
  }));
  const before = JSON.stringify(puntos);
  const rows = buildNationsCountryRanking(
    { torneos, equipos, puntos },
    { isRevealed: (torneo) => torneo.id !== 4 },
  );

  // The real event still lists its 15 selections, but only one is ranked and
  // the other 14 remain explicitly pending.
  assert.equal(rows.length, 15);
  assert.equal(rows.filter((row) => row.posicion != null).length, 1);
  assert.equal(rows[0].pais, 'AR');
  assert.equal(rows[0].puntos_total, 300);
  assert.equal(rows[0].torneos_count, 1);
  assert(rows.slice(1).every((row) => row.pendiente === true));
  assert.equal(JSON.stringify(puntos), before);
});

test('duplicate rows, duplicated countries and malformed ISO codes fail closed', () => {
  const event = baseEvent();
  const base = { torneos: [event], equipos: teamsOf(event) };
  const row = { torneo_id: 1, equipo_id: 100, posicion: 1, puntos: 300 };

  assert.throws(() => buildNationsCountryRanking(
    { ...base, puntos: [row, { ...row }] },
    { isRevealed: revealed },
  ), (error) => error.code === 'NATIONS_COUNTRY_RANKING_DATA_INVALID' && error.status === 503);

  const duplicated = baseEvent({ id: 1 });
  duplicated.plan_nations.config.country_by_team[101] = 'AR';
  assert.throws(() => buildNationsCountryRanking(
    { torneos: [duplicated], equipos: teamsOf(duplicated), puntos: [] },
    { isRevealed: revealed },
  ));

  const lowercase = baseEvent({ id: 1 });
  lowercase.plan_nations.config.country_by_team[100] = 'ar';
  assert.throws(() => buildNationsCountryRanking(
    { torneos: [lowercase], equipos: teamsOf(lowercase), puntos: [] },
    { isRevealed: revealed },
  ));

  const missing = baseEvent({ id: 1 });
  delete missing.plan_nations.config.country_by_team[100];
  assert.throws(() => buildNationsCountryRanking(
    { torneos: [missing], equipos: teamsOf(missing), puntos: [] },
    { isRevealed: revealed },
  ));
});

test('invalid point rows are rejected instead of silently skipped', () => {
  const event = baseEvent();
  const base = { torneos: [event], equipos: teamsOf(event) };
  for (const bad of [
    { torneo_id: 1, equipo_id: 100, posicion: 0, puntos: 10 },
    { torneo_id: 1, equipo_id: 100, posicion: 1, puntos: -1 },
    { torneo_id: 1, equipo_id: 100, posicion: 1, puntos: 1.5 },
    { torneo_id: 1, equipo_id: 100, posicion: 1, puntos: 2147483648 },
  ]) {
    assert.throws(() => buildNationsCountryRanking({ ...base, puntos: [bad] }, { isRevealed: revealed }));
  }
});

test('no visible tournament yields an empty ranking and retries are deterministic', () => {
  const event = baseEvent();
  assert.deepEqual(buildNationsCountryRanking({ torneos: [], equipos: [], puntos: [] }, { isRevealed: revealed }), []);
  assert.deepEqual(
    buildNationsCountryRanking({ torneos: [event], equipos: teamsOf(event), puntos: awards(event, [1]) }, { isRevealed: () => false }),
    [],
  );
  assert.throws(() => buildNationsCountryRanking({ torneos: [event], equipos: teamsOf(event) }), (error) => error.status === 503);

  const input = { torneos: [event], equipos: teamsOf(event), puntos: awards(event, [300, 180]) };
  const first = buildNationsCountryRanking(input, { isRevealed: revealed });
  const second = buildNationsCountryRanking(input, { isRevealed: revealed });
  assert.deepEqual(first, second);
});

function fakeDb(responses, rpc = null) {
  const calls = [];
  const rpcCalls = [];
  return {
    calls,
    rpcCalls,
    ...(rpc ? { async rpc(name, params) { rpcCalls.push({ name, params }); return rpc(name, params); } } : {}),
    from(table) {
      const result = responses[table];
      const query = {
        select(fields) {
          calls.push({ table, fields });
          return query;
        },
        eq() {
          return query;
        },
        in() {
          return query;
        },
        then(resolve, reject) {
          return Promise.resolve(result).then(resolve, reject);
        },
      };
      return query;
    },
  };
}

test('loader reads only whitelisted columns and never fetches rosters or identities', async () => {
  const event = baseEvent({ id: 1, plan_nations: { config: { reveal_at: '2020-01-01T00:00:00Z', country_by_team: Object.fromEntries(teamsOf(baseEvent()).map((team, index) => [team.id, ISOS[index]])) } } });
  const database = fakeDb({
    torneos: { data: [event] },
    equipos: { data: teamsOf(event) },
    tabla_puntos: { data: awards(event, [300]) },
  });
  const rows = await loadNationsCountryRanking(database, { isRevealed: revealed });

  assert.equal(rows.length, 15);
  assert(database.calls.every((call) => !String(call.fields).includes('jugadores')));
  assert(database.calls.every((call) => !String(call.fields).includes('participantes_ranking')));
  assert(database.calls.some((call) => call.table === 'torneos' && call.fields.includes('es_prueba')));
  assert(database.calls.some((call) => call.table === 'equipos' && call.fields === 'id,torneo_id'));
});

test('loader propagates storage errors and short-circuits embargoed events', async () => {
  const event = baseEvent({ id: 1 });
  await assert.rejects(
    () => loadNationsCountryRanking(fakeDb({ torneos: { error: { code: 'DB_ERROR' }, data: null } }), { isRevealed: revealed }),
    (error) => error.status === 503,
  );
  await assert.rejects(
    () => loadNationsCountryRanking(fakeDb({
      torneos: { data: [event] },
      equipos: { data: null, error: {} },
      tabla_puntos: { data: [] },
    }), { isRevealed: revealed }),
    (error) => error.status === 503,
  );
  const database = fakeDb({ torneos: { data: [event] } });
  assert.deepEqual(await loadNationsCountryRanking(database, { isRevealed: () => false }), []);
  assert.equal(database.calls.length, 1);
});


function rpcEvent(id = 1) {
  return baseEvent({ id, plan_nations: { enabled: true, format: 'nations_3x5', revision: 7, status: 'finalized', config: { format: 'nations_3x5', timezone: 'America/Argentina/Buenos_Aires', reveal_at: '2020-01-01T00:00:00Z' } } });
}
function mappingOf(event) {
  return Object.fromEntries(teamsOf(event).map((team, index) => [team.id, ISOS[index]]));
}

test('actual RPC projection: public config is stripped and the private map is read without exposure', async () => {
  const event = rpcEvent(1);
  const privateMap = mappingOf(event);
  const privatePlan = {
    config: { country_by_team: privateMap },
    requests: [{ id: 'private-request' }],
    closure_source: [{ id: 'private-source' }],
  };
  const database = fakeDb({
    torneos: { data: [event] },
    equipos: { data: teamsOf(event) },
    tabla_puntos: { data: awards(event, [300]) },
  }, async (name, params) => ({ data: { torneo: { id: params.p_torneo_id, plan_nations: privatePlan } }, error: null }));

  const rows = await loadNationsCountryRanking(database, { isRevealed: revealed });
  assert.equal(rows.length, 15);
  assert.equal(rows.find((row) => row.pais === 'AR').puntos_total, 300);
  assert.equal(database.rpcCalls.length, 1);
  assert.equal(database.rpcCalls[0].name, 'leer_estado_nations');
  assert.equal(database.rpcCalls[0].params.p_torneo_id, 1);
  const serialized = JSON.stringify(rows);
  assert.equal(serialized.includes('country_by_team'), false);
  assert.equal(serialized.includes('private-request'), false);
  assert.equal(serialized.includes('private-source'), false);
});

test('private plan with missing or conflicting map fails closed', async () => {
  const event = rpcEvent(1);
  const privateMap = mappingOf(event);
  const base = {
    torneos: { data: [event] },
    equipos: { data: teamsOf(event) },
    tabla_puntos: { data: awards(event, [300]) },
  };
  const conflictMap = { ...privateMap, 100: 'IT', 101: 'AR' };
  const cases = [
    { plan: { config: { format: 'nations_3x5', timezone: 'UTC' } }, publicMap: null },
    { plan: { config: { country_by_team: conflictMap } }, publicMap: privateMap },
    { plan: null, publicMap: null },
    { plan: undefined, publicMap: privateMap },
  ];
  for (const { plan, publicMap } of cases) {
    const publicEvent = publicMap
      ? { ...event, plan_nations: { config: { ...event.plan_nations.config, country_by_team: publicMap } } }
      : event;
    const database = fakeDb({ ...base, torneos: { data: [publicEvent] } }, async (name, params) => ({ data: { torneo: { id: params.p_torneo_id, plan_nations: plan } }, error: null }));
    await assert.rejects(() => loadNationsCountryRanking(database, { isRevealed: revealed }), (error) => error.status === 503);
  }
  // The RPC may answer successfully with no data/torneo at all.
  {
    const database = fakeDb({ ...base, torneos: { data: [event] } }, async () => ({ data: null, error: null }));
    await assert.rejects(() => loadNationsCountryRanking(database, { isRevealed: revealed }), (error) => error.status === 503);
  }
  {
    const database = fakeDb({ ...base, torneos: { data: [event] } }, async () => ({ data: { torneo: null }, error: null }));
    await assert.rejects(() => loadNationsCountryRanking(database, { isRevealed: revealed }), (error) => error.status === 503);
  }
});

test('only events that pass the eligible/revealed filter are asked for a private plan', async () => {
  const visible = rpcEvent(1);
  const hidden = rpcEvent(2);
  const visibleMap = mappingOf(visible);
  const hiddenMap = mappingOf(hidden);
  const database = fakeDb({
    torneos: { data: [visible, hidden] },
    equipos: { data: [...teamsOf(visible), ...teamsOf(hidden)] },
    tabla_puntos: { data: [...awards(visible, [300]), ...awards(hidden, [999])] },
  }, async (name, params) => ({ data: { torneo: { id: params.p_torneo_id, plan_nations: { config: { country_by_team: params.p_torneo_id === 1 ? visibleMap : hiddenMap } } } }, error: null }));
  const rows = await loadNationsCountryRanking(database, { isRevealed: (torneo) => torneo.id === 1 });
  assert.equal(database.rpcCalls.length, 1);
  assert.equal(database.rpcCalls[0].params.p_torneo_id, 1);
  assert.equal(rows.find((row) => row.pais === 'AR').puntos_total, 300);
});
