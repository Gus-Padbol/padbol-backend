import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const ACTOR = '10000000-0000-4000-8000-000000000001';
const NOW = new Date('2026-09-11T01:00:00.000Z');
const declaration = { fecha_juego: '2026-09-10', procedencia: 'declaracion_operador', revision: 1,
  vigente: true, registrado_at: '2026-09-10T22:00:00Z', actualizado_at: '2026-09-10T22:00:00Z' };

function database({ pending = false, role = 'admin_club', roleSede = 3, roles, tournament = {}, match = {},
  date = null, rpcError = null, denyMutations = true } = {}) {
  const rows = {
    user_roles: roles ?? [{ user_id: pending ? null : ACTOR, email: 'synthetic@example.invalid', role, sede_id: roleSede }],
    torneos: [{ id: 1, sede_id: 3, deporte: 'padbol', formato_equipo: 'dobles', estado: 'en_curso', ...tournament }],
    partidos: [{ id: 2, torneo_id: 1, sede_id: 3, estado: 'pendiente', resultado: null, equipo_a_id: 10, equipo_b_id: 11, ganador_equipo_id: null, ...match }],
    equipos: [10, 11].map(id => ({ id, torneo_id: 1, sede_id: 3, inscripcion_estado: 'confirmado' })),
  };
  const calls = { auth: 0, reads: [], updatesAttempted: 0, updatesCommitted: 0, rpcs: [] };
  const db = {
    from(table) {
      assert(Object.hasOwn(rows, table), `Unexpected table: ${table}`);
      const filters = [];
      let patch = null, columns = '*', take = Infinity;
      const execute = () => {
        let selected = rows[table].filter(row => filters.every(f => f(row))).slice(0, take);
        if (patch) {
          selected.forEach(row => Object.assign(row, patch));
          calls.updatesCommitted += selected.length;
        } else calls.reads.push({ table, columns });
        return selected.map(row => columns === '*' ? { ...row } : Object.fromEntries(columns.split(',').map(k => k.trim()).map(k => [k, row[k]])));
      };
      const query = {
        select(value) { columns = value; return this; },
        eq(key, value) { filters.push(row => String(row[key]) === String(value)); return this; },
        is(key, value) { filters.push(row => value === null ? row[key] == null : row[key] === value); return this; },
        in(key, values) { filters.push(row => values.some(value => String(row[key]) === String(value))); return this; },
        limit(value) { take = value; return this; },
        update(value) {
          calls.updatesAttempted++;
          if (denyMutations) throw new Error('SYNTHETIC_MUTATION_FORBIDDEN');
          assert.equal(table, 'user_roles');
          assert.deepEqual(value, { user_id: ACTOR });
          patch = value;
          return this;
        },
        insert() { assert.fail('INSERT forbidden'); }, delete() { assert.fail('DELETE forbidden'); }, upsert() { assert.fail('UPSERT forbidden'); },
        async maybeSingle() {
          const data = execute();
          return data.length > 1 ? { data: null, error: { code: 'PGRST116' } } : { data: data[0] ?? null, error: null };
        },
        then(resolve, reject) { return Promise.resolve({ data: execute(), error: null }).then(resolve, reject); },
      };
      return query;
    },
    async rpc(name, args) {
      assert.equal(name, 'leer_fecha_juego_manual');
      assert.deepEqual(args, { p_torneo_id: 1, p_partido_id: 2, p_actor_id: ACTOR });
      calls.rpcs.push(name);
      return { data: date, error: rpcError };
    },
  };
  const supabase = { auth: { async getUser(token) {
    calls.auth++;
    if (token !== 'synthetic-valid-jwt') return { data: { user: null }, error: { message: 'synthetic invalid auth' } };
    return { data: { user: { id: ACTOR, email: 'synthetic@example.invalid', email_confirmed_at: '2026-09-10T00:00:00Z' } }, error: null };
  } } };
  return { db, supabase, calls, rows };
}

async function realChainRoute(fixture, { enabled = false, now = () => NOW } = {}) {
  const base = new URL('../', import.meta.url);
  const source = readFileSync(new URL('server.js', base), 'utf8');
  const { requireAdminUser } = await import(new URL('lib/authAccess.js', base));
  const { resolveStoredRoleForVerifiedUser } = await import(new URL('lib/roleIdentity.js', base));
  const { resolveTorneoRowScope, resolveTorneoAdminAccess, TORNEO_ADMIN_ACCESS_REASON } = await import(new URL('lib/torneos/torneoAdminAccessService.js', base));
  const { mountManualPlayedDateCapabilityRoute } = await import(new URL('lib/torneos/manualPlayedDateCapabilityService.js', base));
  const names = ['getAuthenticatedUser', 'fetchUserRoleRowForAuthUser', 'parseTorneoRouteId', 'fetchTorneoScopeById', 'sendTorneoAdminForbidden', 'requireTorneoAdminByTorneoId'];
  const declarations = names.map(name => {
    const matches = [...source.matchAll(new RegExp(`^(?:async )?function ${name}\\([^]*?^}`, 'gm'))];
    assert.equal(matches.length, 1, name);
    return matches[0][0];
  });
  const constant = source.match(/^const LEGACY_TORNEO_ADMIN_DEPS = \{[^]*?^};/m)?.[0];
  assert(constant);
  const { getAuthenticatedUser, requireTorneoAdminByTorneoId } = vm.runInNewContext(
    `${declarations.join('\n')}\n${constant}\n({getAuthenticatedUser,requireTorneoAdminByTorneoId})`,
    { supabaseAdmin: fixture.db, supabase: fixture.supabase, requireAdminUser, resolveStoredRoleForVerifiedUser,
      resolveTorneoRowScope, resolveTorneoAdminAccess, TORNEO_ADMIN_ACCESS_REASON, LEGACY_SUPER_ADMIN_EMAILS_API: [] });
  let handler;
  const app = { get(path, action) { assert.equal(path, '/api/torneos/:torneoId/partidos/:partidoId/fecha-juego/capacidad'); handler = action; } };
  mountManualPlayedDateCapabilityRoute(app, { supabaseAdmin: fixture.db, getAuthenticatedUser,
    requireTorneoAdminByTorneoId, capabilities: { writeEnabled: enabled, readEnabled: false }, now });
  return async (changes = {}) => {
    const res = { statusCode: 200, headers: {}, set(key, value) { this.headers[key] = value; return this; },
      vary(key) { this.headers.Vary = key; return this; }, status(value) { this.statusCode = value; return this; }, json(body) { this.body = body; return this; } };
    await handler({ params: { torneoId: '1', partidoId: '2' }, headers: { authorization: 'Bearer synthetic-valid-jwt' }, query: {}, body: {}, ...changes }, res);
    assert.equal(res.headers['Cache-Control'], 'private, no-store');
    assert.equal(res.headers.Vary, 'Authorization');
    return res;
  };
}


test('capability GET rejects a pending email assignment OFF without attempting a mutation', async () => {
  const f = database({ pending: true });
  const response = await (await realChainRoute(f))();
  assert.equal(response.statusCode, 403);
  assert.equal(f.calls.auth, 1);
  assert.equal(f.calls.updatesAttempted, 0);
  assert.equal(f.rows.user_roles[0].user_id, null);
  assert.deepEqual(f.calls.rpcs, []);
  assert.deepEqual(f.calls.reads.map(read => read.table), ['user_roles']);
  assert(f.calls.reads.every(read => read.table !== 'user_roles' || read.columns === 'user_id,role,sede_id'));
});

test('capability GET rejects pending super-admin assignment ON without claiming or private reads', async () => {
  const f = database({ pending: true, role: 'super_admin', roleSede: null });
  const response = await (await realChainRoute(f, { enabled: true }))();
  assert.equal(response.statusCode, 403);
  assert.equal(f.calls.updatesAttempted, 0);
  assert.equal(f.rows.user_roles[0].user_id, null);
  assert.deepEqual(f.calls.rpcs, []);
});

test('real bearer verification rejects missing and invalid JWT before querying roles or match', async () => {
  for (const headers of [{}, { authorization: 'Bearer synthetic-expired-jwt' }]) {
    const f = database();
    const response = await (await realChainRoute(f))({ headers });
    assert.equal(response.statusCode, 401);
    assert.equal(f.calls.auth, headers.authorization ? 1 : 0);
    assert.equal(f.calls.reads.length, 0);
    assert.equal(f.calls.updatesAttempted, 0);
  }
});

test('existing UUID-bound club role authorizes the exact scoped ON DTO without any mutation', async () => {
  const f = database();
  const response = await (await realChainRoute(f, { enabled: true }))({
    body: { actor_id: 'forged', sede_id: 4 }, query: { enabled: true, expires_at: '2999-01-01' },
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, { schema: 'torneo-manual-date/v1', enabled: true, user_id: ACTOR,
    torneo_id: 1, partido_id: 2, sede_id: 3, operations: { declare: true, correct: false },
    expires_at: '2026-09-11T01:01:00.000Z' });
  assert.equal(f.calls.auth, 1);
  assert.equal(f.calls.updatesAttempted, 0);
  assert.deepEqual(f.calls.rpcs, ['leer_fecha_juego_manual']);
});

test('real JWT plus current persisted profile still rejects revoked, duplicate and other-venue roles', async () => {
  const variants = [
    { roles: [] }, { role: 'jugador' }, { role: 'admin_nacional' }, { roleSede: null }, { roleSede: 4 },
    { roles: [{ user_id: ACTOR, role: 'admin_club', sede_id: 3 }, { user_id: ACTOR, role: 'super_admin', sede_id: null }] },
  ];
  for (const options of variants) {
    const f = database(options);
    const response = await (await realChainRoute(f, { enabled: true }))();
    assert.equal(response.statusCode, 403);
    assert.equal(f.calls.updatesAttempted, 0);
    assert.deepEqual(f.calls.rpcs, []);
  }
});

test('JWT-bound super-admin role is explicit, while tournament and match venues must still agree', async () => {
  for (const [match, expected] of [[{}, 200], [{ sede_id: null }, 403], [{ sede_id: 4 }, 403], [{ torneo_id: 4 }, 404]]) {
    const f = database({ role: 'super_admin', roleSede: null, match });
    const response = await (await realChainRoute(f, { enabled: true }))();
    assert.equal(response.statusCode, expected);
    assert.equal(f.calls.updatesAttempted, 0);
  }
});
