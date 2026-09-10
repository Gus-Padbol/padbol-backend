import assert from 'node:assert/strict';

import test from 'node:test';

import { resolveSedesPermitidasPorScope } from './adminTerritorialScope.js';

import {
  adminPushCategoryForSegment,
  buildAdminPushIdempotencyKey,
  resolveAdminPushRecipientUserIds,
  searchAdminPushPlayers,
  validateAdminPushSegment,
} from './adminPushNotifications.js';

function createReadOnlySupabase(seed = {}) {
  return {
    from(table) {
      const state = { table, select: '*', eq: [], ilike: [] };
      const query = {
        select(value) { state.select = value; return query; },
        eq(column, value) { state.eq.push([column, value]); return query; },
        ilike(column, value) { state.ilike.push([column, String(value).toLowerCase()]); return query; },
        not() { return query; },
        in(column, values) { state.eq.push([column, new Set(values)]); return query; },
        order() { return query; },
        gte() { return query; },
        limit(limit) { return Promise.resolve(compute(limit)); },
        range(from, to) {
          const result = compute();
          return Promise.resolve({ data: result.data.slice(from, to + 1), error: result.error });
        },
        maybeSingle() {
          const result = compute(2);
          return Promise.resolve({ data: result.data[0] || null, error: result.error });
        },
        then(resolve, reject) { return Promise.resolve(compute()).then(resolve, reject); },
      };
      function compute(limit = Infinity) {
        let rows = [...(seed[state.table] || [])];
        for (const [column, expected] of state.eq) {
          rows = rows.filter((row) => expected instanceof Set
            ? expected.has(row[column])
            : String(row[column]) === String(expected));
        }
        for (const [column, expected] of state.ilike) {
          rows = rows.filter((row) => String(row[column] || '').toLowerCase() === expected);
        }
        return { data: rows.slice(0, limit), error: null };
      }
      return query;
    },
  };
}

const PLAYER_A = {
  user_id: '00000000-0000-4000-8000-000000000001',
  email: 'ana@example.com',
  nombre: 'Ana',
  apellido: 'Pérez',
  pais: 'Argentina',
  ciudad: 'La Plata',
  sede_id: 10,
};

const PLAYER_B = {
  user_id: '00000000-0000-4000-8000-000000000002',
  email: 'bea@example.com',
  nombre: 'Bea',
  apellido: 'Silva',
  pais: 'Brasil',
  ciudad: 'São Paulo',
  sede_id: 20,
};

test('un admin de club no puede elegir por user_id un jugador fuera de su sede', async () => {
  const supabase = createReadOnlySupabase({
    jugadores_perfil: [PLAYER_A, PLAYER_B],
    reservas: [],
  });
  await assert.rejects(
    validateAdminPushSegment(
      { rol: 'admin_club', sedeId: 10, authUserId: 'admin-1' },
      { type: 'jugador', userId: PLAYER_B.user_id },
      {
        supabase,
        sedesPermitidasPorScopeFn: async () => ({ sedes: [{ id: 10 }] }),
      },
    ),
    (error) => error.status === 403 && error.code === 'ADMIN_PUSH_TARGET_OUT_OF_SCOPE',
  );
});

test('la búsqueda individual de una cadena se filtra por sus sedes', async () => {
  const supabase = createReadOnlySupabase({
    organizaciones: [{ id: 'chain-1', estado: 'activa', funciones_habilitadas: ['notificaciones'] }],
    jugadores_perfil: [PLAYER_A, PLAYER_B],
    reservas: [],
  });
  const scope = { rol: 'admin_cadena', organizacionId: 'chain-1', authUserId: 'admin-chain' };
  const allowed = async () => ({ sedes: [{ id: 10 }] });
  assert.deepEqual(
    (await searchAdminPushPlayers(supabase, scope, 'example', allowed)).map((row) => row.user_id),
    [PLAYER_A.user_id],
  );
});

test('una cadena sin la función habilitada tampoco puede enviar a un individuo', async () => {
  const supabase = createReadOnlySupabase({
    organizaciones: [{ id: 'chain-1', estado: 'activa', funciones_habilitadas: [] }],
    jugadores_perfil: [PLAYER_A],
    reservas: [],
  });
  await assert.rejects(
    validateAdminPushSegment(
      { rol: 'admin_cadena', organizacionId: 'chain-1', authUserId: 'admin-chain' },
      { type: 'jugador', userId: PLAYER_A.user_id },
      { supabase, sedesPermitidasPorScopeFn: async () => ({ sedes: [{ id: 10 }] }) },
    ),
    (error) => error.status === 403 && error.code === 'ADMIN_PUSH_SCOPE_DENIED',
  );
});

test('un admin nacional sólo puede segmentar ciudades de su ámbito', async () => {
  const supabase = createReadOnlySupabase({ jugadores_perfil: [PLAYER_A, PLAYER_B] });
  const scope = { rol: 'admin_nacional', pais: 'Argentina', authUserId: 'admin-ar' };
  const segment = await validateAdminPushSegment(
    scope,
    { type: 'ciudad', ciudad: 'La Plata' },
    {
      supabase,
      sedesPermitidasPorScopeFn: async () => ({ sedes: [{ id: 10, ciudad: 'La Plata' }] }),
    },
  );
  assert.deepEqual(segment, { type: 'ciudad', ciudad: 'La Plata', pais: 'Argentina' });
  await assert.rejects(
    validateAdminPushSegment(
      scope,
      { type: 'ciudad', ciudad: 'São Paulo' },
      {
        supabase,
        sedesPermitidasPorScopeFn: async () => ({ sedes: [{ id: 10, ciudad: 'La Plata' }] }),
      },
    ),
    (error) => error.status === 403 && error.code === 'ADMIN_PUSH_TARGET_OUT_OF_SCOPE',
  );
});

test('la idempotencia manual queda aislada por administrador', () => {
  const clientKey = 'd7c58a9b-9edf-4632-8974-0e7786d78db1';
  assert.equal(
    buildAdminPushIdempotencyKey('admin-a', clientKey),
    `admin:admin-a:${clientKey}`,
  );
  assert.notEqual(
    buildAdminPushIdempotencyKey('admin-a', clientKey),
    buildAdminPushIdempotencyKey('admin-b', clientKey),
  );
});

test('todo texto libre del panel requiere preferencia de marketing, incluso individual', () => {
  assert.equal(adminPushCategoryForSegment({ type: 'todos_usuarios' }), 'marketing');
  assert.equal(adminPushCategoryForSegment({ type: 'jugador', userId: PLAYER_A.user_id }), 'marketing');
});

test('los segmentos masivos recorren más de una página de perfiles', async () => {
  const profiles = Array.from({ length: 1001 }, (_, index) => ({
    user_id: `user-${index}`,
    pais: 'Argentina',
  }));
  const supabase = createReadOnlySupabase({ jugadores_perfil: profiles });
  const users = await resolveAdminPushRecipientUserIds(
    supabase,
    { rol: 'super_admin', authUserId: 'admin-1' },
    { type: 'todos_usuarios' },
  );
  assert.equal(users.length, 1001);
  assert.equal(users.at(-1), 'user-1000');
});

const TERRITORY_PLAYERS = [
  { ...PLAYER_A, ciudad: 'San José' },
  { ...PLAYER_B, pais: 'Argentina', ciudad: 'San José' },
  { ...PLAYER_B, user_id: 'foreign', email: 'foreign@example.com', pais: 'España', ciudad: 'San José', sede_id: 30 },
  { ...PLAYER_A, user_id: 'unassigned', email: 'unassigned@example.com', sede_id: null },
];

const TERRITORY_VENUES = [
  { id: 10, pais: 'Argentina', provincia: 'Córdoba', ciudad: 'San José' },
  { id: 20, pais: 'Argentina', provincia: 'Entre Ríos', ciudad: 'San José' },
  { id: 30, pais: 'España', provincia: 'Córdoba', ciudad: 'San José' },
];

for (const alcance of ['ciudad', 'provincia']) {
  test(`push ${alcance}: búsqueda, individuo y ciudad se limitan a sedes autorizadas`, async () => {
    const supabase = createReadOnlySupabase({ jugadores_perfil: TERRITORY_PLAYERS, sedes: TERRITORY_VENUES, reservas: [] });
    const scope = { rol: 'admin_nacional', alcance, pais: 'Argentina', provincia: 'Córdoba', ciudad: 'San José', authUserId: 'regional' };
    const allowed = (currentScope) => resolveSedesPermitidasPorScope(supabase, currentScope);
    const deps = { supabase, sedesPermitidasPorScopeFn: allowed };

    await assert.rejects(validateAdminPushSegment(scope, { type: 'todos_pais' }, deps), (error) => error.status === 403);
    for (const player of TERRITORY_PLAYERS.slice(1)) {
      await assert.rejects(validateAdminPushSegment(scope, { type: 'jugador', userId: player.user_id }, deps), (error) => error.status === 403 && error.code === 'ADMIN_PUSH_TARGET_OUT_OF_SCOPE');
    }
    const individual = await validateAdminPushSegment(scope, { type: 'jugador', userId: PLAYER_A.user_id }, deps);
    assert.equal(individual.userId, PLAYER_A.user_id);
    assert.deepEqual((await searchAdminPushPlayers(supabase, scope, 'example', allowed)).map((row) => row.user_id), [PLAYER_A.user_id]);

    const segment = await validateAdminPushSegment(scope, { type: 'ciudad', ciudad: 'San José', pais: 'España', sedeIds: [20, 30] }, deps);
    assert.deepEqual(segment.sedeIds, [10]);
    assert.equal(segment.pais, 'Argentina');
    assert.deepEqual(await resolveAdminPushRecipientUserIds(supabase, scope, segment), [PLAYER_A.user_id]);
    await assert.rejects(validateAdminPushSegment(scope, { type: 'sede', sedeId: 20 }, deps), (error) => error.status === 403);
  });
}

test('push territorial incompleto falla cerrado antes de consultar perfiles', async () => {
  const supabase = { from() { throw new Error('no debe consultar perfiles'); } };
  for (const scope of [
    { rol: 'admin_nacional', alcance: 'ciudad', ciudad: 'San José', pais: 'Argentina' },
    { rol: 'admin_nacional', alcance: 'provincia', provincia: 'Córdoba' },
    { rol: 'admin_nacional', alcance: 'pais', pais: '' },
  ]) {
    const deps = { supabase, sedesPermitidasPorScopeFn: async () => ({ sedes: [] }) };
    for (const segment of [{ type: 'todos_pais' }, { type: 'jugador', userId: PLAYER_A.user_id }, { type: 'ciudad', ciudad: 'San José' }]) {
      await assert.rejects(validateAdminPushSegment(scope, segment, deps), (error) => error.status === 403 && error.code === 'ADMIN_PUSH_SCOPE_DENIED');
    }
    await assert.rejects(searchAdminPushPlayers(supabase, scope, 'example', deps.sedesPermitidasPorScopeFn), (error) => error.code === 'ADMIN_PUSH_SCOPE_DENIED');
  }
});

test('admin país mantiene alcance nacional al conservar geografía', async () => {
  const supabase = createReadOnlySupabase({ jugadores_perfil: TERRITORY_PLAYERS });
  const scope = { rol: 'admin_nacional', alcance: 'pais', pais: 'Argentina', authUserId: 'national' };
  const deps = { supabase, sedesPermitidasPorScopeFn: async () => ({ sedes: TERRITORY_VENUES.slice(0, 2) }) };
  const segment = await validateAdminPushSegment(scope, { type: 'todos_pais' }, deps);
  assert.deepEqual(await resolveAdminPushRecipientUserIds(supabase, scope, segment), [PLAYER_A.user_id, PLAYER_B.user_id, 'unassigned']);
  assert.equal((await validateAdminPushSegment(scope, { type: 'jugador', userId: PLAYER_B.user_id }, deps)).userId, PLAYER_B.user_id);
});
