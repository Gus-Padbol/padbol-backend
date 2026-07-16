import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDisplayName,
  buildPerfilSearchOrFilter,
  desvincularJugadorSede,
  escapeIlike,
  isMissingSedeJugadoresTableError,
  listAdminJugadoresSede,
  mapAdminJugadorRow,
  mapVinculacionPublica,
  mergeAdminJugadoresRoster,
  normalizeOrigen,
  normalizeSearchQuery,
  parseVinculadoFilter,
  resolveAdminJugadoresScope,
  vincularJugadorSede,
} from './adminJugadoresService.js';

const U1 = 'aaaaaaaa-bbbb-cccc-dddd-111111111111';
const U2 = 'aaaaaaaa-bbbb-cccc-dddd-222222222222';
const U3 = 'aaaaaaaa-bbbb-cccc-dddd-333333333333';
const ADMIN = 'aaaaaaaa-bbbb-cccc-dddd-aaaaaaaaaaaa';

test('normalizeSearchQuery strips @ and trims', () => {
  assert.equal(normalizeSearchQuery('  @juan  '), 'juan');
});

test('escapeIlike escapes wildcards', () => {
  assert.equal(escapeIlike('a%b_c'), 'a\\%b\\_c');
});

test('buildPerfilSearchOrFilter requires min length', () => {
  assert.equal(buildPerfilSearchOrFilter('a'), null);
  const f = buildPerfilSearchOrFilter('garcia');
  assert.match(f, /nombre\.ilike/);
  assert.match(f, /email\.ilike/);
  assert.match(f, /telefono\.ilike/);
});

test('buildPerfilSearchOrFilter includes digits for phone', () => {
  const f = buildPerfilSearchOrFilter('11 5555-1234');
  assert.match(f, /1155551234/);
});

test('resolveAdminJugadoresScope clubs cannot query other sedes', () => {
  const denied = resolveAdminJugadoresScope({ rol: 'admin_club', sede_id: 5 }, 9);
  assert.equal(denied.ok, false);
  assert.equal(denied.status, 403);

  const ok = resolveAdminJugadoresScope({ rol: 'admin_club', sede_id: 5 }, null);
  assert.equal(ok.ok, true);
  assert.equal(ok.sedeId, 5);
});

test('resolveAdminJugadoresScope super can pick sede', () => {
  const ok = resolveAdminJugadoresScope({ rol: 'super_admin', sede_id: null }, 12);
  assert.equal(ok.ok, true);
  assert.equal(ok.sedeId, 12);
});

test('mapAdminJugadorRow hides empty optional fields and exposes link fields', () => {
  const row = mapAdminJugadorRow({
    user_id: 'u1',
    nombre: 'Ana',
    apellido: 'Lopez',
    username: '@ana',
    email: 'ANA@TEST.COM',
    telefono: '111',
  }, {
    link: {
      id: 9,
      estado: 'activo',
      origen: 'manual',
      created_at: '2026-01-01T00:00:00Z',
    },
  });
  assert.equal(row.display_name, 'Ana Lopez');
  assert.equal(row.username, 'ana');
  assert.equal(row.email, 'ana@test.com');
  assert.equal(row.vinculado, true);
  assert.equal(row.vinculacion_id, 9);
  assert.equal(row.vinculacion_estado, 'activo');
  assert.equal(row.vinculacion_origen, 'manual');
  assert.equal(row.vinculado_desde, '2026-01-01T00:00:00Z');
  assert.equal('notas' in row, false);
  assert.equal('created_by' in row, false);
});

test('mapVinculacionPublica inactive is not vinculado', () => {
  const m = mapVinculacionPublica({ id: 1, estado: 'inactivo', origen: 'manual' });
  assert.equal(m.vinculado, false);
  assert.equal(m.vinculacion_id, null);
});

test('buildDisplayName prefers nombre+apellido', () => {
  assert.equal(buildDisplayName({ nombre: 'A', apellido: 'B', username: 'x' }), 'A B');
});

test('parseVinculadoFilter and normalizeOrigen', () => {
  assert.equal(parseVinculadoFilter('true'), true);
  assert.equal(parseVinculadoFilter('0'), false);
  assert.equal(parseVinculadoFilter(''), null);
  assert.equal(normalizeOrigen('torneo'), 'torneo');
  assert.equal(normalizeOrigen('xyz'), 'manual');
});

test('isMissingSedeJugadoresTableError detects missing table', () => {
  assert.equal(
    isMissingSedeJugadoresTableError({ code: 'PGRST205', message: 'Could not find the table' }),
    true,
  );
  assert.equal(isMissingSedeJugadoresTableError({ message: 'other' }), false);
});

test('mergeAdminJugadoresRoster unions historial + link without duplicates', () => {
  const rows = mergeAdminJugadoresRoster({
    perfilesHistorial: [
      { user_id: U1, nombre: 'Hist', apellido: 'One', email: 'h@test.com' },
      { user_id: U2, nombre: 'Both', apellido: 'Two', email: 'b@test.com' },
    ],
    perfilesVinculados: [
      { user_id: U2, nombre: 'Both', apellido: 'Two', email: 'b@test.com' },
      { user_id: U3, nombre: 'Link', apellido: 'Only', email: 'l@test.com' },
    ],
    activityByUserId: new Map([[U1, '2026-02-01T00:00:00Z']]),
    linksByUserId: new Map([
      [U2, { id: 2, estado: 'activo', origen: 'manual', created_at: '2026-03-01T00:00:00Z' }],
      [U3, { id: 3, estado: 'activo', origen: 'importacion', created_at: '2026-04-01T00:00:00Z' }],
    ]),
  });

  assert.equal(rows.length, 3);
  const byId = Object.fromEntries(rows.map((r) => [r.user_id, r]));
  assert.equal(byId[U1].vinculacion, 'con_historial');
  assert.equal(byId[U1].vinculado, false);
  assert.equal(byId[U2].vinculacion, 'con_historial');
  assert.equal(byId[U2].vinculado, true);
  assert.equal(byId[U3].vinculacion, 'vinculado');
  assert.equal(byId[U3].vinculado, true);
  assert.equal(byId[U3].vinculacion_origen, 'importacion');
});

function createChain(resultFactory) {
  const state = {
    table: null,
    filters: {},
    op: 'select',
    payload: null,
    order: null,
    limit: null,
    inValues: null,
  };

  const api = {
    select() { state.op = state.op === 'insert' || state.op === 'update' ? state.op : 'select'; return api; },
    insert(rows) { state.op = 'insert'; state.payload = rows; return api; },
    update(patch) { state.op = 'update'; state.payload = patch; return api; },
    eq(col, val) { state.filters[col] = val; return api; },
    in(col, vals) { state.inValues = { col, vals }; return api; },
    order(col, opts) { state.order = { col, opts }; return api; },
    limit(n) { state.limit = n; return api; },
    maybeSingle() { return Promise.resolve(resultFactory({ ...state, single: true })); },
    single() { return Promise.resolve(resultFactory({ ...state, single: true })); },
    then(resolve, reject) {
      try {
        return Promise.resolve(resultFactory({ ...state, single: false })).then(resolve, reject);
      } catch (e) {
        return Promise.reject(e).then(resolve, reject);
      }
    },
    _state: state,
  };
  return api;
}

function createMockDb({
  sedes = [{ id: 5, nombre: 'Club 5' }, { id: 9, nombre: 'Club 9' }],
  perfiles = [],
  reservas = [],
  sedeJugadores = [],
  missingSedeJugadores = false,
} = {}) {
  const state = {
    sedeJugadores: sedeJugadores.map((r) => ({ ...r })),
    nextId: sedeJugadores.reduce((m, r) => Math.max(m, Number(r.id) || 0), 0) + 1,
  };

  const supabaseAdmin = {
    from(table) {
      return createChain((q) => {
        if (table === 'sedes') {
          const id = q.filters.id;
          const row = sedes.find((s) => Number(s.id) === Number(id)) || null;
          return { data: q.single ? row : (row ? [row] : []), error: null };
        }

        if (table === 'reservas') {
          let rows = reservas.filter((r) => {
            if (q.filters.sede_id != null) return Number(r.sede_id) === Number(q.filters.sede_id);
            if (q.filters.sede != null) return r.sede === q.filters.sede;
            return true;
          });
          if (q.limit != null) rows = rows.slice(0, q.limit);
          return { data: rows, error: null };
        }

        if (table === 'jugadores_perfil') {
          let rows = [...perfiles];
          if (q.filters.user_id) {
            rows = rows.filter((p) => String(p.user_id) === String(q.filters.user_id));
          }
          if (q.inValues?.col === 'user_id') {
            const set = new Set(q.inValues.vals.map(String));
            rows = rows.filter((p) => set.has(String(p.user_id)));
          }
          if (q.inValues?.col === 'email') {
            const set = new Set(q.inValues.vals.map((e) => String(e).toLowerCase()));
            rows = rows.filter((p) => set.has(String(p.email || '').toLowerCase()));
          }
          if (q.single) {
            return { data: rows[0] || null, error: null };
          }
          return { data: rows, error: null };
        }

        if (table === 'sede_jugadores') {
          if (missingSedeJugadores) {
            return {
              data: null,
              error: { code: 'PGRST205', message: "Could not find the table 'public.sede_jugadores' in the schema cache" },
            };
          }

          if (q.op === 'insert') {
            const row = {
              id: state.nextId++,
              ...q.payload[0],
            };
            state.sedeJugadores.push(row);
            return { data: row, error: null };
          }

          if (q.op === 'update') {
            const id = q.filters.id;
            const idx = state.sedeJugadores.findIndex((r) => Number(r.id) === Number(id));
            if (idx < 0) return { data: null, error: { message: 'not found' } };
            state.sedeJugadores[idx] = { ...state.sedeJugadores[idx], ...q.payload };
            return { data: state.sedeJugadores[idx], error: null };
          }

          let rows = state.sedeJugadores.filter((r) => {
            if (q.filters.sede_id != null && Number(r.sede_id) !== Number(q.filters.sede_id)) return false;
            if (q.filters.user_id != null && String(r.user_id) !== String(q.filters.user_id)) return false;
            if (q.filters.estado != null && String(r.estado) !== String(q.filters.estado)) return false;
            if (q.filters.id != null && Number(r.id) !== Number(q.filters.id)) return false;
            return true;
          });
          if (q.order?.col === 'updated_at') {
            rows = [...rows].sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')));
          }
          if (q.limit != null) rows = rows.slice(0, q.limit);
          if (q.single) return { data: rows[0] || null, error: null };
          return { data: rows, error: null };
        }

        throw new Error(`unexpected table ${table}`);
      });
    },
    _state: state,
  };

  return supabaseAdmin;
}

test('1. Admin Club vincula jugador a su sede', async () => {
  const db = createMockDb({
    perfiles: [{ user_id: U1, nombre: 'Ana', apellido: 'L', email: 'a@t.com' }],
  });
  const result = await vincularJugadorSede(db, {
    role: { rol: 'admin_club', sede_id: 5 },
    userId: U1,
    sedeId: 5,
    origen: 'manual',
    adminUserId: ADMIN,
  });
  assert.equal(result.ok, true);
  assert.equal(result.vinculacion.estado, 'activo');
  assert.equal(result.vinculacion.sede_id, 5);
  assert.equal(result.idempotent, undefined);
});

test('2. Admin Club intenta otra sede → 403', async () => {
  const db = createMockDb({
    perfiles: [{ user_id: U1, nombre: 'Ana', apellido: 'L', email: 'a@t.com' }],
  });
  await assert.rejects(
    () => vincularJugadorSede(db, {
      role: { rol: 'admin_club', sede_id: 5 },
      userId: U1,
      sedeId: 9,
    }),
    (err) => err.status === 403,
  );
});

test('3. Super Admin vincula en cualquier sede', async () => {
  const db = createMockDb({
    perfiles: [{ user_id: U1, nombre: 'Ana', apellido: 'L', email: 'a@t.com' }],
  });
  const result = await vincularJugadorSede(db, {
    role: { rol: 'super_admin', sede_id: null },
    userId: U1,
    sedeId: 9,
    origen: 'manual',
  });
  assert.equal(result.vinculacion.sede_id, 9);
});

test('4. Vinculación duplicada idempotente', async () => {
  const db = createMockDb({
    perfiles: [{ user_id: U1, nombre: 'Ana', apellido: 'L', email: 'a@t.com' }],
    sedeJugadores: [{
      id: 10,
      sede_id: 5,
      user_id: U1,
      estado: 'activo',
      origen: 'manual',
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
    }],
  });
  const result = await vincularJugadorSede(db, {
    role: { rol: 'admin_club', sede_id: 5 },
    userId: U1,
    sedeId: 5,
  });
  assert.equal(result.idempotent, true);
  assert.equal(result.vinculacion.id, 10);
  assert.equal(db._state.sedeJugadores.length, 1);
});

test('5. Jugador sin reservas aparece en roster si está vinculado', async () => {
  const db = createMockDb({
    perfiles: [{ user_id: U3, nombre: 'Link', apellido: 'Only', email: 'l@t.com' }],
    reservas: [],
    sedeJugadores: [{
      id: 3,
      sede_id: 5,
      user_id: U3,
      estado: 'activo',
      origen: 'manual',
      created_at: '2026-04-01T00:00:00Z',
      updated_at: '2026-04-01T00:00:00Z',
    }],
  });
  const list = await listAdminJugadoresSede(db, { sedeId: 5 });
  assert.equal(list.total, 1);
  assert.equal(list.items[0].user_id, U3);
  assert.equal(list.items[0].vinculado, true);
  assert.equal(list.vinculacion_mode, 'sede_jugadores_y_historial');
});

test('6. Desvinculación conserva historial (soft) y fila', async () => {
  const db = createMockDb({
    perfiles: [{ user_id: U1, nombre: 'Ana', apellido: 'L', email: 'a@t.com' }],
    sedeJugadores: [{
      id: 10,
      sede_id: 5,
      user_id: U1,
      estado: 'activo',
      origen: 'manual',
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
      notas: 'keep',
    }],
  });
  const result = await desvincularJugadorSede(db, {
    role: { rol: 'admin_club', sede_id: 5 },
    userId: U1,
    sedeId: 5,
  });
  assert.equal(result.vinculacion.estado, 'inactivo');
  assert.ok(result.vinculacion.desvinculado_at);
  assert.equal(db._state.sedeJugadores.length, 1);
  assert.equal(db._state.sedeJugadores[0].notas, 'keep');
});

test('7. Reactivación reutiliza fila existente', async () => {
  const db = createMockDb({
    perfiles: [{ user_id: U1, nombre: 'Ana', apellido: 'L', email: 'a@t.com' }],
    sedeJugadores: [{
      id: 10,
      sede_id: 5,
      user_id: U1,
      estado: 'inactivo',
      origen: 'manual',
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-02T00:00:00Z',
      desvinculado_at: '2026-01-02T00:00:00Z',
    }],
  });
  const result = await vincularJugadorSede(db, {
    role: { rol: 'admin_club', sede_id: 5 },
    userId: U1,
    sedeId: 5,
    origen: 'torneo',
  });
  assert.equal(result.reactivated, true);
  assert.equal(result.vinculacion.id, 10);
  assert.equal(result.vinculacion.estado, 'activo');
  assert.equal(result.vinculacion.origen, 'torneo');
  assert.equal(result.vinculacion.desvinculado_at, null);
  assert.equal(db._state.sedeJugadores.length, 1);
});

test('8. GET combina historial + vínculo sin duplicados', async () => {
  const db = createMockDb({
    perfiles: [
      { user_id: U1, nombre: 'Hist', apellido: 'One', email: 'h@t.com' },
      { user_id: U2, nombre: 'Both', apellido: 'Two', email: 'b@t.com' },
      { user_id: U3, nombre: 'Link', apellido: 'Only', email: 'l@t.com' },
    ],
    reservas: [
      { user_id: U1, email: 'h@t.com', sede_id: 5, fecha: '2026-01-10', created_at: '2026-01-10T10:00:00Z' },
      { user_id: U2, email: 'b@t.com', sede_id: 5, fecha: '2026-01-11', created_at: '2026-01-11T10:00:00Z' },
    ],
    sedeJugadores: [
      {
        id: 2, sede_id: 5, user_id: U2, estado: 'activo', origen: 'manual',
        created_at: '2026-03-01T00:00:00Z', updated_at: '2026-03-01T00:00:00Z',
      },
      {
        id: 3, sede_id: 5, user_id: U3, estado: 'activo', origen: 'manual',
        created_at: '2026-04-01T00:00:00Z', updated_at: '2026-04-01T00:00:00Z',
      },
    ],
  });
  const list = await listAdminJugadoresSede(db, { sedeId: 5 });
  assert.equal(list.total, 3);
  const ids = list.items.map((i) => i.user_id).sort();
  assert.deepEqual(ids, [U1, U2, U3].sort());
});

test('9. Filtros por vinculado / no vinculado', async () => {
  const db = createMockDb({
    perfiles: [
      { user_id: U1, nombre: 'Hist', apellido: 'One', email: 'h@t.com' },
      { user_id: U3, nombre: 'Link', apellido: 'Only', email: 'l@t.com' },
    ],
    reservas: [
      { user_id: U1, email: 'h@t.com', sede_id: 5, fecha: '2026-01-10', created_at: '2026-01-10T10:00:00Z' },
    ],
    sedeJugadores: [{
      id: 3, sede_id: 5, user_id: U3, estado: 'activo', origen: 'manual',
      created_at: '2026-04-01T00:00:00Z', updated_at: '2026-04-01T00:00:00Z',
    }],
  });
  const linked = await listAdminJugadoresSede(db, { sedeId: 5, vinculado: true });
  assert.equal(linked.total, 1);
  assert.equal(linked.items[0].user_id, U3);

  const unlinked = await listAdminJugadoresSede(db, { sedeId: 5, vinculado: false });
  assert.equal(unlinked.total, 1);
  assert.equal(unlinked.items[0].user_id, U1);
});

test('10. Usuario inexistente → 404', async () => {
  const db = createMockDb({ perfiles: [] });
  await assert.rejects(
    () => vincularJugadorSede(db, {
      role: { rol: 'admin_club', sede_id: 5 },
      userId: U1,
      sedeId: 5,
    }),
    (err) => err.status === 404 && err.code === 'JUGADOR_NOT_FOUND',
  );
});

test('11. Sede inválida → 400', async () => {
  const db = createMockDb({
    sedes: [{ id: 5, nombre: 'Club 5' }],
    perfiles: [{ user_id: U1, nombre: 'Ana', apellido: 'L', email: 'a@t.com' }],
  });
  await assert.rejects(
    () => vincularJugadorSede(db, {
      role: { rol: 'super_admin', sede_id: null },
      userId: U1,
      sedeId: 999,
    }),
    (err) => err.status === 400 && err.code === 'SEDE_INVALIDA',
  );
});

test('12. Privacidad: roster no expone notas ni created_by', async () => {
  const db = createMockDb({
    perfiles: [{ user_id: U3, nombre: 'Link', apellido: 'Only', email: 'l@t.com', telefono: '111' }],
    sedeJugadores: [{
      id: 3,
      sede_id: 5,
      user_id: U3,
      estado: 'activo',
      origen: 'manual',
      created_at: '2026-04-01T00:00:00Z',
      updated_at: '2026-04-01T00:00:00Z',
      notas: 'secreto interno',
      created_by: ADMIN,
    }],
  });
  const list = await listAdminJugadoresSede(db, { sedeId: 5 });
  const item = list.items[0];
  assert.equal('notas' in item, false);
  assert.equal('created_by' in item, false);
  assert.equal(item.vinculado, true);
});

test('userId inválido → 400', async () => {
  const db = createMockDb();
  await assert.rejects(
    () => vincularJugadorSede(db, {
      role: { rol: 'admin_club', sede_id: 5 },
      userId: 'not-a-uuid',
      sedeId: 5,
    }),
    (err) => err.status === 400,
  );
});
