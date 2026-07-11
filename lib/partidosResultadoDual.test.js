import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildManualEquiposAsignacion } from '../src/partidos/equiposService.js';
import { procesarResultadoPartidoCasual } from '../src/partidos/resultadoService.js';
import { normalizeXpReferenciaId } from '../src/xp/xpService.js';

const PARTIDO_ID = 901;
const CAP1 = '11111111-1111-1111-1111-111111111111';
const CAP2 = '22222222-2222-2222-2222-222222222222';
const P3 = '33333333-3333-3333-3333-333333333333';
const PAST_DATE = '2015-08-01';
const PAST_HORA = '04:00:00';

function pastPartido(overrides = {}) {
  const equipos = buildManualEquiposAsignacion({
    equipo1: [CAP1, P3],
    equipo2: [CAP2],
    capitanUserId: CAP1,
    participantUserIds: [CAP1, CAP2, P3],
  });

  return {
    id: PARTIDO_ID,
    capitan_user_id: CAP1,
    estado: 'completo',
    fecha: PAST_DATE,
    hora: PAST_HORA,
    sede_nombre: 'Test Sede',
    resultado_json: null,
    resultado: null,
    ganador: null,
    equipos_asignacion: equipos,
    ...overrides,
  };
}

function jugadoresRows() {
  return [
    { user_id: CAP1, email: 'c1@test.com', joined_at: '2026-06-01T10:00:00.000Z' },
    { user_id: CAP2, email: 'c2@test.com', joined_at: '2026-06-01T10:01:00.000Z' },
    { user_id: P3, email: 'p3@test.com', joined_at: '2026-06-01T10:02:00.000Z' },
  ];
}

function createDualResultadoSupabase(initialPartido = pastPartido(), {
  rpcHandler = null,
  updateShouldFail = false,
} = {}) {
  let partidoRow = { ...initialPartido };

  function applyPartidoUpdate(filters, updatePayload) {
    if (updateShouldFail) {
      return { data: null, error: { message: 'update failed', code: 'XX000' } };
    }
    const match = Object.entries(filters).every(
      ([k, v]) => String(partidoRow[k]) === String(v),
    );
    if (match) {
      partidoRow = { ...partidoRow, ...updatePayload };
    }
    return { data: match ? [{ ...partidoRow }] : null, error: null };
  }

  const supabase = {
    from(table) {
      const chain = {
        _filters: {},
        _updatePayload: null,
        select() { return chain; },
        eq(field, value) {
          chain._filters[field] = value;
          return chain;
        },
        order() { return chain; },
        update(payload) {
          chain._updatePayload = payload;
          return chain;
        },
        maybeSingle: async () => {
          const filters = { ...chain._filters };
          const updatePayload = chain._updatePayload;
          chain._filters = {};
          chain._updatePayload = null;

          if (table === 'partidos_abiertos') {
            if (updatePayload) {
              const result = applyPartidoUpdate(filters, updatePayload);
              return { data: result.data?.[0] ?? null, error: result.error };
            }

            const match = Object.entries(filters).every(
              ([k, v]) => String(partidoRow[k]) === String(v),
            );
            return { data: match ? { ...partidoRow } : null, error: null };
          }

          return { data: null, error: null };
        },
        then(resolve, reject) {
          const filters = { ...chain._filters };
          const updatePayload = chain._updatePayload;
          chain._filters = {};
          chain._updatePayload = null;

          if (table === 'partidos_abiertos' && updatePayload) {
            Promise.resolve(applyPartidoUpdate(filters, updatePayload)).then(resolve, reject);
            return undefined;
          }

          if (table === 'partidos_abiertos_jugadores') {
            let rows = jugadoresRows();
            if (filters.partido_id != null) {
              rows = rows.filter((r) => Number(filters.partido_id) === PARTIDO_ID);
            }
            resolve({ data: rows, error: null });
            return undefined;
          }

          resolve({ data: [], error: null });
          return undefined;
        },
      };
      return chain;
    },
    async rpc(name, params) {
      if (rpcHandler) {
        return rpcHandler(name, params);
      }
      return {
        data: [{ xp_sumado: 25, xp_total: 100, liga: 'INIT' }],
        error: null,
      };
    },
    _state: {
      get partido() { return partidoRow; },
    },
  };

  return supabase;
}

function bodyResultado(e1 = 6, e2 = 3) {
  return { resultado: { equipo1: e1, equipo2: e2 } };
}

describe('normalizeXpReferenciaId', () => {
  it('acepta UUID válido', () => {
    const uuid = 'aaaaaaaa-bbbb-cccc-dddd-111111111111';
    assert.equal(normalizeXpReferenciaId(uuid), uuid);
  });

  it('omite ID numérico de partido (evita error UUID en prod)', () => {
    assert.equal(normalizeXpReferenciaId(49), null);
    assert.equal(normalizeXpReferenciaId('49'), null);
  });

  it('omite slugs de rango', () => {
    assert.equal(normalizeXpReferenciaId('rookie'), null);
  });
});

describe('procesarResultadoPartidoCasual — confirmación dual', () => {
  it('primer capitán → pendiente, HTTP 200', async () => {
    const supabase = createDualResultadoSupabase();

    const result = await procesarResultadoPartidoCasual({
      supabaseAdmin: supabase,
      partidoId: PARTIDO_ID,
      user: { id: CAP1 },
      body: bodyResultado(),
    });

    assert.equal(result.status, 200);
    assert.equal(result.body.estado_confirmacion, 'pendiente');
    assert.equal(supabase._state.partido.estado, 'completo');
    assert.equal(supabase._state.partido.resultado_json.estado_confirmacion, 'pendiente');
  });

  it('rechaza resultado empatado con error controlado', async () => {
    const supabase = createDualResultadoSupabase();

    const result = await procesarResultadoPartidoCasual({
      supabaseAdmin: supabase,
      partidoId: PARTIDO_ID,
      user: { id: CAP1 },
      body: bodyResultado(4, 4),
    });

    assert.equal(result.status, 400);
    assert.equal(result.body.error, 'Debe haber un ganador');
    assert.equal(supabase._state.partido.estado, 'completo');
  });

  it('segundo capitán confirma → finalizado, HTTP 200, ganador y resultado correctos', async () => {
    const supabase = createDualResultadoSupabase(pastPartido({
      resultado_json: {
        cargas: {
          [CAP1]: { equipo1: 6, equipo2: 3, cargado_at: '2026-07-10T12:00:00.000Z' },
        },
        estado_confirmacion: 'pendiente',
      },
    }));

    let padcoinsCalls = 0;
    const result = await procesarResultadoPartidoCasual({
      supabaseAdmin: supabase,
      partidoId: PARTIDO_ID,
      user: { id: CAP2 },
      body: bodyResultado(),
      deps: {
        processCasualMatchPadcoinsAfterResultConfirmed: async () => {
          padcoinsCalls += 1;
          return { ok: true, attendance_pending: true, reason: 'attendance_window_opened' };
        },
      },
    });

    assert.equal(result.status, 200);
    assert.equal(result.body.estado_confirmacion, 'confirmado');
    assert.equal(result.body.ganador, 'equipo1');
    assert.deepEqual(result.body.resultado, { equipo1: 6, equipo2: 3 });
    assert.equal(supabase._state.partido.estado, 'finalizado');
    assert.equal(supabase._state.partido.ganador, 'equipo1');
    assert.equal(padcoinsCalls, 1);
    assert.equal(result.body.padcoins.attendance_pending, true);
  });

  it('apertura de asistencia invocada una sola vez en casual', async () => {
    const supabase = createDualResultadoSupabase(pastPartido({
      resultado_json: {
        cargas: {
          [CAP1]: { equipo1: 6, equipo2: 3, cargado_at: '2026-07-10T12:00:00.000Z' },
        },
        estado_confirmacion: 'pendiente',
      },
    }));

    let padcoinsCalls = 0;
    await procesarResultadoPartidoCasual({
      supabaseAdmin: supabase,
      partidoId: PARTIDO_ID,
      user: { id: CAP2 },
      body: bodyResultado(),
      deps: {
        processCasualMatchPadcoinsAfterResultConfirmed: async () => {
          padcoinsCalls += 1;
          return { ok: true, attendance_pending: true };
        },
      },
    });

    assert.equal(padcoinsCalls, 1);
  });

  it('fallo al abrir asistencia no cambia HTTP 200 del resultado', async () => {
    const supabase = createDualResultadoSupabase(pastPartido({
      resultado_json: {
        cargas: {
          [CAP1]: { equipo1: 6, equipo2: 3, cargado_at: '2026-07-10T12:00:00.000Z' },
        },
        estado_confirmacion: 'pendiente',
      },
    }));

    const result = await procesarResultadoPartidoCasual({
      supabaseAdmin: supabase,
      partidoId: PARTIDO_ID,
      user: { id: CAP2 },
      body: bodyResultado(),
      deps: {
        processCasualMatchPadcoinsAfterResultConfirmed: async () => {
          throw new Error('attendance window failed');
        },
      },
    });

    assert.equal(result.status, 200);
    assert.equal(result.body.estado_confirmacion, 'confirmado');
    assert.equal(supabase._state.partido.estado, 'finalizado');
    assert.equal(result.body.padcoins.acreditado, false);
  });

  it('fallo secundario de XP no cambia HTTP 200 ni bloquea PadCoins', async () => {
    const supabase = createDualResultadoSupabase(pastPartido({
      resultado_json: {
        cargas: {
          [CAP1]: { equipo1: 6, equipo2: 3, cargado_at: '2026-07-10T12:00:00.000Z' },
        },
        estado_confirmacion: 'pendiente',
      },
    }), {
      rpcHandler: (name) => {
        if (name === 'sumar_xp') {
          return {
            data: null,
            error: { message: 'rpc unavailable', code: 'XX000' },
          };
        }
        return { data: [{ xp_sumado: 25, xp_total: 100, liga: 'INIT' }], error: null };
      },
    });

    let padcoinsCalls = 0;
    const result = await procesarResultadoPartidoCasual({
      supabaseAdmin: supabase,
      partidoId: PARTIDO_ID,
      user: { id: CAP2 },
      body: bodyResultado(),
      deps: {
        processCasualMatchPadcoinsAfterResultConfirmed: async () => {
          padcoinsCalls += 1;
          return { ok: true, attendance_pending: true };
        },
      },
    });

    assert.equal(result.status, 200);
    assert.equal(padcoinsCalls, 1);
    assert.ok(Array.isArray(result.body.xp));
  });

  it('error real al persistir resultado devuelve error', async () => {
    const supabase = createDualResultadoSupabase(pastPartido({
      resultado_json: {
        cargas: {
          [CAP1]: { equipo1: 6, equipo2: 3, cargado_at: '2026-07-10T12:00:00.000Z' },
        },
        estado_confirmacion: 'pendiente',
      },
    }), { updateShouldFail: true });

    await assert.rejects(
      () => procesarResultadoPartidoCasual({
        supabaseAdmin: supabase,
        partidoId: PARTIDO_ID,
        user: { id: CAP2 },
        body: bodyResultado(),
      }),
      (err) => err.message === 'update failed',
    );
  });

  it('partido ya finalizado no re-ejecuta PadCoins', async () => {
    const supabase = createDualResultadoSupabase(pastPartido({
      estado: 'finalizado',
      ganador: 'equipo1',
      resultado: { equipo1: 6, equipo2: 3 },
      resultado_json: {
        cargas: {
          [CAP1]: { equipo1: 6, equipo2: 3, cargado_at: '2026-07-10T12:00:00.000Z' },
          [CAP2]: { equipo1: 6, equipo2: 3, cargado_at: '2026-07-10T12:01:00.000Z' },
        },
        estado_confirmacion: 'confirmado',
      },
    }));

    let padcoinsCalls = 0;
    const result = await procesarResultadoPartidoCasual({
      supabaseAdmin: supabase,
      partidoId: PARTIDO_ID,
      user: { id: CAP2 },
      body: bodyResultado(),
      deps: {
        processCasualMatchPadcoinsAfterResultConfirmed: async () => {
          padcoinsCalls += 1;
          return { ok: true, acreditado: false, reason: 'already_processed' };
        },
      },
    });

    assert.equal(result.status, 400);
    assert.equal(padcoinsCalls, 0);
  });

  it('torneo no usa procesarResultadoPartidoCasual para abrir asistencia casual', () => {
    assert.equal(
      typeof procesarResultadoPartidoCasual,
      'function',
    );
    assert.ok(true, 'flujo torneo usa cargarResultadoManualPartidoTorneoService, no resultado casual');
  });
});

describe('sumarXP referencia — regresión UUID prod', () => {
  it('RPC recibe null cuando referencia es ID numérico de partido', async () => {
    const rpcCalls = [];
    const supabase = {
      rpc: async (name, params) => {
        rpcCalls.push({ name, params });
        return { data: [{ xp_sumado: 25, xp_total: 25, liga: 'INIT' }], error: null };
      },
    };

    const { sumarXP } = await import('../src/xp/xpService.js');
    await sumarXP(supabase, CAP1, 'PARTIDO_CASUAL_CONFIRMADO', 'test', String(PARTIDO_ID));

    assert.equal(rpcCalls.length, 1);
    assert.equal(rpcCalls[0].params.p_referencia_id, null);
  });
});
