import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { getManualPlayedDateCapability, mountManualPlayedDateCapabilityRoute } from './torneos/manualPlayedDateCapabilityService.js';
import { MANUAL_PLAYED_DATE_CAPABILITY } from './torneos/manualPlayedDateCapability.js';

const ACTOR = '10000000-0000-4000-8000-000000000001';
const OTHER = '10000000-0000-4000-8000-000000000002';
const NOW = new Date('2026-09-10T20:00:00.000Z');
const scope = { torneoId: 1, partidoId: 2, actorId: ACTOR };
const on = { capabilities: { writeEnabled: true, readEnabled: false }, now: () => NOW };
const off = { now: () => NOW };
const declaration = { fecha_juego: '2026-09-09', procedencia: 'declaracion_operador', revision: 1,
  vigente: true, registrado_at: '2026-09-10T18:00:00Z', actualizado_at: '2026-09-10T18:00:00Z' };
const finalMatch = { estado: 'finalizado', resultado: { goles_a: 2, goles_b: 0, fuente_resultado: 'manual_admin' }, ganador_equipo_id: 10 };

// Deliberately no mutations or generic RPCs: using either makes every scenario fail.
function fixture({ tournament = {}, match = {}, roles, teams, date = null, rpcError, queryError, missing = [] } = {}) {
  const data = {
    torneos: { id: 1, sede_id: 3, deporte: 'padbol', formato_equipo: 'dobles', estado: 'en_curso', ...tournament },
    partidos: { id: 2, torneo_id: 1, sede_id: 3, estado: 'pendiente', resultado: null, equipo_a_id: 10, equipo_b_id: 11, ganador_equipo_id: null, ...match },
    user_roles: roles ?? [{ user_id: ACTOR, role: 'admin_club', sede_id: 3 }],
    equipos: teams ?? [10, 11].map(id => ({ id, torneo_id: 1, sede_id: 3, inscripcion_estado: 'confirmado' })),
  };
  const reads = [], rpcs = [];
  const db = {
    from(table) {
      assert(Object.hasOwn(data, table), `Unexpected table ${table}; no historical participants read`);
      const call = { table, filters: [] }; reads.push(call);
      const reply = () => ({ data: missing.includes(table) ? null : data[table], error: queryError === table ? { message: 'private database detail', code: 'XX000' } : null });
      return {
        select(columns) { call.columns = columns; assert(!/jugadores|participantes|email|telefono/.test(columns)); return this; },
        eq(column, value) { call.filters.push([column, value]); return this; },
        in(column, values) { call.filters.push([column, values]); return this; },
        limit(value) { call.limit = value; return this; },
        maybeSingle: async () => reply(),
        then(resolve, reject) { return Promise.resolve(reply()).then(resolve, reject); },
      };
    },
    async rpc(name, params) {
      assert.equal(name, 'leer_fecha_juego_manual');
      rpcs.push({ name, params });
      assert.deepEqual(params, { p_torneo_id: 1, p_partido_id: 2, p_actor_id: ACTOR });
      return { data: date, error: rpcError ?? null };
    },
  };
  return { db, reads, rpcs, data };
}
async function expectDenied(f, status, options = on) {
  await assert.rejects(getManualPlayedDateCapability(f.db, scope, options), error => error.status === status);
  assert.equal(f.rpcs.length, 0);
}
const expectedOff = { schema: 'torneo-manual-date/v1', enabled: false, user_id: ACTOR,
  torneo_id: 1, partido_id: 2, sede_id: 3, operations: { declare: false, correct: false },
  expires_at: '2026-09-10T20:01:00.000Z' };

test('default OFF returns scoped minimal web DTO without private SQL or team reads', async () => {
  const f = fixture();
  assert.deepEqual(await getManualPlayedDateCapability(f.db, scope, off), expectedOff);
  assert.deepEqual(f.reads.map(r => r.table).sort(), ['partidos', 'torneos', 'user_roles']);
  assert.equal(f.rpcs.length, 0);
  assert.equal(f.reads.find(r => r.table === 'user_roles').limit, 2);
  assert.deepEqual(MANUAL_PLAYED_DATE_CAPABILITY, { writeEnabled: false, readEnabled: false });
  assert(Object.isFrozen(MANUAL_PLAYED_DATE_CAPABILITY));
});
for (const flags of [{ readEnabled: true }, { writeEnabled: 'true' }, { writeEnabled: 1 }, null]) {
  test(`read-only/truthy/missing capability does not enable form: ${JSON.stringify(flags)}`, async () => {
    const f = fixture();
    assert.deepEqual(await getManualPlayedDateCapability(f.db, scope, { ...off, capabilities: flags }), expectedOff);
    assert.equal(f.rpcs.length, 0);
  });
}
for (const [name, roles] of [
  ['no bound role', []], ['unbound email role', [{ user_id: null, role: 'super_admin' }]],
  ['another actor', [{ user_id: OTHER, role: 'super_admin' }]],
  ['club without venue', [{ user_id: ACTOR, role: 'admin_club', sede_id: null }]],
  ['club another venue', [{ user_id: ACTOR, role: 'admin_club', sede_id: 4 }]],
  ...['admin_nacional', 'empleado', 'editor', 'jugador', null].map(role => [String(role), [{ user_id: ACTOR, role, sede_id: 3 }]]),
  ['duplicate bound roles', Array(2).fill({ user_id: ACTOR, role: 'super_admin', sede_id: null })],
]) {
  test(`rejects ${name}, including while OFF`, async () => {
    for (const options of [off, on]) await expectDenied(fixture({ roles }), 403, options);
  });
}
test('bound super admin may have no role venue but must have a persisted valid match venue', async () => {
  const f = fixture({ roles: [{ user_id: ACTOR, role: 'super_admin', sede_id: null }] });
  assert.equal((await getManualPlayedDateCapability(f.db, scope, on)).enabled, true);
});
test('invalid route IDs and JWT IDs are rejected before any data read', async () => {
  for (const bad of [0, -1, 1.2, true, '', '1.0', '01', '1e0', 'Infinity', Number.MAX_SAFE_INTEGER + 1]) {
    for (const column of ['torneoId', 'partidoId']) {
      const f = fixture();
      await assert.rejects(getManualPlayedDateCapability(f.db, { ...scope, [column]: bad }, on), { status: 400 });
      assert.equal(f.reads.length, 0);
    }
  }
  for (const actorId of [null, undefined, 'spoofed']) {
    const f = fixture();
    await assert.rejects(getManualPlayedDateCapability(f.db, { ...scope, actorId }, on), { status: 401 });
    assert.equal(f.reads.length, 0);
  }
});
test('missing/mismatched tournament or match cannot expose a capability', async () => {
  for (const options of [{ missing: ['torneos'] }, { missing: ['partidos'] }, { match: { torneo_id: 4 } }, { match: { id: 5 } }, { tournament: { id: 4 } }]) await expectDenied(fixture(options), 404);
});
test('missing or different persisted venue is denied even to super admin', async () => {
  for (const options of [{ tournament: { sede_id: null } }, { match: { sede_id: null } }, { match: { sede_id: 4 } }]) {
    await expectDenied(fixture({ ...options, roles: [{ user_id: ACTOR, role: 'super_admin' }] }), 403);
  }
});
test('scope and role query errors fail closed with no private details', async () => {
  for (const queryError of ['torneos', 'partidos', 'user_roles', 'equipos']) {
    const f = fixture({ queryError });
    await assert.rejects(getManualPlayedDateCapability(f.db, scope, on), error => error.status === 503 && !error.message.includes('private'));
    assert.equal(f.rpcs.length, 0);
  }
});
test('new confirmed Padbol doubles match permits declare only through trusted server gate', async () => {
  const f = fixture();
  assert.deepEqual(await getManualPlayedDateCapability(f.db, scope, on), { ...expectedOff, enabled: true, operations: { declare: true, correct: false } });
  assert.equal(f.rpcs.length, 1);
  assert.deepEqual(f.reads.find(r => r.table === 'equipos').filters, [['id', [10, 11]]]);
});
test('final manual with valid declaration permits correction AND same-data retry', async () => {
  const f = fixture({ match: finalMatch, date: declaration });
  assert.deepEqual(await getManualPlayedDateCapability(f.db, scope, on), { ...expectedOff, enabled: true, operations: { declare: true, correct: true } });
  assert(!f.reads.some(r => r.table === 'equipos')); // No reconstruction from current roster.
});
test('legacy manual without date permits declaration without inventing a historical roster', async () => {
  const f = fixture({ match: { ...finalMatch, resultado: JSON.stringify({ set1: { a: 6, b: 2 }, set2: { a: 6, b: 3 }, ganador_id: 10 }), ganador_equipo_id: null }, teams: [] });
  const result = await getManualPlayedDateCapability(f.db, scope, on);
  assert.deepEqual(result.operations, { declare: true, correct: false });
  assert(!f.reads.some(r => r.table === 'equipos'));
});
test('closed tournament can correct its existing manual declaration without changing digital closure', async () => {
  const f = fixture({ tournament: { estado: 'finalizado' }, match: finalMatch, date: declaration, teams: [] });
  assert.equal((await getManualPlayedDateCapability(f.db, scope, on)).operations.correct, true);
});
for (const [name, options] of [
  ['digital result', { match: { ...finalMatch, resultado: { goles_a: 2, goles_b: 0, fuente_resultado: 'scoreboard' } } }],
  ['unknown source', { match: { ...finalMatch, resultado: { goles_a: 2, goles_b: 0 } } }],
  ['unknown winner', { match: { ...finalMatch, ganador_equipo_id: null } }],
  ['different winner', { match: { ...finalMatch, ganador_equipo_id: 999 } }],
  ['non Padbol', { tournament: { deporte: 'padel' } }],
  ['non doubles', { tournament: { formato_equipo: 'individual' } }],
  ['same team', { match: { equipo_b_id: 10 } }],
  ['missing team', { match: { equipo_a_id: null } }],
  ['cancelled match', { match: { estado: 'cancelado' } }],
  ['new result in closed tournament', { tournament: { estado: 'finalizado' } }],
  ['existing partial result', { match: { resultado: { goles_a: 1, goles_b: 0 } } }],
]) {
  test(`operation not offered for ${name}`, async () => {
    const f = fixture(options);
    assert.deepEqual(await getManualPlayedDateCapability(f.db, scope, on), expectedOff);
    assert.equal(f.rpcs.length, 0);
  });
}
test('new result rejects unconfirmed, absent, cross-scope or duplicate teams', async () => {
  const baseline = fixture().data.equipos;
  const variants = [[], baseline.slice(0, 1), [baseline[0], baseline[0]], ...[
    { torneo_id: 99 }, { sede_id: 99 }, { inscripcion_estado: 'pendiente' }, { id: 99 },
  ].map(change => [{ ...baseline[0], ...change }, baseline[1]])];
  for (const teams of variants) {
    const f = fixture({ teams });
    assert.deepEqual(await getManualPlayedDateCapability(f.db, scope, on), expectedOff);
    assert.equal(f.rpcs.length, 0);
  }
});
test('invalidated declaration or declaration attached to unfinished match stays unavailable', async () => {
  for (const options of [{ match: finalMatch, date: { ...declaration, vigente: false } }, { date: declaration }]) {
    const f = fixture(options);
    assert.deepEqual(await getManualPlayedDateCapability(f.db, scope, on), expectedOff);
    assert.equal(f.rpcs.length, 1);
  }
});
test('permission revoked between initial reads and private SQL read denies capability', async () => {
  const f = fixture({ rpcError: { code: '42501', message: 'private revoked role detail' } });
  await assert.rejects(getManualPlayedDateCapability(f.db, scope, on), error => error.status === 403 && !error.message.includes('private'));
  assert.equal(f.rpcs.length, 1);
});
test('private SQL absence or malformed declaration is unavailable, never inferred enabled', async () => {
  for (const options of [{ rpcError: { code: '42883', message: 'private missing schema' } }, { date: {} }]) {
    const f = fixture(options);
    await assert.rejects(getManualPlayedDateCapability(f.db, scope, on), error => error.status === 503 && !error.message.includes('private'));
  }
});

function routeFixture(f, { authenticate, capabilities, now = () => NOW } = {}) {
  const registrations = [];
  const app = { get: (path, handler) => registrations.push({ path, handler }) };
  mountManualPlayedDateCapabilityRoute(app, { supabaseAdmin: f.db,
    getAuthenticatedUser: authenticate ?? (async () => ({ user: { id: ACTOR } })), capabilities, now });
  assert.equal(registrations.length, 1);
  assert.equal(registrations[0].path, '/api/torneos/:torneoId/partidos/:partidoId/fecha-juego/capacidad');
  return async (changes = {}) => {
    const response = { statusCode: 200, headers: {}, set(key, val) { this.headers[key] = val; return this; },
      vary(key) { this.headers.Vary = key; return this; }, status(code) { this.statusCode = code; return this; },
      json(body) { this.body = body; return this; } };
    await registrations[0].handler({ params: { torneoId: '1', partidoId: '2' }, body: {}, query: {}, ...changes }, response);
    assert.equal(response.headers['Cache-Control'], 'private, no-store');
    assert.equal(response.headers.Pragma, 'no-cache');
    assert.equal(response.headers.Vary, 'Authorization');
    return response;
  };
}
test('mounted GET uses verified JWT and ignores client flags, actor, venue and expiry', async () => {
  const f = fixture();
  const response = await routeFixture(f)({ body: { actor_id: OTHER, sede_id: 99, writeEnabled: true }, query: { user_id: OTHER, enabled: true, expires_at: '2999-01-01' } });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, expectedOff);
  assert.equal(f.rpcs.length, 0);
  assert.deepEqual(f.reads.find(r => r.table === 'user_roles').filters, [['user_id', ACTOR]]);
});
test('mount rejects missing JWT identity before querying any capability data', async () => {
  const f = fixture();
  const response = await routeFixture(f, { authenticate: async () => ({ user: null, status: 401, error: 'private auth detail' }) })();
  assert.equal(response.statusCode, 401);
  assert.equal(f.reads.length, 0);
  assert(!JSON.stringify(response.body).includes('private auth detail'));
});
test('legacy role claims alone cannot bypass the bound private-contract role', async () => {
  const f = fixture({ roles: [] });
  const response = await routeFixture(f, { authenticate: async () => ({ user: { id: ACTOR }, role: 'super_admin', sedeId: 3 }), capabilities: on.capabilities })();
  assert.equal(response.statusCode, 403);
  assert.equal(f.rpcs.length, 0);
  assert.equal(response.body.enabled, undefined);
});
test('scope syntax is rejected before JWT verification', async () => {
  const f = fixture();
  const response = await routeFixture(f, { authenticate: async () => assert.fail('invalid scope reached auth') })({ params: { torneoId: '1', partidoId: '2.1' } });
  assert.equal(response.statusCode, 400);
  assert.equal(f.reads.length, 0);
});
test('route error response never exposes private query messages or auth tokens', async () => {
  const f = fixture({ queryError: 'partidos' });
  const response = await routeFixture(f)();
  assert.equal(response.statusCode, 503);
  assert(!JSON.stringify(response.body).includes('private database detail'));
});
test('server mounts read-only capability with both existing flags still OFF', () => {
  const server = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  assert(server.includes('mountManualPlayedDateCapabilityRoute(app, { supabaseAdmin, getAuthenticatedUser, capabilities: MANUAL_PLAYED_DATE_CAPABILITY });'));
  assert(server.includes('mountManualPlayedDateRoutes(app, { supabaseAdmin, requireTorneoAdminByTorneoId, enabled: MANUAL_PLAYED_DATE_CAPABILITY.writeEnabled });'));
});
test('unexpected auth or transport exceptions expose only a generic safe error', async () => {
  for (const thrown of [Object.assign(new Error('private detail'), { code: 'private token', status: 999 }), null]) {
    const f = fixture();
    const response = await routeFixture(f, { authenticate: async () => { throw thrown; } })();
    assert.equal(response.statusCode, 503);
    assert.equal(response.body.code, 'MANUAL_DATE_CAPABILITY_UNAVAILABLE');
    assert.equal(f.reads.length, 0);
  }
});
