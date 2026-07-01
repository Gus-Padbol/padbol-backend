import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  advanceWinnerIfNeeded,
  getWinnerForPartido,
  resolveDestinoSlot,
} from './torneos/bracketAdvanceService.js';

function createAdvanceMock({ fuente, destino, onDestinoUpdate }) {
  const state = {
    fuente: fuente ? { ...fuente } : null,
    destino: destino ? { ...destino } : null,
  };

  const supabaseAdmin = {
    from(table) {
      const api = {
        _eqVal: null,
        select() { return api; },
        eq(_col, val) {
          this._eqVal = val;
          return api;
        },
        maybeSingle() {
          if (table === 'partidos') {
            const id = Number(this._eqVal);
            if (state.fuente && Number(state.fuente.id) === id) {
              return Promise.resolve({ data: state.fuente, error: null });
            }
            if (state.destino && Number(state.destino.id) === id) {
              return Promise.resolve({ data: state.destino, error: null });
            }
            return Promise.resolve({ data: null, error: null });
          }
          return Promise.resolve({ data: null, error: null });
        },
        update(patch) {
          return {
            eq: (_col, val) => {
              if (table === 'partidos' && state.destino && Number(state.destino.id) === Number(val)) {
                onDestinoUpdate?.(patch, val);
                state.destino = { ...state.destino, ...patch };
              }
              return Promise.resolve({ error: null });
            },
          };
        },
      };
      return api;
    },
  };

  return { supabaseAdmin, state };
}

function partidoFuente(overrides = {}) {
  return {
    id: 10,
    torneo_id: 100,
    estado: 'finalizado',
    grupo: null,
    equipo_a_id: 1,
    equipo_b_id: 2,
    ganador_equipo_id: 1,
    resultado: { goles_a: 2, goles_b: 0 },
    partido_siguiente_id: 20,
    partido_siguiente_slot: 'A',
    ...overrides,
  };
}

function partidoDestino(overrides = {}) {
  return {
    id: 20,
    torneo_id: 100,
    estado: 'pendiente',
    equipo_a_id: null,
    equipo_b_id: null,
    ...overrides,
  };
}

describe('getWinnerForPartido', () => {
  it('prioriza ganador_equipo_id válido', () => {
    assert.equal(getWinnerForPartido({
      equipo_a_id: 1,
      equipo_b_id: 2,
      ganador_equipo_id: 1,
      resultado: { goles_a: 0, goles_b: 2 },
    }), 1);
  });

  it('resuelve ganador desde resultado legacy si falta ganador_equipo_id', () => {
    assert.equal(getWinnerForPartido({
      equipo_a_id: 1,
      equipo_b_id: 2,
      ganador_equipo_id: null,
      estado: 'finalizado',
      resultado: { goles_a: 2, goles_b: 0 },
    }), 1);
  });
});

describe('resolveDestinoSlot', () => {
  it('mapea slot A y B a columnas destino', () => {
    assert.deepEqual(resolveDestinoSlot({
      partido_siguiente_id: 20,
      partido_siguiente_slot: 'A',
    }), {
      destinoPartidoId: 20,
      slot: 'A',
      column: 'equipo_a_id',
    });

    assert.deepEqual(resolveDestinoSlot({
      partido_siguiente_id: 20,
      partido_siguiente_slot: 'b',
    }), {
      destinoPartidoId: 20,
      slot: 'B',
      column: 'equipo_b_id',
    });
  });

  it('devuelve null si slot inválido', () => {
    assert.equal(resolveDestinoSlot({
      partido_siguiente_id: 20,
      partido_siguiente_slot: 'X',
    }), null);
  });
});

describe('advanceWinnerIfNeeded', () => {
  it('avanza ganador a slot A vacío', async () => {
    const updates = [];
    const { supabaseAdmin, state } = createAdvanceMock({
      fuente: partidoFuente({ partido_siguiente_slot: 'A' }),
      destino: partidoDestino(),
      onDestinoUpdate: (patch) => updates.push(patch),
    });

    const result = await advanceWinnerIfNeeded(supabaseAdmin, { partidoId: 10 });

    assert.equal(result.status, 'advanced');
    assert.equal(result.reason, 'ganador_avanzado');
    assert.equal(result.slot, 'A');
    assert.equal(result.ganador_equipo_id, 1);
    assert.equal(state.destino.equipo_a_id, 1);
    assert.deepEqual(updates, [{ equipo_a_id: 1 }]);
  });

  it('avanza ganador a slot B vacío', async () => {
    const { supabaseAdmin, state } = createAdvanceMock({
      fuente: partidoFuente({ partido_siguiente_slot: 'B' }),
      destino: partidoDestino({ equipo_a_id: 3 }),
    });

    const result = await advanceWinnerIfNeeded(supabaseAdmin, { partidoId: 10 });

    assert.equal(result.status, 'advanced');
    assert.equal(result.slot, 'B');
    assert.equal(state.destino.equipo_b_id, 1);
    assert.equal(state.destino.equipo_a_id, 3);
    assert.equal(state.destino.estado, 'pendiente');
  });

  it('es idempotente si el slot ya tiene el mismo ganador', async () => {
    const updates = [];
    const { supabaseAdmin } = createAdvanceMock({
      fuente: partidoFuente({ partido_siguiente_slot: 'A' }),
      destino: partidoDestino({ equipo_a_id: 1 }),
      onDestinoUpdate: (patch) => updates.push(patch),
    });

    const result = await advanceWinnerIfNeeded(supabaseAdmin, { partidoId: 10 });

    assert.equal(result.status, 'skipped');
    assert.equal(result.reason, 'ya_avanzado');
    assert.equal(updates.length, 0);
  });

  it('conflict si el slot tiene otro equipo', async () => {
    const updates = [];
    const { supabaseAdmin, state } = createAdvanceMock({
      fuente: partidoFuente({ partido_siguiente_slot: 'A' }),
      destino: partidoDestino({ equipo_a_id: 99 }),
      onDestinoUpdate: (patch) => updates.push(patch),
    });

    const result = await advanceWinnerIfNeeded(supabaseAdmin, { partidoId: 10 });

    assert.equal(result.status, 'conflict');
    assert.equal(result.reason, 'slot_ocupado');
    assert.equal(state.destino.equipo_a_id, 99);
    assert.equal(updates.length, 0);
  });

  it('skipped si no hay destino', async () => {
    const { supabaseAdmin } = createAdvanceMock({
      fuente: partidoFuente({ partido_siguiente_id: null, partido_siguiente_slot: null }),
      destino: partidoDestino(),
    });

    const result = await advanceWinnerIfNeeded(supabaseAdmin, { partidoId: 10 });

    assert.equal(result.status, 'skipped');
    assert.equal(result.reason, 'no_destino');
  });

  it('skipped si no hay ganador', async () => {
    const { supabaseAdmin } = createAdvanceMock({
      fuente: partidoFuente({
        ganador_equipo_id: null,
        resultado: null,
      }),
      destino: partidoDestino(),
    });

    const result = await advanceWinnerIfNeeded(supabaseAdmin, { partidoId: 10 });

    assert.equal(result.status, 'skipped');
    assert.equal(result.reason, 'no_ganador');
  });

  it('skipped si partido no está finalizado', async () => {
    const { supabaseAdmin } = createAdvanceMock({
      fuente: partidoFuente({ estado: 'pendiente' }),
      destino: partidoDestino(),
    });

    const result = await advanceWinnerIfNeeded(supabaseAdmin, { partidoId: 10 });

    assert.equal(result.status, 'skipped');
    assert.equal(result.reason, 'not_finalizado');
  });

  it('skipped si grupo no null', async () => {
    const { supabaseAdmin } = createAdvanceMock({
      fuente: partidoFuente({ grupo: 'A' }),
      destino: partidoDestino(),
    });

    const result = await advanceWinnerIfNeeded(supabaseAdmin, { partidoId: 10 });

    assert.equal(result.status, 'skipped');
    assert.equal(result.reason, 'fase_grupos');
  });

  it('failed si destino no existe', async () => {
    const { supabaseAdmin } = createAdvanceMock({
      fuente: partidoFuente({ partido_siguiente_id: 999 }),
      destino: null,
    });

    const result = await advanceWinnerIfNeeded(supabaseAdmin, { partidoId: 10 });

    assert.equal(result.status, 'failed');
    assert.equal(result.reason, 'destino_not_found');
  });

  it('failed si destino pertenece a otro torneo', async () => {
    const { supabaseAdmin } = createAdvanceMock({
      fuente: partidoFuente({ torneo_id: 100 }),
      destino: partidoDestino({ torneo_id: 200 }),
    });

    const result = await advanceWinnerIfNeeded(supabaseAdmin, { partidoId: 10 });

    assert.equal(result.status, 'failed');
    assert.equal(result.reason, 'torneo_mismatch');
  });

  it('failed si slot inválido', async () => {
    const { supabaseAdmin } = createAdvanceMock({
      fuente: partidoFuente({ partido_siguiente_slot: 'Z' }),
      destino: partidoDestino(),
    });

    const result = await advanceWinnerIfNeeded(supabaseAdmin, { partidoId: 10 });

    assert.equal(result.status, 'failed');
    assert.equal(result.reason, 'slot_invalido');
  });

  it('cuando destino queda completo, estado pendiente', async () => {
    const { supabaseAdmin, state } = createAdvanceMock({
      fuente: partidoFuente({ partido_siguiente_slot: 'B' }),
      destino: partidoDestino({ equipo_a_id: 3, estado: 'programado' }),
    });

    const result = await advanceWinnerIfNeeded(supabaseAdmin, { partidoId: 10 });

    assert.equal(result.status, 'advanced');
    assert.equal(state.destino.equipo_a_id, 3);
    assert.equal(state.destino.equipo_b_id, 1);
    assert.equal(state.destino.estado, 'pendiente');
  });

  it('no pisa destino finalizado', async () => {
    const { supabaseAdmin, state } = createAdvanceMock({
      fuente: partidoFuente({ partido_siguiente_slot: 'B' }),
      destino: partidoDestino({
        equipo_a_id: 3,
        estado: 'finalizado',
      }),
    });

    const result = await advanceWinnerIfNeeded(supabaseAdmin, { partidoId: 10 });

    assert.equal(result.status, 'advanced');
    assert.equal(state.destino.equipo_b_id, 1);
    assert.equal(state.destino.estado, 'finalizado');
  });

  it('no pisa destino en_curso', async () => {
    const { supabaseAdmin, state } = createAdvanceMock({
      fuente: partidoFuente({ partido_siguiente_slot: 'B' }),
      destino: partidoDestino({
        equipo_a_id: 3,
        estado: 'en_curso',
      }),
    });

    const result = await advanceWinnerIfNeeded(supabaseAdmin, { partidoId: 10 });

    assert.equal(result.status, 'advanced');
    assert.equal(state.destino.equipo_b_id, 1);
    assert.equal(state.destino.estado, 'en_curso');
  });

  it('resuelve ganador desde resultado legacy interno si ganador_equipo_id falta', async () => {
    const { supabaseAdmin, state } = createAdvanceMock({
      fuente: partidoFuente({
        ganador_equipo_id: null,
        resultado: { goles_a: 2, goles_b: 1 },
      }),
      destino: partidoDestino(),
    });

    const result = await advanceWinnerIfNeeded(supabaseAdmin, { partidoId: 10 });

    assert.equal(result.status, 'advanced');
    assert.equal(result.ganador_equipo_id, 1);
    assert.equal(state.destino.equipo_a_id, 1);
  });

  it('failed si partido no existe', async () => {
    const { supabaseAdmin } = createAdvanceMock({
      fuente: null,
      destino: partidoDestino(),
    });

    const result = await advanceWinnerIfNeeded(supabaseAdmin, { partidoId: 10 });

    assert.equal(result.status, 'failed');
    assert.equal(result.reason, 'partido_not_found');
  });
});
