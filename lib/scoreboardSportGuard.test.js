import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mountScoreboardRoutes } from '../routes/scoreboard.js';
import { assertScoreboardScoringSupported } from '../src/scoreboard/scoreboardSportGuard.js';
import { hashControlToken } from '../src/scoreboard/scoreboardControlToken.js';
import { snapshotPartido, buildHistorialPuntoSnapshot } from '../utils/scoreboardLogic.js';

export const SYNTHETIC_TOKEN = 'synthetic-scoreboard-token-00000001';

export function fixture({ sport = 'pickleball', links = { torneo_id: 10 }, overrides = {} } = {}) {
  return {
    scoreboard_partidos: [{
      id: 'synthetic-scoreboard', sede_id: 1, ...links,
      equipo_a_nombre: 'A sintético', equipo_b_nombre: 'B sintético',
      estado: 'pendiente', score_a: 0, score_b: 0, games_a: 0, games_b: 0,
      sets_a: 0, sets_b: 0, saque_actual: 'A', es_tiebreak: false,
      historial_sets: [], historial_puntos: [], ultimo_punto: null,
      control_token_hash: hashControlToken(SYNTHETIC_TOKEN),
      ...overrides,
    }],
    torneos: [{ id: 10, deporte: sport }, { id: 11, deporte: 'padbol' }],
    partidos: [{ id: 20, torneo_id: 10 }],
    partidos_abiertos: [{ id: 30, deporte: sport }],
    scoreboard_historial_puntos: [], sedes: [{ id: 1, nombre: 'Sede sintética' }], canchas: [],
  };
}

function fixtureWithHistory(options) {
  const tables = fixture(options);
  const scoreboard = tables.scoreboard_partidos[0];
  Object.assign(scoreboard, { estado: 'en_curso', score_a: 0, games_a: 1, saque_actual: 'A' });
  const previous = { ...scoreboard, score_a: 40, games_a: 0, saque_actual: 'B' };
  scoreboard.historial_puntos = [snapshotPartido(previous)];
  tables.scoreboard_historial_puntos = [{
    id: 'synthetic-history-1', partido_id: scoreboard.id, ...buildHistorialPuntoSnapshot(previous, 'A'),
  }];
  return tables;
}

// Local Supabase-shaped fixture: projections are applied, so the sport cannot
// accidentally survive a SELECT that does not include it. Never uses transport.
export function memoryDb(tables, { failTable } = {}) {
  const writes = [];
  const reads = [];
  return {
    writes, reads,
    from(table) {
      let columns = '*'; let action = 'read'; let body; let max; let descending = false;
      const predicates = [];
      const api = {
        select(value = '*') { columns = value; return api; },
        eq(key, value) { predicates.push(row => String(row[key]) === String(value)); return api; },
        order(_key, options) { descending = options?.ascending === false; return api; },
        limit(value) { max = value; return api; },
        insert(value) { action = 'insert'; body = structuredClone(value); return api; },
        update(value) { action = 'update'; body = structuredClone(value); return api; },
        delete() { action = 'delete'; return api; },
        async maybeSingle() { const result = await execute(); return { ...result, data: result.data?.[0] ?? null }; },
        then(resolve, reject) { return execute().then(resolve, reject); },
      };
      async function execute() {
        if (table === failTable) return { data: null, error: { message: 'synthetic private database detail' } };
        const source = tables[table] ?? [];
        let rows = source.filter(row => predicates.every(p => p(row)));
        if (action === 'read') reads.push({ table, columns });
        else {
          writes.push({ table, action });
          if (action === 'insert') { rows = [{ id: `synthetic-history-${source.length}`, ...body }]; source.push(...rows); }
          if (action === 'update') rows.forEach(row => Object.assign(row, body));
          if (action === 'delete') tables[table] = source.filter(row => !rows.includes(row));
        }
        if (descending) rows = rows.toReversed();
        if (max != null) rows = rows.slice(0, max);
        const selected = columns.split(',').map(s => s.trim());
        const projected = rows.map(row => columns === '*' ? row : Object.fromEntries(selected.filter(key => key in row).map(key => [key, row[key]])));
        return { data: structuredClone(projected), error: null };
      }
      return api;
    },
  };
}

export function handlers(db, mount = mountScoreboardRoutes, { authenticated = true, role = 'super_admin', io = null } = {}) {
  const routes = new Map();
  const app = Object.fromEntries(['post', 'get', 'patch', 'delete'].map(method => [method, (path, ...chain) => routes.set(`${method} ${path}`, chain.at(-1))]));
  mount(app, {
    supabaseAdmin: db,
    getAuthenticatedUser: async () => authenticated ? { user: { id: 'synthetic-user' } } : { user: null, status: 401, error: 'No autorizado' },
    fetchUserRoleRowForAuthUser: async () => ({ role, sede_id: role === 'admin_sede' ? 2 : 1 }),
    io,
  });
  return async function invoke(path, params = {}, method = 'post', requestBody = {}) {
    let status = 200; let body;
    const response = { status(value) { status = value; return this; }, json(value) { body = value; return this; } };
    const previousLog = console.log; const previousError = console.error;
    console.log = () => {}; console.error = () => {};
    try {
      await routes.get(`${method} ${path}`)({ params: { id: 'synthetic-scoreboard', token: SYNTHETIC_TOKEN, ...params }, body: requestBody, query: {} }, response);
    } finally { console.log = previousLog; console.error = previousError; }
    return { status, body };
  };
}

for (const control of ['partidos/:id', 'control/:token']) {
  for (const action of ['punto/:equipo', 'saque', 'tiebreak', 'undo', 'deshacer', 'cronometro/:accion']) {
    test(`persisted Pickleball rejects ${control}/${action} before any write`, async () => {
      const tables = fixtureWithHistory(); const before = structuredClone(tables); const db = memoryDb(tables);
      const emissions = []; const io = { to: room => ({ emit: (...args) => emissions.push({ room, args }) }) };
      const response = await handlers(db, mountScoreboardRoutes, { io })(`/api/scoreboard/${control}/${action}`, { equipo: 'A', accion: 'reset' });
      assert.equal(response.status, 409);
      assert.equal(response.body.ok, false);
      assert.match(response.body.error, /Pickleball/);
      assert.deepEqual(db.writes, []);
      assert.deepEqual(tables, before);
      assert.deepEqual(emissions, []);
      assert.equal(db.reads.some(read => read.table === 'scoreboard_historial_puntos'), false);
      assert.ok(db.reads.some(read => read.table === 'torneos' && read.columns === 'id, deporte'));
    });
  }
}

for (const links of [{ partido_abierto_id: 30 }, { partido_torneo_id: 20 }, { partido_torneo_id: 20, torneo_id: 11 }, { partido_abierto_id: 30, torneo_id: 11 }]) {
  test(`persisted link ${JSON.stringify(links)} cannot be masked by a different sport`, async () => {
    const tables = fixture({ links }); const db = memoryDb(tables);
    assert.equal((await handlers(db)('/api/scoreboard/partidos/:id/punto/:equipo', { equipo: 'B' })).status, 409);
    assert.deepEqual(db.writes, []);
  });
}

test('normalizes persisted sport casing and whitespace only', async () => {
  const db = memoryDb(fixture({ sport: ' Pickleball ' }));
  await assert.rejects(assertScoreboardScoringSupported(db, { torneo_id: 10 }), error => error.status === 409);
});

for (const sport of ['padbol', 'padel', 'tenis']) {
  test(`${sport} retains point, serve, undo and tiebreak paths`, async () => {
    const tables = fixture({ sport }); const db = memoryDb(tables); const invoke = handlers(db);
    assert.equal((await invoke('/api/scoreboard/partidos/:id/punto/:equipo', { equipo: 'A' })).body.score_a, 15);
    assert.equal((await invoke('/api/scoreboard/partidos/:id/undo')).body.score_a, 0);
    assert.equal((await invoke('/api/scoreboard/control/:token/saque')).body.saque_actual, 'B');
    assert.equal((await invoke('/api/scoreboard/control/:token/tiebreak')).body.es_tiebreak, true);
  });
}

test('legacy rows without a sport link retain behavior; not represented as verified Pickleball', async () => {
  const db = memoryDb(fixture({ links: {} }));
  assert.equal((await handlers(db)('/api/scoreboard/partidos/:id/punto/:equipo', { equipo: 'A' })).body.score_a, 15);
  assert.equal(db.reads.some(row => ['torneos', 'partidos', 'partidos_abiertos'].includes(row.table)), false);
});

for (const missing of [false, true]) {
  test(`linked sport read ${missing ? 'missing' : 'fails'} stops before persistence with sanitized error`, async () => {
    const tables = fixture(); if (missing) tables.torneos = [];
    const db = memoryDb(tables, missing ? {} : { failTable: 'torneos' });
    const response = await handlers(db)('/api/scoreboard/partidos/:id/punto/:equipo', { equipo: 'A' });
    assert.equal(response.status, 409);
    assert.equal(response.body.error, 'No se pudo verificar el deporte del partido. Intentá nuevamente.');
    assert.deepEqual(db.writes, []);
  });
}

test('existing authentication and venue authorization run before sport lookup', async () => {
  for (const options of [{ authenticated: false }, { role: 'admin_sede' }]) {
    const db = memoryDb(fixture());
    const response = await handlers(db, mountScoreboardRoutes, options)('/api/scoreboard/partidos/:id/punto/:equipo', { equipo: 'A' });
    assert.equal(response.status, options.authenticated === false ? 401 : 403);
    assert.deepEqual(db.writes, []);
    assert.equal(db.reads.some(read => read.table === 'torneos'), false);
  }
});

test('Pickleball historical reads and timer remain available without changing sport or scores', async () => {
  const tables = fixture(); const db = memoryDb(tables); const invoke = handlers(db);
  const response = await invoke('/api/scoreboard/partidos/:id', {}, 'get');
  assert.equal(response.status, 200);
  assert.equal((await invoke('/api/scoreboard/partidos/:id/cronometro/:accion', { accion: 'pause' })).status, 200);
  assert.equal(tables.scoreboard_partidos[0].score_a, 0);
});

for (const patch of [{ saque_actual: 'B' }, { torneo_id: null }, { torneo_id: 11 }]) {
  test(`generic PATCH cannot bypass containment: ${JSON.stringify(patch)}`, async () => {
    const tables = fixture(); const before = structuredClone(tables); const db = memoryDb(tables);
    const response = await handlers(db)('/api/scoreboard/partidos/:id', {}, 'patch', patch);
    assert.equal(response.status, 409);
    assert.deepEqual(db.writes, []);
    assert.deepEqual(tables, before);
  });
}

test('Pickleball visual edits and supported-sport serve PATCH remain available', async () => {
  const pickleDb = memoryDb(fixture());
  assert.equal((await handlers(pickleDb)('/api/scoreboard/partidos/:id', {}, 'patch', { color_a: '#123456' })).status, 200);
  const padbolDb = memoryDb(fixture({ sport: 'padbol' }));
  const response = await handlers(padbolDb)('/api/scoreboard/partidos/:id', {}, 'patch', { saque_actual: 'B' });
  assert.equal(response.status, 200);
  assert.equal(response.body.saque_actual, 'B');
});

test('thrown lookup errors and orphan tournament matches fail closed without leaking details', async () => {
  const throwingDb = { from() { throw Error('synthetic private detail'); } };
  await assert.rejects(assertScoreboardScoringSupported(throwingDb, { torneo_id: 10 }), error => error.status === 409 && !error.message.includes('private'));
  const tables = fixture(); tables.partidos[0].torneo_id = null;
  const db = memoryDb(tables);
  await assert.rejects(assertScoreboardScoringSupported(db, { partido_torneo_id: 20 }), error => error.status === 409);
  assert.deepEqual(db.writes, []);
});

for (const links of [{ torneo_id: 11 }, {}]) {
  test(`PATCH verifies incoming tournament before linking or changing serve: ${JSON.stringify(links)}`, async () => {
    for (const patch of [{ torneo_id: 10 }, { torneo_id: 10, saque_actual: 'B' }]) {
      const tables = fixture({ links }); const before = structuredClone(tables); const db = memoryDb(tables);
      const response = await handlers(db)('/api/scoreboard/partidos/:id', {}, 'patch', patch);
      assert.equal(response.status, 409); assert.match(response.body.error, /Pickleball/);
      assert.deepEqual(db.writes, []); assert.deepEqual(tables, before);
    }
  });
}

test('PATCH missing proposed tournament fails closed; verified supported destination remains editable', async () => {
  const missingTables = fixture({ sport: 'padbol' }); const before = structuredClone(missingTables);
  const missingDb = memoryDb(missingTables);
  const missing = await handlers(missingDb)('/api/scoreboard/partidos/:id', {}, 'patch', { torneo_id: 999, saque_actual: 'B' });
  assert.equal(missing.status, 409); assert.match(missing.body.error, /verificar el deporte/);
  assert.deepEqual(missingDb.writes, []); assert.deepEqual(missingTables, before);
  const supportedDb = memoryDb(fixture({ sport: 'tenis' }));
  const supported = await handlers(supportedDb)('/api/scoreboard/partidos/:id', {}, 'patch', { torneo_id: 11, saque_actual: 'B' });
  assert.equal(supported.status, 200); assert.equal(supported.body.torneo_id, 11); assert.equal(supported.body.saque_actual, 'B');
});

for (const sport of ['padbol', 'padel', 'tenis']) {
  for (const control of ['partidos/:id', 'control/:token']) {
    test(`${sport} retains ${control} history restoration and full reset`, async () => {
      for (const action of ['undo', 'deshacer', 'cronometro/:accion']) {
        const tables = fixtureWithHistory({ sport }); const db = memoryDb(tables);
        const response = await handlers(db)(`/api/scoreboard/${control}/${action}`, { accion: 'reset' });
        assert.equal(response.status, 200);
        assert.ok(db.writes.some(write => write.table === 'scoreboard_partidos'));
        const scoreboard = tables.scoreboard_partidos[0];
        if (action === 'cronometro/:accion') {
          assert.equal(scoreboard.games_a, 0); assert.equal(scoreboard.score_a, 0);
          assert.equal(scoreboard.saque_actual, 'A'); assert.deepEqual(scoreboard.historial_puntos, []);
        } else {
          assert.equal(scoreboard.score_a, 40); assert.equal(scoreboard.games_a, 0); assert.equal(scoreboard.saque_actual, 'B');
        }
        assert.equal(tables.scoreboard_historial_puntos.length, action === 'undo' ? 0 : 1);
      }
    });
  }
}

for (const control of ['partidos/:id', 'control/:token']) {
  test(`Pickleball ${control} timer start/pause preserve sporting state and both histories`, async () => {
    const tables = fixtureWithHistory(); const scoreboard = tables.scoreboard_partidos[0];
    const before = snapshotPartido(scoreboard); const embeddedBefore = structuredClone(scoreboard.historial_puntos);
    const externalBefore = structuredClone(tables.scoreboard_historial_puntos);
    const db = memoryDb(tables); const invoke = handlers(db);
    for (const accion of ['start', 'pause']) {
      assert.equal((await invoke(`/api/scoreboard/${control}/cronometro/:accion`, { accion })).status, 200);
      assert.deepEqual(snapshotPartido(scoreboard), before);
      assert.deepEqual(scoreboard.historial_puntos, embeddedBefore);
      assert.deepEqual(tables.scoreboard_historial_puntos, externalBefore);
      assert.equal(scoreboard.cronometro_pausado, accion === 'pause');
    }
  });
}

test('contradictory links cannot hide Pickleball discovered last', async () => {
  for (const viaOpen of [false, true]) {
    const tables = fixture({ sport: 'padbol', links: viaOpen ? { partido_abierto_id: 30, torneo_id: 11 } : { torneo_id: 10, partido_torneo_id: 20 } });
    tables.torneos[1].deporte = 'pickleball'; tables.partidos[0].torneo_id = 11;
    const db = memoryDb(tables);
    const result = await handlers(db)('/api/scoreboard/control/:token/punto/:equipo', { equipo: 'A' });
    assert.equal(result.status, 409); assert.match(result.body.error, /Pickleball/); assert.deepEqual(db.writes, []);
  }
});

test('invalid and revoked tokens retain 401 before sport lookup for restored/reset paths', async () => {
  for (const revoked of [false, true]) for (const action of ['undo', 'deshacer', 'cronometro/:accion']) {
    const tables = fixtureWithHistory();
    if (revoked) tables.scoreboard_partidos[0].control_token_revoked_at = '2026-09-11T01:00:00Z';
    const db = memoryDb(tables);
    const response = await handlers(db)(`/api/scoreboard/control/:token/${action}`, {
      accion: 'reset', token: revoked ? SYNTHETIC_TOKEN : 'synthetic-invalid-token-00000002',
    });
    assert.equal(response.status, 401); assert.deepEqual(db.writes, []);
    assert.equal(db.reads.some(read => read.table === 'torneos'), false);
  }
});

test('admin permissions retain precedence on PATCH, undo, deshacer and reset', async () => {
  for (const options of [{ authenticated: false }, { role: 'admin_sede' }, { role: 'jugador' }]) {
    for (const action of ['undo', 'deshacer', 'cronometro/:accion', 'patch']) {
      const db = memoryDb(fixtureWithHistory());
      const response = await handlers(db, mountScoreboardRoutes, options)(
        `/api/scoreboard/partidos/:id${action === 'patch' ? '' : `/${action}`}`, { accion: 'reset' },
        action === 'patch' ? 'patch' : 'post', { torneo_id: 10, saque_actual: 'B' },
      );
      assert.equal(response.status, options.authenticated === false ? 401 : 403);
      assert.deepEqual(db.writes, []); assert.equal(db.reads.some(read => read.table === 'torneos'), false);
    }
  }
  const db = memoryDb(fixtureWithHistory());
  const response = await handlers(db, mountScoreboardRoutes, { role: 'admin_club' })('/api/scoreboard/partidos/:id/undo');
  assert.equal(response.status, 409); assert.match(response.body.error, /Pickleball/);
});

test('terminal states and invalid actions preserve status precedence', async () => {
  for (const estado of ['terminado', 'finalizado']) for (const control of ['partidos/:id', 'control/:token']) {
    for (const action of ['punto/:equipo', 'undo', 'deshacer', 'cronometro/:accion']) {
      const db = memoryDb(fixture({ overrides: { estado } }));
      const response = await handlers(db)(`/api/scoreboard/${control}/${action}`, { equipo: 'A', accion: 'reset' });
      assert.equal(response.status, 400); assert.equal(response.body.ok, false); assert.deepEqual(db.writes, []);
      assert.equal(db.reads.some(read => read.table === 'torneos'), false);
    }
  }
  const db = memoryDb(fixture()); const invoke = handlers(db);
  assert.equal((await invoke('/api/scoreboard/control/:token/punto/:equipo', { equipo: 'X' })).status, 400);
  assert.equal((await invoke('/api/scoreboard/control/:token/cronometro/:accion', { accion: 'unknown' })).status, 400);
  assert.deepEqual(db.writes, []);
});

test('visual PATCH ignores attempted score and request-only sport fields', async () => {
  const tables = fixtureWithHistory(); const before = snapshotPartido(tables.scoreboard_partidos[0]); const db = memoryDb(tables);
  const response = await handlers(db)('/api/scoreboard/partidos/:id', {}, 'patch', { color_a: '#123456', deporte: 'padbol', score_a: 99, partido_abierto_id: null });
  assert.equal(response.status, 200);
  assert.deepEqual(snapshotPartido(tables.scoreboard_partidos[0]), before);
  assert.equal(tables.scoreboard_partidos[0].deporte, undefined);
  assert.equal(tables.scoreboard_partidos[0].color_a, '#123456');
});

test('reserve-only and empty sports remain unverified legacy, never inferred from name', async () => {
  for (const linked of [false, true]) {
    const tables = fixture({ links: linked ? { torneo_id: 10 } : { reserva_id: 90 }, sport: '', overrides: { torneo_nombre: 'Pickleball', equipo_a_nombre: 'Pickleball A' } });
    const db = memoryDb(tables);
    const response = await handlers(db)('/api/scoreboard/partidos/:id/punto/:equipo', { equipo: 'A' }, 'post', { deporte: 'pickleball' });
    assert.equal(response.status, 200); assert.equal(response.body.score_a, 15);
  }
});
