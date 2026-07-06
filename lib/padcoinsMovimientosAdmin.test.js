import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  listPadcoinsMovimientosAdmin,
  mapPadcoinsMovimientoAdminRow,
  parsePadcoinsMovimientosAdminFilters,
  parsePadcoinsMovimientosAdminPagination,
  resolvePadcoinsMovimientosAdminScope,
} from '../src/padcoins/padcoinsMovimientosAdminService.js';
import { listPadcoinsMovimientos } from '../src/padcoins/padcoinsService.js';

const USER_A = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const USER_B = 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff';

const MOVIMIENTOS = [
  {
    id: 'm1',
    user_id: USER_A,
    tipo: 'earn',
    monto: 100,
    saldo_antes: 0,
    saldo_despues: 100,
    referencia_tipo: 'reserva',
    referencia_id: '10',
    sede_id: 1,
    descripcion: 'Reserva completada',
    created_at: '2026-07-06T10:00:00.000Z',
    created_by: null,
  },
  {
    id: 'm2',
    user_id: USER_B,
    tipo: 'spend',
    monto: -50,
    saldo_antes: 100,
    saldo_despues: 50,
    referencia_tipo: 'penalizacion',
    referencia_id: '20:cancelacion_tarde',
    sede_id: 2,
    descripcion: 'Penalización cancelación tardía',
    created_at: '2026-07-05T10:00:00.000Z',
    created_by: null,
  },
  {
    id: 'm3',
    user_id: USER_A,
    tipo: 'adjust',
    monto: 25,
    saldo_antes: 100,
    saldo_despues: 125,
    referencia_tipo: 'bonus_admin',
    referencia_id: null,
    sede_id: 1,
    descripcion: 'Ajuste admin',
    created_at: '2026-07-04T10:00:00.000Z',
    created_by: USER_A,
  },
];

function buildSupabaseMock(rows = MOVIMIENTOS) {
  const state = {
    filters: [],
    range: null,
    order: null,
  };

  const query = {
    select() { return query; },
    order(_col, opts) {
      state.order = opts;
      return query;
    },
    eq(col, val) {
      state.filters.push(['eq', col, val]);
      return query;
    },
    gte(col, val) {
      state.filters.push(['gte', col, val]);
      return query;
    },
    lte(col, val) {
      state.filters.push(['lte', col, val]);
      return query;
    },
    in(col, val) {
      state.filters.push(['in', col, val]);
      return query;
    },
    range(from, to) {
      state.range = { from, to };
      let filtered = [...rows];

      for (const [op, col, val] of state.filters) {
        if (op === 'eq') {
          filtered = filtered.filter((row) => row[col] === val || String(row[col]) === String(val));
        }
        if (op === 'gte' && col === 'created_at') {
          filtered = filtered.filter((row) => row.created_at >= val);
        }
        if (op === 'lte' && col === 'created_at') {
          filtered = filtered.filter((row) => row.created_at <= val);
        }
        if (op === 'in' && col === 'user_id') {
          filtered = filtered.filter((row) => val.includes(row.user_id));
        }
      }

      const slice = filtered.slice(from, to + 1);
      return Promise.resolve({ data: slice, error: null, count: filtered.length });
    },
    then(resolve, reject) {
      Promise.resolve(query.range(0, 99)).then(resolve, reject);
    },
    get state() { return state; },
  };

  return {
    from(table) {
      if (table === 'padcoins_movimientos') return query;
      if (table === 'jugadores_perfil') {
        return {
          select() { return this; },
          or() { return this; },
          in(_col, ids) {
            return Promise.resolve({
              data: ids.map((id) => ({
                user_id: id,
                nombre: id === USER_A ? 'Juan' : 'Pedro',
                apellido: 'Test',
                email: `${id.slice(0, 8)}@test.com`,
              })),
              error: null,
            });
          },
          limit: async () => ({
            data: [
              { user_id: USER_A, nombre: 'Juan', apellido: 'Test', email: 'juan@test.com' },
            ],
            error: null,
          }),
        };
      }
      if (table === 'sedes') {
        return {
          select() { return this; },
          in() {
            return Promise.resolve({
              data: [
                { id: 1, nombre: 'La Meca' },
                { id: 2, nombre: 'Sede Dos' },
              ],
              error: null,
            });
          },
        };
      }
      return query;
    },
    queryState: state,
  };
}

describe('padcoinsMovimientosAdminService — scope', () => {
  it('Super Admin ve todas las sedes', () => {
    assert.deepEqual(
      resolvePadcoinsMovimientosAdminScope({ rol: 'super_admin', sede_id: null }),
      { kind: 'all', sedeId: null },
    );
  });

  it('Super Admin puede filtrar por sede', () => {
    assert.deepEqual(
      resolvePadcoinsMovimientosAdminScope({ rol: 'super_admin', sede_id: null }, 1),
      { kind: 'all', sedeId: 1 },
    );
  });

  it('Admin Club solo ve su sede', () => {
    assert.deepEqual(
      resolvePadcoinsMovimientosAdminScope({ rol: 'admin_club', sede_id: 1 }),
      { kind: 'sede', sedeId: 1 },
    );
  });

  it('Admin Club no puede ver otra sede', () => {
    const scope = resolvePadcoinsMovimientosAdminScope({ rol: 'admin_club', sede_id: 1 }, 2);
    assert.equal(scope.kind, 'forbidden');
  });

  it('Admin Nacional u otros roles quedan prohibidos', () => {
    const scope = resolvePadcoinsMovimientosAdminScope({ rol: 'admin_nacional', sede_id: null });
    assert.equal(scope.kind, 'forbidden');
  });
});

describe('padcoinsMovimientosAdminService — paginación y filtros', () => {
  it('paginación default limit 25 offset 0', () => {
    assert.deepEqual(parsePadcoinsMovimientosAdminPagination({}), {
      limit: 25,
      offset: 0,
      page: 1,
    });
  });

  it('page 2 con limit 10', () => {
    assert.deepEqual(parsePadcoinsMovimientosAdminPagination({ page: 2, limit: 10 }), {
      limit: 10,
      offset: 10,
      page: 2,
    });
  });

  it('parsea filtros tipo y referencia', () => {
    const filters = parsePadcoinsMovimientosAdminFilters({
      sede_id: '1',
      user_id: USER_A,
      tipo: 'earn',
      referencia_tipo: 'reserva',
      referencia_id: '10',
      fecha_desde: '2026-07-01',
      fecha_hasta: '2026-07-07',
      search: 'juan',
    });
    assert.equal(filters.sede_id, 1);
    assert.equal(filters.user_id, USER_A);
    assert.equal(filters.tipo, 'earn');
    assert.equal(filters.referencia_tipo, 'reserva');
    assert.equal(filters.referencia_id, '10');
    assert.ok(filters.fecha_desde);
    assert.ok(filters.fecha_hasta);
    assert.equal(filters.search, 'juan');
  });
});

describe('padcoinsMovimientosAdminService — listado', () => {
  it('Super Admin lista movimientos con joins', async () => {
    const supabaseAdmin = buildSupabaseMock();
    const result = await listPadcoinsMovimientosAdmin(supabaseAdmin, {
      role: { rol: 'super_admin', sede_id: null },
      query: { limit: 10 },
    });

    assert.equal(result.movimientos.length, 3);
    assert.equal(result.paginacion.total, 3);
    assert.equal(result.movimientos[0].id, 'm1');
    assert.equal(result.movimientos[0].jugador?.nombre, 'Juan Test');
    assert.equal(result.movimientos[0].sede_nombre, 'La Meca');
    assert.equal(result.movimientos[0].saldo_resultante, 100);
  });

  it('Super Admin filtra por sede', async () => {
    const supabaseAdmin = buildSupabaseMock();
    const result = await listPadcoinsMovimientosAdmin(supabaseAdmin, {
      role: { rol: 'super_admin', sede_id: null },
      query: { sede_id: 1 },
    });

    assert.equal(result.movimientos.length, 2);
    assert.ok(result.movimientos.every((row) => row.sede_id === 1));
  });

  it('Admin Club solo ve su sede', async () => {
    const supabaseAdmin = buildSupabaseMock();
    const result = await listPadcoinsMovimientosAdmin(supabaseAdmin, {
      role: { rol: 'admin_club', sede_id: 1 },
      query: {},
    });

    assert.equal(result.movimientos.length, 2);
    assert.ok(result.movimientos.every((row) => row.sede_id === 1));
  });

  it('Admin Club no puede ver otra sede', async () => {
    const supabaseAdmin = buildSupabaseMock();
    await assert.rejects(
      () => listPadcoinsMovimientosAdmin(supabaseAdmin, {
        role: { rol: 'admin_club', sede_id: 1 },
        query: { sede_id: 2 },
      }),
      /otra sede/,
    );
  });

  it('filtros tipo/referencia/fecha funcionan', async () => {
    const supabaseAdmin = buildSupabaseMock();
    const result = await listPadcoinsMovimientosAdmin(supabaseAdmin, {
      role: { rol: 'super_admin', sede_id: null },
      query: {
        tipo: 'earn',
        referencia_tipo: 'reserva',
        fecha_desde: '2026-07-06T00:00:00.000Z',
        fecha_hasta: '2026-07-06T23:59:59.999Z',
      },
    });

    assert.equal(result.movimientos.length, 1);
    assert.equal(result.movimientos[0].id, 'm1');
  });

  it('paginación limit/offset recorta resultados', async () => {
    const supabaseAdmin = buildSupabaseMock();
    const result = await listPadcoinsMovimientosAdmin(supabaseAdmin, {
      role: { rol: 'super_admin', sede_id: null },
      query: { limit: 1, offset: 1 },
    });

    assert.equal(result.movimientos.length, 1);
    assert.equal(result.paginacion.limit, 1);
    assert.equal(result.paginacion.offset, 1);
    assert.equal(result.paginacion.total, 3);
  });

  it('search sin coincidencias devuelve vacío', async () => {
    const supabaseAdmin = buildSupabaseMock([]);
    const originalFrom = supabaseAdmin.from.bind(supabaseAdmin);
    supabaseAdmin.from = (table) => {
      if (table === 'jugadores_perfil') {
        return {
          select() { return this; },
          or() { return this; },
          limit: async () => ({ data: [], error: null }),
        };
      }
      return originalFrom(table);
    };

    const result = await listPadcoinsMovimientosAdmin(supabaseAdmin, {
      role: { rol: 'super_admin', sede_id: null },
      query: { search: 'inexistente' },
    });

    assert.deepEqual(result.movimientos, []);
    assert.equal(result.paginacion.total, 0);
  });
});

describe('padcoinsMovimientosAdminService — map dto', () => {
  it('mapPadcoinsMovimientoAdminRow incluye campos esperados', () => {
    const dto = mapPadcoinsMovimientoAdminRow(MOVIMIENTOS[0], new Map([
      [USER_A, { user_id: USER_A, nombre: 'Juan Test', email: 'juan@test.com' }],
    ]), new Map([[1, 'La Meca']]));

    assert.equal(dto.id, 'm1');
    assert.equal(dto.tipo, 'earn');
    assert.equal(dto.monto, 100);
    assert.equal(dto.sede_nombre, 'La Meca');
    assert.equal(dto.jugador.email, 'juan@test.com');
    assert.equal(dto.saldo_resultante, 100);
  });
});

describe('padcoinsService — historial jugador intacto', () => {
  it('listPadcoinsMovimientos sigue filtrando por user_id sin mutar saldo', async () => {
    let insertCalled = false;
    const supabaseAdmin = {
      from(table) {
        if (table !== 'padcoins_movimientos') {
          return {
            insert() { insertCalled = true; return this; },
          };
        }
        return {
          select() { return this; },
          eq(_col, userId) {
            assert.equal(userId, USER_A);
            return this;
          },
          order() { return this; },
          range: async () => ({
            data: [{ id: 'm1', user_id: USER_A, monto: 100 }],
            error: null,
            count: 1,
          }),
        };
      },
    };

    const result = await listPadcoinsMovimientos(supabaseAdmin, USER_A, { limit: 10 });
    assert.equal(result.movimientos.length, 1);
    assert.equal(insertCalled, false);
  });
});
