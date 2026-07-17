/**
 * Tests — GET /api/admin/torneos/resumen-stats (batch, sin N+1).
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { requireAdminUser, requireAuthenticatedUser } from '../authAccess.js';
import {
  TORNEOS_RESUMEN_MAX_IDS,
  aggregateTorneoResumenItem,
  assertResumenItemIsMinimal,
  buildEmptyTorneoResumenItem,
  classifyEquipoInscripcionEstado,
  getTorneosResumenStats,
  isPartidoJugado,
  isPartidoPendiente,
  parseTorneosResumenQuery,
  resolveSorteoRealizado,
  resolveTieneGrupos,
  resolveTorneosResumenScope,
} from './torneosResumenStatsService.js';

function createMockRes() {
  return {
    statusCode: null,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

function roleDeps(roleRow) {
  return {
    getAuthenticatedUser: async () => ({ user: { id: 'u-1', email: 'a@b.com' } }),
    fetchUserRoleRowForAuthUser: async () => roleRow,
    legacySuperAdminEmails: [],
  };
}

/**
 * Mock supabaseAdmin con conteo de queries por tabla.
 * Soporta: from().select().eq().in().order().limit() y Promise resolution.
 */
function createSupabaseMock({ torneos = [], equipos = [], partidos = [], tabla_puntos = [] } = {}) {
  const tables = { torneos, equipos, partidos, tabla_puntos };
  const tracker = { queries: [] };

  function makeBuilder(table) {
    const state = {
      filtersEq: {},
      filtersIn: {},
      limit: null,
    };

    const builder = {
      select() {
        return builder;
      },
      eq(col, val) {
        state.filtersEq[col] = val;
        return builder;
      },
      in(col, vals) {
        state.filtersIn[col] = vals.map(Number);
        return builder;
      },
      order() {
        return builder;
      },
      limit(n) {
        state.limit = n;
        return builder;
      },
      then(resolve, reject) {
        return Promise.resolve()
          .then(() => {
            let rows = [...(tables[table] || [])];
            for (const [col, val] of Object.entries(state.filtersEq)) {
              rows = rows.filter((r) => String(r[col]) === String(val));
            }
            for (const [col, vals] of Object.entries(state.filtersIn)) {
              const set = new Set(vals.map(Number));
              rows = rows.filter((r) => set.has(Number(r[col])));
            }
            if (state.limit != null) rows = rows.slice(0, state.limit);
            return { data: rows, error: null };
          })
          .then(resolve, reject);
      },
    };
    return builder;
  }

  return {
    supabaseAdmin: {
      from(table) {
        return makeBuilder(table);
      },
    },
    tracker,
  };
}

describe('auth gates del resumen batch', () => {
  it('1. sin JWT → 401', async () => {
    const res = createMockRes();
    const user = await requireAuthenticatedUser({}, res, async () => ({
      user: null,
      status: 401,
      error: 'Se requiere Authorization Bearer token',
    }));
    assert.equal(user, null);
    assert.equal(res.statusCode, 401);
  });

  it('2. rol no autorizado → 403', async () => {
    const res = createMockRes();
    const auth = await requireAdminUser({}, res, roleDeps({ role: 'jugador', sede_id: null }));
    assert.equal(auth, null);
    assert.equal(res.statusCode, 403);
  });
});

describe('resolveTorneosResumenScope', () => {
  it('3. super_admin obtiene alcance global', () => {
    const scope = resolveTorneosResumenScope({ rol: 'super_admin', sede_id: null }, null);
    assert.equal(scope.ok, true);
    assert.equal(scope.sedeId, null);
    assert.equal(scope.requireSede, false);
  });

  it('4. admin_club obtiene solo su sede', () => {
    const scope = resolveTorneosResumenScope({ rol: 'admin_club', sede_id: 7 }, null);
    assert.equal(scope.ok, true);
    assert.equal(scope.sedeId, 7);
    assert.equal(scope.requireSede, true);
  });

  it('5. admin_club no puede consultar otra sede', () => {
    const scope = resolveTorneosResumenScope({ rol: 'admin_club', sede_id: 7 }, 9);
    assert.equal(scope.ok, false);
    assert.equal(scope.status, 403);
  });

  it('6. admin_nacional respeta su alcance (sin admin de torneos)', () => {
    const scope = resolveTorneosResumenScope({ rol: 'admin_nacional', sede_id: null }, null);
    assert.equal(scope.ok, false);
    assert.equal(scope.status, 403);
  });

  it('7. empleado conserva su alcance real (sin admin de torneos)', () => {
    const scope = resolveTorneosResumenScope({ rol: 'empleado', sede_id: 1 }, 1);
    assert.equal(scope.ok, false);
    assert.equal(scope.status, 403);
  });
});

describe('parseTorneosResumenQuery', () => {
  it('8. torneo_ids inválidos → 400', () => {
    assert.throws(() => parseTorneosResumenQuery({ torneo_ids: '1,abc' }), (err) => err.status === 400);
    assert.throws(() => parseTorneosResumenQuery({ torneo_ids: '-3' }), (err) => err.status === 400);
  });

  it('9. torneo_ids duplicados se deduplican', () => {
    const parsed = parseTorneosResumenQuery({ torneo_ids: '5,5,7,5' });
    assert.deepEqual(parsed.torneoIds, [5, 7]);
  });

  it('10. más del máximo permitido → 400', () => {
    const ids = Array.from({ length: TORNEOS_RESUMEN_MAX_IDS + 1 }, (_, i) => i + 1).join(',');
    assert.throws(() => parseTorneosResumenQuery({ torneo_ids: ids }), (err) => err.status === 400);
  });
});

describe('getTorneosResumenStats — scope y agregación', () => {
  const baseTorneos = [
    { id: 1, sede_id: 10, estado: 'en_curso', tipo_torneo: 'grupos_knockout', nombre: 'A' },
    { id: 2, sede_id: 20, estado: 'finalizado', tipo_torneo: 'round_robin', nombre: 'B' },
    { id: 3, sede_id: 10, estado: 'planificacion', tipo_torneo: 'grupos_knockout', nombre: 'C' },
  ];
  const baseEquipos = [
    { id: 101, torneo_id: 1, nombre: 'Eq1', inscripcion_estado: 'confirmado', grupo: 'A' },
    { id: 102, torneo_id: 1, nombre: 'Eq2', inscripcion_estado: 'pendiente', grupo: null },
    { id: 103, torneo_id: 1, nombre: 'Eq3', estado: 'activo', grupo: 'B' },
    { id: 201, torneo_id: 2, nombre: 'Campeon', inscripcion_estado: 'confirmado', grupo: null },
    { id: 202, torneo_id: 2, nombre: 'Sub', inscripcion_estado: 'confirmado', grupo: null },
  ];
  const basePartidos = [
    { id: 1001, torneo_id: 1, estado: 'finalizado', grupo: 'A' },
    { id: 1002, torneo_id: 1, estado: 'pendiente', grupo: 'A' },
    { id: 1003, torneo_id: 1, estado: 'cancelado', grupo: null },
    { id: 2001, torneo_id: 2, estado: 'finalizado', grupo: null },
  ];
  const baseTabla = [
    { torneo_id: 2, equipo_id: 201, posicion: 1 },
  ];

  it('11. torneo_ids no salta el scope de admin_club', async () => {
    const { supabaseAdmin, tracker } = createSupabaseMock({
      torneos: baseTorneos,
      equipos: baseEquipos,
      partidos: basePartidos,
      tabla_puntos: baseTabla,
    });
    const result = await getTorneosResumenStats(
      supabaseAdmin,
      { role: { rol: 'admin_club', sede_id: 10 }, query: { torneo_ids: '1,2' } },
      { tracker },
    );
    // Solo torneo 1 (sede 10); el 2 queda filtrado por .eq('sede_id', 10) del mock + scope.
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].torneo_id, '1');
  });

  it('12. torneo sin equipos → conteos en cero', () => {
    const item = aggregateTorneoResumenItem({
      torneoId: 99,
      torneoEstado: 'planificacion',
      equipos: [],
      partidos: [{ id: 1, estado: 'pendiente' }],
    });
    assert.equal(item.equipos_count, 0);
    assert.equal(item.equipos_confirmados, 0);
    assert.equal(item.equipos_pendientes, 0);
  });

  it('13. torneo sin partidos → conteos en cero', () => {
    const item = buildEmptyTorneoResumenItem(55);
    assert.equal(item.partidos_total, 0);
    assert.equal(item.partidos_jugados, 0);
    assert.equal(item.partidos_pendientes, 0);
    assert.equal(item.sorteo_realizado, false);
  });

  it('14–16. equipos_count / confirmados / pendientes correctos', () => {
    const equipos = [
      { inscripcion_estado: 'confirmado' },
      { inscripcion_estado: 'pendiente' },
      { estado: '' }, // default confirmado
      { status: 'rechazado' }, // otro → solo count
    ];
    const item = aggregateTorneoResumenItem({ torneoId: 1, equipos, partidos: [] });
    assert.equal(item.equipos_count, 4);
    assert.equal(item.equipos_confirmados, 2);
    assert.equal(item.equipos_pendientes, 1);
  });

  it('17–19. partidos_total / jugados / pendientes correctos', () => {
    const partidos = [
      { estado: 'finalizado' },
      { estado: 'pendiente' },
      { estado: 'en_curso' },
      { estado: 'cancelado' },
    ];
    const item = aggregateTorneoResumenItem({ torneoId: 1, equipos: [], partidos });
    assert.equal(item.partidos_total, 4);
    assert.equal(item.partidos_jugados, 1);
    assert.equal(item.partidos_pendientes, 2);
  });

  it('20. tiene_grupos correcto', () => {
    assert.equal(resolveTieneGrupos([{ grupo: null }], [{ grupo: null }]), false);
    assert.equal(resolveTieneGrupos([{ grupo: 'A' }], []), true);
    assert.equal(resolveTieneGrupos([], [{ grupo: 'B' }]), true);
  });

  it('21. sorteo_realizado correcto', () => {
    assert.equal(resolveSorteoRealizado([]), false);
    assert.equal(resolveSorteoRealizado([{ id: 1 }]), true);
  });

  it('22. torneo no finalizado no devuelve ganador', () => {
    const item = aggregateTorneoResumenItem({
      torneoId: 1,
      torneoEstado: 'en_curso',
      equipos: [],
      partidos: [],
      winnerEquipoId: 201,
      winnerNombre: 'Campeon',
    });
    assert.equal(item.winner_equipo_id, null);
    assert.equal(item.winner_nombre, null);
  });

  it('23. ganador desconocido → null', () => {
    const item = aggregateTorneoResumenItem({
      torneoId: 2,
      torneoEstado: 'finalizado',
      equipos: [],
      partidos: [],
      winnerEquipoId: null,
      winnerNombre: null,
    });
    assert.equal(item.winner_equipo_id, null);
    assert.equal(item.winner_nombre, null);
  });

  it('24. ganador confiable se normaliza correctamente', async () => {
    const { supabaseAdmin, tracker } = createSupabaseMock({
      torneos: [baseTorneos[1]],
      equipos: baseEquipos.filter((e) => e.torneo_id === 2),
      partidos: basePartidos.filter((p) => p.torneo_id === 2),
      tabla_puntos: baseTabla,
    });
    const result = await getTorneosResumenStats(
      supabaseAdmin,
      { role: { rol: 'super_admin', sede_id: null }, query: { torneo_ids: '2' } },
      { tracker },
    );
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].winner_equipo_id, '201');
    assert.equal(result.items[0].winner_nombre, 'Campeon');
  });

  it('25–27. no aparecen emails, teléfonos, jugadores ni partidos completos', () => {
    const item = aggregateTorneoResumenItem({
      torneoId: 1,
      torneoEstado: 'finalizado',
      equipos: [{ inscripcion_estado: 'confirmado', nombre: 'X' }],
      partidos: [{ estado: 'finalizado', grupo: 'A' }],
      winnerEquipoId: 9,
      winnerNombre: 'X',
    });
    assert.equal(assertResumenItemIsMinimal(item), true);
    const keys = Object.keys(item);
    assert.ok(!keys.includes('email'));
    assert.ok(!keys.includes('telefono'));
    assert.ok(!keys.includes('jugadores'));
    assert.ok(!keys.includes('resultado'));
  });

  it('28–31. cantidad de queries constante (1 / 10 / 50 torneos)', async () => {
    async function measure(n, withFinalizado) {
      const torneos = Array.from({ length: n }, (_, i) => ({
        id: i + 1,
        sede_id: 1,
        estado: withFinalizado && i === 0 ? 'finalizado' : 'en_curso',
        tipo_torneo: 'round_robin',
        nombre: `T${i + 1}`,
      }));
      const equipos = torneos.flatMap((t) => [
        { id: t.id * 10, torneo_id: t.id, nombre: 'A', inscripcion_estado: 'confirmado' },
      ]);
      const partidos = torneos.flatMap((t) => [
        { id: t.id * 100, torneo_id: t.id, estado: 'pendiente', grupo: null },
      ]);
      const tabla_puntos = withFinalizado
        ? [{ torneo_id: 1, equipo_id: 10, posicion: 1 }]
        : [];
      const { supabaseAdmin, tracker } = createSupabaseMock({
        torneos,
        equipos,
        partidos,
        tabla_puntos,
      });
      const result = await getTorneosResumenStats(
        supabaseAdmin,
        { role: { rol: 'super_admin', sede_id: null }, query: { limit: String(n) } },
        { tracker },
      );
      assert.equal(result.items.length, n);
      return tracker.queries.length;
    }

    const q1 = await measure(1, false);
    const q10 = await measure(10, false);
    const q50 = await measure(50, false);
    // Sin finalizados: torneos + equipos + partidos = 3
    assert.equal(q1, 3, `1 torneo → ${q1} queries`);
    assert.equal(q10, 3, `10 torneos → ${q10} queries`);
    assert.equal(q50, 3, `50 torneos → ${q50} queries`);

    const q1f = await measure(1, true);
    const q10f = await measure(10, true);
    const q50f = await measure(50, true);
    // Con finalizados: + tabla_puntos = 4
    assert.equal(q1f, 4);
    assert.equal(q10f, 4);
    assert.equal(q50f, 4);
  });

  it('29. con 1 torneo no hace consultas individuales por recurso', async () => {
    const { supabaseAdmin, tracker } = createSupabaseMock({
      torneos: [baseTorneos[0]],
      equipos: baseEquipos.filter((e) => e.torneo_id === 1),
      partidos: basePartidos.filter((p) => p.torneo_id === 1),
    });
    await getTorneosResumenStats(
      supabaseAdmin,
      { role: { rol: 'super_admin', sede_id: null }, query: { torneo_ids: '1' } },
      { tracker },
    );
    // Nunca "equipos:1", "partidos:1" — solo nombres de tabla una vez.
    assert.deepEqual(tracker.queries, ['torneos', 'equipos', 'partidos']);
  });

  it('32. fuentes vacías no rompen el endpoint', async () => {
    const { supabaseAdmin, tracker } = createSupabaseMock({
      torneos: [],
      equipos: [],
      partidos: [],
    });
    const result = await getTorneosResumenStats(
      supabaseAdmin,
      { role: { rol: 'super_admin', sede_id: null }, query: {} },
      { tracker },
    );
    assert.deepEqual(result.items, []);
    assert.equal(tracker.queries.length, 1);
  });

  it('33. error de consulta → propagado para respuesta controlada', async () => {
    const failing = {
      from() {
        return {
          select() { return this; },
          eq() { return this; },
          in() { return this; },
          order() { return this; },
          limit() { return this; },
          then(resolve, reject) {
            return Promise.resolve({ data: null, error: new Error('boom db') }).then(resolve, reject);
          },
        };
      },
    };
    await assert.rejects(
      () => getTorneosResumenStats(failing, { role: { rol: 'super_admin' }, query: {} }),
      /boom db/,
    );
  });
});

describe('criterios auxiliares y anti-empate', () => {
  it('34. helpers de estado siguen el contrato público existente', () => {
    assert.equal(classifyEquipoInscripcionEstado({}), 'confirmado');
    assert.equal(classifyEquipoInscripcionEstado({ inscripcion_estado: 'pendiente_pago' }), 'pendiente');
    assert.equal(isPartidoJugado({ estado: 'finalizado' }), true);
    assert.equal(isPartidoJugado({ estado: 'en_curso' }), false);
    assert.equal(isPartidoPendiente({ estado: 'cancelado' }), false);
  });

  it('35. no se introduce texto ni estado de empate', () => {
    const item = aggregateTorneoResumenItem({
      torneoId: 1,
      torneoEstado: 'finalizado',
      equipos: [{ inscripcion_estado: 'confirmado' }],
      partidos: [{ estado: 'finalizado' }],
    });
    const serialized = JSON.stringify(item).toLowerCase();
    assert.ok(!serialized.includes('empate'));
    assert.ok(!serialized.includes('draw'));
  });

  it('super_admin puede filtrar por sede_id sin ampliar roles', () => {
    const scope = resolveTorneosResumenScope({ rol: 'super_admin' }, 15);
    assert.equal(scope.ok, true);
    assert.equal(scope.sedeId, 15);
  });
});
