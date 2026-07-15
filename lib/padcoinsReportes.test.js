import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  PADCOINS_CSV_BOM,
  PADCOINS_CSV_MAX_EXPORT_ROWS,
  assertPadcoinsExportWithinLimit,
  buildPadcoinsCsvContent,
  buildPadcoinsCsvFilename,
  escapePadcoinsCsvCell,
} from '../src/padcoins/padcoinsCsv.js';
import {
  buildPadcoinsCanjesCsv,
  buildPadcoinsJugadoresCsv,
  buildPadcoinsMovimientosCsv,
  getPadcoinsReportesResumen,
  listPadcoinsReportesCanjes,
  listPadcoinsReportesJugadores,
  listPadcoinsReportesMovimientos,
  mapPadcoinsReporteCanjeRow,
  mapPadcoinsReporteMovimientoRow,
  parsePadcoinsReportesFilters,
  resolvePadcoinsReportesScope,
} from '../src/padcoins/padcoinsReportesService.js';

const USER_A = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const USER_B = 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff';
const PREMIO_1 = '11111111-1111-1111-1111-111111111111';
const CAMPANA_1 = '22222222-2222-2222-2222-222222222222';

const MOVIMIENTOS = [
  {
    id: 'm1',
    user_id: USER_A,
    tipo: 'earn',
    monto: 100,
    saldo_despues: 100,
    referencia_tipo: 'reserva',
    referencia_id: '10',
    sede_id: 1,
    descripcion: 'Reserva Vóley',
    created_at: '2026-07-10T10:00:00.000Z',
    metadata: { campaign_id: CAMPANA_1 },
  },
  {
    id: 'm2',
    user_id: USER_A,
    tipo: 'spend',
    monto: -40,
    saldo_despues: 60,
    referencia_tipo: 'canje_premio',
    referencia_id: 'c1',
    sede_id: 1,
    descripcion: 'Canje',
    created_at: '2026-07-11T10:00:00.000Z',
    metadata: {},
  },
  {
    id: 'm3',
    user_id: USER_B,
    tipo: 'reverse',
    monto: -20,
    saldo_despues: 0,
    referencia_tipo: 'reserva',
    referencia_id: '11',
    sede_id: 2,
    descripcion: 'Reverso',
    created_at: '2026-07-09T10:00:00.000Z',
    metadata: {},
  },
  {
    id: 'm4',
    user_id: USER_B,
    tipo: 'earn',
    monto: 50,
    saldo_despues: 50,
    referencia_tipo: 'reserva',
    referencia_id: '12',
    sede_id: 2,
    descripcion: 'Earn sede 2',
    created_at: '2026-07-08T10:00:00.000Z',
    metadata: {},
  },
];

const CANJES = [
  {
    id: 'c1',
    user_id: USER_A,
    sede_id: 1,
    premio_id: PREMIO_1,
    monto_padcoins: 40,
    estado: 'entregado',
    codigo: 'ABC-001',
    created_at: '2026-07-11T10:00:00.000Z',
    updated_at: '2026-07-11T12:00:00.000Z',
    aprobado_at: '2026-07-11T11:00:00.000Z',
    aprobado_por: USER_A,
    entregado_at: '2026-07-11T12:00:00.000Z',
    entregado_por: USER_A,
    vencido_at: null,
    expires_at: null,
    premios_canjeables: { nombre: 'Gorra', descripcion: null, imagen_url: null },
  },
  {
    id: 'c2',
    user_id: USER_B,
    sede_id: 2,
    premio_id: PREMIO_1,
    monto_padcoins: 30,
    estado: 'cancelado',
    codigo: 'XYZ-002',
    created_at: '2026-07-09T10:00:00.000Z',
    updated_at: '2026-07-09T11:00:00.000Z',
    aprobado_at: null,
    aprobado_por: null,
    entregado_at: null,
    entregado_por: null,
    vencido_at: null,
    expires_at: null,
    premios_canjeables: { nombre: 'Gorra', descripcion: null, imagen_url: null },
  },
];

const SALDOS = [
  { user_id: USER_A, disponible: 60, historico_total: 100 },
  { user_id: USER_B, disponible: 50, historico_total: 50 },
];

const PERFILES = [
  { user_id: USER_A, nombre: 'Ana', apellido: 'Pérez', email: 'ana@padbol.com' },
  { user_id: USER_B, nombre: 'Bruno', apellido: 'Gómez', email: 'bruno@padbol.com' },
];

function applyFilters(rows, state) {
  let filtered = [...rows];
  for (const f of state.filters) {
    const [op, col, val] = f;
    if (op === 'eq') {
      filtered = filtered.filter((r) => r[col] === val || String(r[col]) === String(val));
    }
    if (op === 'gte' && col === 'created_at') {
      filtered = filtered.filter((r) => String(r.created_at) >= String(val));
    }
    if (op === 'lte' && col === 'created_at') {
      filtered = filtered.filter((r) => String(r.created_at) <= String(val));
    }
    if (op === 'in') {
      filtered = filtered.filter((r) => val.includes(r[col]) || val.map(String).includes(String(r[col])));
    }
    if (op === 'contains' && col === 'metadata') {
      filtered = filtered.filter((r) => {
        const meta = r.metadata || {};
        return Object.entries(val).every(([k, v]) => String(meta[k]) === String(v));
      });
    }
  }
  return filtered;
}

function buildSupabaseMock() {
  return {
    from(table) {
      const state = { filters: [], range: null, selectCount: false };
      const api = {
        select(_cols, opts) {
          state.selectCount = Boolean(opts?.count);
          return api;
        },
        order() { return api; },
        eq(col, val) { state.filters.push(['eq', col, val]); return api; },
        gte(col, val) { state.filters.push(['gte', col, val]); return api; },
        lte(col, val) { state.filters.push(['lte', col, val]); return api; },
        in(col, val) { state.filters.push(['in', col, val]); return api; },
        contains(col, val) { state.filters.push(['contains', col, val]); return api; },
        limit() { return api; },
        range(from, to) {
          state.range = { from, to };
          return Promise.resolve(api._resolve());
        },
        then(resolve, reject) {
          try { resolve(api._resolve()); } catch (e) { reject(e); }
        },
        _resolve() {
          let rows = [];
          if (table === 'padcoins_movimientos') rows = applyFilters(MOVIMIENTOS, state);
          else if (table === 'padcoins_canjes') rows = applyFilters(CANJES, state);
          else if (table === 'padcoins_saldo') {
            rows = [...SALDOS];
            for (const [op, col, val] of state.filters) {
              if (op === 'in' && col === 'user_id') {
                rows = rows.filter((r) => val.includes(r.user_id));
              }
            }
          } else if (table === 'jugadores_perfil') {
            rows = [...PERFILES];
            for (const [op, col, val] of state.filters) {
              if (op === 'in' && col === 'user_id') {
                rows = rows.filter((r) => val.includes(r.user_id));
              }
            }
          } else if (table === 'sedes') {
            rows = [
              { id: 1, nombre: 'La Meca' },
              { id: 2, nombre: 'Otra Sede' },
            ];
            for (const [op, col, val] of state.filters) {
              if (op === 'in' && col === 'id') {
                rows = rows.filter((r) => val.map(Number).includes(Number(r.id)));
              }
            }
          } else if (table === 'padcoins_campaigns') {
            rows = [{ id: CAMPANA_1, name: 'Promo Verano', sede_id: 1 }];
            for (const [op, col, val] of state.filters) {
              if (op === 'in' && col === 'id') {
                rows = rows.filter((r) => val.includes(r.id));
              }
            }
          } else if (table === 'padcoins_global_config') {
            rows = [];
          }

          if (state.range) {
            const sliced = rows.slice(state.range.from, state.range.to + 1);
            return {
              data: sliced,
              error: null,
              count: state.selectCount ? rows.length : null,
            };
          }
          return { data: rows, error: null, count: state.selectCount ? rows.length : null };
        },
      };
      return api;
    },
  };
}

describe('padcoins reportes — permisos y filtros', () => {
  it('1-2. super global y por sede', () => {
    assert.deepEqual(resolvePadcoinsReportesScope({ rol: 'super_admin' }, null), {
      kind: 'all',
      sedeId: null,
    });
    assert.deepEqual(resolvePadcoinsReportesScope({ rol: 'super_admin' }, 1), {
      kind: 'all',
      sedeId: 1,
    });
  });

  it('7. Admin Club restringido a su sede', () => {
    assert.deepEqual(resolvePadcoinsReportesScope({ rol: 'admin_club', sede_id: 1 }, null), {
      kind: 'sede',
      sedeId: 1,
    });
  });

  it('9. sede ajena → forbidden', () => {
    const scope = resolvePadcoinsReportesScope({ rol: 'admin_club', sede_id: 1 }, 2);
    assert.equal(scope.kind, 'forbidden');
  });

  it('3. rango de fechas inválido', () => {
    assert.throws(
      () => parsePadcoinsReportesFilters({
        fecha_desde: '2026-07-10',
        fecha_hasta: '2026-07-01',
      }),
      /fecha_desde/,
    );
  });
});

describe('padcoins reportes — resumen y listados', () => {
  it('1. resumen global', async () => {
    const sb = buildSupabaseMock();
    const result = await getPadcoinsReportesResumen(sb, {
      role: { rol: 'super_admin' },
      query: {},
    });
    assert.equal(result.resumen.padcoins_emitidos, 150);
    assert.equal(result.resumen.padcoins_canjeados, 40);
    assert.equal(result.resumen.padcoins_revertidos, 20);
    assert.equal(result.resumen.cantidad_movimientos, 4);
    assert.equal(result.resumen.canjes_por_estado.entregado, 1);
    assert.equal(result.resumen.canjes_por_estado.cancelado, 1);
    assert.ok(result.resumen.beneficios_mas_canjeados.length >= 1);
    assert.ok(result.resumen.campanas_mayor_generacion.length >= 1);
    assert.ok(Array.isArray(result.resumen.distribucion_niveles));
  });

  it('2. resumen por sede', async () => {
    const sb = buildSupabaseMock();
    const result = await getPadcoinsReportesResumen(sb, {
      role: { rol: 'admin_club', sede_id: 1 },
      query: {},
    });
    assert.equal(result.resumen.padcoins_emitidos, 100);
    assert.equal(result.resumen.cantidad_movimientos, 2);
    assert.equal(result.filtros_aplicados.scope.sede_id, 1);
  });

  it('3. rango de fechas en movimientos', async () => {
    const sb = buildSupabaseMock();
    const result = await listPadcoinsReportesMovimientos(sb, {
      role: { rol: 'super_admin' },
      query: { fecha_desde: '2026-07-10T00:00:00.000Z', fecha_hasta: '2026-07-11T23:59:59.000Z' },
    });
    assert.equal(result.total, 2);
    assert.equal(result.movimientos.length, 2);
  });

  it('4. movimientos paginados', async () => {
    const sb = buildSupabaseMock();
    const page1 = await listPadcoinsReportesMovimientos(sb, {
      role: { rol: 'super_admin' },
      query: { limit: 1, offset: 0 },
    });
    assert.equal(page1.movimientos.length, 1);
    assert.equal(page1.paginacion.total, 4);
    assert.equal(page1.has_more, true);
  });

  it('5. canjes por estado', async () => {
    const sb = buildSupabaseMock();
    const result = await listPadcoinsReportesCanjes(sb, {
      role: { rol: 'super_admin' },
      query: { estado: 'entregado' },
    });
    assert.equal(result.total, 1);
    assert.equal(result.canjes[0].estado, 'entregado');
    assert.equal(result.canjes[0].beneficio_nombre, 'Gorra');
  });

  it('6. jugadores por nivel (filtro)', async () => {
    const sb = buildSupabaseMock();
    const result = await listPadcoinsReportesJugadores(sb, {
      role: { rol: 'super_admin' },
      query: { nivel: 'starter' },
    });
    assert.ok(Array.isArray(result.jugadores));
    for (const j of result.jugadores) {
      assert.equal(j.nivel_slug, 'starter');
    }
  });

  it('8. Super Admin listado canjes global', async () => {
    const sb = buildSupabaseMock();
    const result = await listPadcoinsReportesCanjes(sb, {
      role: { rol: 'super_admin' },
      query: {},
    });
    assert.equal(result.total, 2);
  });

  it('9. Admin Club sede ajena → 403', async () => {
    const sb = buildSupabaseMock();
    await assert.rejects(
      () => listPadcoinsReportesMovimientos(sb, {
        role: { rol: 'admin_club', sede_id: 1 },
        query: { sede_id: 2 },
      }),
      (err) => err.status === 403,
    );
  });

  it('15. sin resultados', async () => {
    const sb = buildSupabaseMock();
    const result = await listPadcoinsReportesMovimientos(sb, {
      role: { rol: 'super_admin' },
      query: { fecha_desde: '2099-01-01T00:00:00.000Z' },
    });
    assert.equal(result.total, 0);
    assert.deepEqual(result.movimientos, []);
  });

  it('17. datos históricos incompletos no rompen mapeo', () => {
    const row = mapPadcoinsReporteMovimientoRow({
      id: 'x',
      user_id: USER_A,
      tipo: 'earn',
      monto: 1,
      created_at: null,
      metadata: null,
    }, { jugadorMap: new Map(), sedeMap: new Map(), campaignMap: new Map() });
    assert.equal(row.jugador_nombre, null);
    assert.equal(row.campana_id, null);

    const canje = mapPadcoinsReporteCanjeRow({
      id: 'c',
      user_id: USER_A,
      sede_id: 1,
      premio_id: PREMIO_1,
      monto_padcoins: 10,
      estado: 'pendiente',
      codigo: null,
      created_at: '2026-01-01T00:00:00.000Z',
    }, { jugadorMap: new Map(), sedeMap: new Map() });
    assert.equal(canje.beneficio_nombre, null);
    assert.equal(canje.devolucion_realizada, false);
  });
});

describe('padcoins reportes — CSV', () => {
  it('10-13. CSV movimientos con tildes y BOM', async () => {
    const sb = buildSupabaseMock();
    const payload = await listPadcoinsReportesMovimientos(sb, {
      role: { rol: 'admin_club', sede_id: 1 },
      query: {},
      forExport: true,
    });
    const csv = buildPadcoinsMovimientosCsv(payload.movimientos);
    assert.ok(csv.startsWith(PADCOINS_CSV_BOM));
    assert.match(csv, /Vóley|Reserva/);
    assert.match(csv, /jugador_nombre/);
    const filename = buildPadcoinsCsvFilename('movimientos', { sedeId: 1, fecha: '2026-07-15' });
    assert.equal(filename, 'padcoins-movimientos_sede-1_2026-07-15.csv');
  });

  it('11. CSV canjes', async () => {
    const sb = buildSupabaseMock();
    const payload = await listPadcoinsReportesCanjes(sb, {
      role: { rol: 'super_admin' },
      query: {},
      forExport: true,
    });
    const csv = buildPadcoinsCanjesCsv(payload.canjes);
    assert.match(csv, /beneficio_nombre/);
    assert.match(csv, /Gorra/);
    assert.match(csv, /devolucion_realizada/);
  });

  it('12. CSV jugadores', async () => {
    const sb = buildSupabaseMock();
    const payload = await listPadcoinsReportesJugadores(sb, {
      role: { rol: 'super_admin' },
      query: {},
      forExport: true,
    });
    const csv = buildPadcoinsJugadoresCsv(payload.jugadores);
    assert.match(csv, /nivel_nombre/);
    assert.match(csv, /Ana Pérez|Bruno Gómez/);
  });

  it('14. protección CSV injection', () => {
    assert.equal(escapePadcoinsCsvCell('=1+1'), "'=1+1");
    assert.equal(escapePadcoinsCsvCell('+cmd'), "'+cmd");
    assert.equal(escapePadcoinsCsvCell('-1'), "'-1");
    assert.equal(escapePadcoinsCsvCell('@sum'), "'@sum");
    const csv = buildPadcoinsCsvContent(['nota'], [{ nota: '=cmd()' }]);
    assert.match(csv, /'=cmd\(\)/);
  });

  it('16. límite excedido', () => {
    assert.throws(
      () => assertPadcoinsExportWithinLimit(PADCOINS_CSV_MAX_EXPORT_ROWS + 1),
      (err) => err.status === 400 && /límite/i.test(err.message),
    );
  });
});
