import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildPartidoTorneoResultadoFromScoreboard,
  isAlreadySyncedMatch,
  partidoHasFinalResult,
  resolveGanadorEquipoId,
  resolveTorneoWinnerSide,
  syncScoreboardToTorneoPartido,
} from '../src/scoreboard/scoreboardTorneoSyncService.js';

function createSyncMock({
  scoreboard,
  partido,
  onPartidoUpdate,
  onScoreboardUpdate,
  onRpc,
}) {
  const state = {
    scoreboard: scoreboard ? { ...scoreboard } : null,
    partido: partido ? { ...partido } : null,
  };

  const supabaseAdmin = {
    rpc(name, payload) { return onRpc?.(name, payload) ?? Promise.resolve({ data: null, error: null }); },
    from(table) {
      const api = {
        _eqVal: null,
        _projection: null,
        select(projection) { api._projection = projection; return api; },
        eq(_col, val) {
          this._eqVal = val;
          return api;
        },
        maybeSingle() {
          if (table === 'scoreboard_partidos') {
            return Promise.resolve({ data: state.scoreboard ? Object.fromEntries(api._projection.split(',').map(k => k.trim()).filter(k => k in state.scoreboard).map(k => [k, state.scoreboard[k]])) : null, error: null });
          }
          if (table === 'partidos') {
            return Promise.resolve({ data: state.partido, error: null });
          }
          return Promise.resolve({ data: null, error: null });
        },
        update(patch) {
          return {
            eq: (_col, val) => {
              if (table === 'partidos') {
                onPartidoUpdate?.(patch, val);
                if (state.partido && Number(state.partido.id) === Number(val)) {
                  state.partido = { ...state.partido, ...patch };
                }
              }
              if (table === 'scoreboard_partidos') {
                onScoreboardUpdate?.(patch, val);
                if (state.scoreboard && String(state.scoreboard.id) === String(val)) {
                  state.scoreboard = { ...state.scoreboard, ...patch };
                }
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

describe('scoreboardTorneoSyncService helpers', () => {
  it('resolveTorneoWinnerSide valida best-of-3', () => {
    assert.equal(resolveTorneoWinnerSide(2, 0), 'A');
    assert.equal(resolveTorneoWinnerSide(1, 2), 'B');
    assert.equal(resolveTorneoWinnerSide(1, 1), null);
    assert.equal(resolveTorneoWinnerSide(1, 0), null);
  });

  it('buildPartidoTorneoResultadoFromScoreboard mapea sets a goles', () => {
    assert.deepEqual(
      buildPartidoTorneoResultadoFromScoreboard({ sets_a: 2, sets_b: 1 }),
      { goles_a: 2, goles_b: 1 },
    );
  });
});

describe('syncScoreboardToTorneoPartido', () => {
  it('scoreboard terminado 2-0 gana A → resultado y ganador equipo_a_id', async () => {
    const partidoUpdates = [];
    const scoreboardUpdates = [];
    const { supabaseAdmin, state } = createSyncMock({
      scoreboard: {
        id: 'sb-1',
        partido_torneo_id: 28,
        estado: 'terminado',
        sets_a: 2,
        sets_b: 0,
        sync_torneo_status: null,
      },
      partido: {
        id: 28,
        estado: 'programado',
        resultado: null,
        equipo_a_id: 61,
        equipo_b_id: 62,
      },
      onPartidoUpdate: (patch) => partidoUpdates.push(patch),
      onScoreboardUpdate: (patch) => scoreboardUpdates.push(patch),
    });

    const result = await syncScoreboardToTorneoPartido(supabaseAdmin, 'sb-1');

    assert.equal(result.ok, true);
    assert.equal(result.status, 'synced');
    assert.deepEqual(result.resultado, { goles_a: 2, goles_b: 0 });
    assert.equal(result.ganador_equipo_id, 61);
    assert.equal(state.partido.estado, 'finalizado');
    assert.deepEqual(state.partido.resultado, { goles_a: 2, goles_b: 0 });
    assert.equal(state.partido.ganador_equipo_id, 61);
    assert.equal(scoreboardUpdates.at(-1)?.sync_torneo_status, 'synced');
    assert.ok(scoreboardUpdates.at(-1)?.synced_to_torneo_at);
    assert.equal(partidoUpdates.length, 1);
  });

  it('scoreboard terminado 1-2 gana B → ganador equipo_b_id', async () => {
    const { supabaseAdmin, state } = createSyncMock({
      scoreboard: {
        id: 'sb-2',
        partido_torneo_id: 30,
        estado: 'terminado',
        sets_a: 1,
        sets_b: 2,
      },
      partido: {
        id: 30,
        estado: 'pendiente',
        resultado: null,
        equipo_a_id: 10,
        equipo_b_id: 20,
      },
    });

    const result = await syncScoreboardToTorneoPartido(supabaseAdmin, 'sb-2');

    assert.equal(result.status, 'synced');
    assert.equal(result.ganador_equipo_id, 20);
    assert.deepEqual(result.resultado, { goles_a: 1, goles_b: 2 });
    assert.equal(state.partido.ganador_equipo_id, 20);
  });

  it('scoreboard sin partido_torneo_id → skipped, no update partido', async () => {
    const partidoUpdates = [];
    const { supabaseAdmin, state } = createSyncMock({
      scoreboard: {
        id: 'sb-manual',
        partido_torneo_id: null,
        estado: 'terminado',
        sets_a: 2,
        sets_b: 0,
      },
      partido: {
        id: 99,
        estado: 'programado',
        resultado: null,
        equipo_a_id: 1,
        equipo_b_id: 2,
      },
      onPartidoUpdate: () => partidoUpdates.push(1),
    });

    const result = await syncScoreboardToTorneoPartido(supabaseAdmin, 'sb-manual');

    assert.equal(result.status, 'skipped');
    assert.equal(result.reason, 'sin_partido_torneo_id');
    assert.equal(partidoUpdates.length, 0);
    assert.equal(state.partido.estado, 'programado');
  });

  it('scoreboard pendiente → skipped noop', async () => {
    const partidoUpdates = [];
    const scoreboardUpdates = [];
    const { supabaseAdmin } = createSyncMock({
      scoreboard: {
        id: 'sb-p',
        partido_torneo_id: 28,
        estado: 'pendiente',
        sets_a: 0,
        sets_b: 0,
      },
      partido: {
        id: 28,
        estado: 'programado',
        resultado: null,
        equipo_a_id: 61,
        equipo_b_id: 62,
      },
      onPartidoUpdate: () => partidoUpdates.push(1),
      onScoreboardUpdate: () => scoreboardUpdates.push(1),
    });

    const result = await syncScoreboardToTorneoPartido(supabaseAdmin, 'sb-p');

    assert.equal(result.status, 'skipped');
    assert.equal(result.reason, 'scoreboard_no_terminado');
    assert.equal(partidoUpdates.length, 0);
    assert.equal(scoreboardUpdates.length, 0);
  });

  it('partido ya finalizado con resultado → skipped, no overwrite', async () => {
    const partidoUpdates = [];
    const { supabaseAdmin, state } = createSyncMock({
      scoreboard: {
        id: 'sb-3',
        partido_torneo_id: 28,
        estado: 'terminado',
        sets_a: 2,
        sets_b: 1,
      },
      partido: {
        id: 28,
        estado: 'finalizado',
        resultado: { goles_a: 6, goles_b: 3 },
        equipo_a_id: 61,
        equipo_b_id: 62,
        ganador_equipo_id: 61,
      },
      onPartidoUpdate: () => partidoUpdates.push(1),
    });

    const result = await syncScoreboardToTorneoPartido(supabaseAdmin, 'sb-3');

    assert.equal(result.status, 'skipped');
    assert.equal(result.reason, 'partido_ya_finalizado');
    assert.equal(partidoUpdates.length, 0);
    assert.deepEqual(state.partido.resultado, { goles_a: 6, goles_b: 3 });
  });

  it('partido inexistente → failed', async () => {
    const scoreboardUpdates = [];
    const { supabaseAdmin } = createSyncMock({
      scoreboard: {
        id: 'sb-4',
        partido_torneo_id: 999,
        estado: 'terminado',
        sets_a: 2,
        sets_b: 0,
      },
      partido: null,
      onScoreboardUpdate: (patch) => scoreboardUpdates.push(patch),
    });

    const result = await syncScoreboardToTorneoPartido(supabaseAdmin, 'sb-4');

    assert.equal(result.status, 'failed');
    assert.equal(result.reason, 'partido_no_encontrado');
    assert.equal(scoreboardUpdates.at(-1)?.sync_torneo_status, 'failed');
  });

  it('resultado inválido sin ganador → failed', async () => {
    const scoreboardUpdates = [];
    const partidoUpdates = [];
    const { supabaseAdmin } = createSyncMock({
      scoreboard: {
        id: 'sb-bad',
        partido_torneo_id: 28,
        estado: 'terminado',
        sets_a: 1,
        sets_b: 1,
      },
      partido: {
        id: 28,
        estado: 'programado',
        resultado: null,
        equipo_a_id: 61,
        equipo_b_id: 62,
      },
      onScoreboardUpdate: (patch) => scoreboardUpdates.push(patch),
      onPartidoUpdate: () => partidoUpdates.push(1),
    });

    const result = await syncScoreboardToTorneoPartido(supabaseAdmin, 'sb-bad');

    assert.equal(result.status, 'failed');
    assert.equal(result.reason, 'resultado_invalido');
    assert.equal(partidoUpdates.length, 0);
    assert.equal(scoreboardUpdates.at(-1)?.sync_torneo_status, 'failed');
  });

  it('segunda llamada idempotente si ya está synced y coincide', async () => {
    const partidoUpdates = [];
    const scoreboardUpdates = [];
    const { supabaseAdmin, state } = createSyncMock({
      scoreboard: {
        id: 'sb-5',
        partido_torneo_id: 28,
        estado: 'terminado',
        sets_a: 2,
        sets_b: 0,
        sync_torneo_status: 'synced',
        synced_to_torneo_at: '2026-06-25T10:00:00.000Z',
      },
      partido: {
        id: 28,
        estado: 'finalizado',
        resultado: { goles_a: 2, goles_b: 0 },
        equipo_a_id: 61,
        equipo_b_id: 62,
        ganador_equipo_id: 61,
      },
      onPartidoUpdate: () => partidoUpdates.push(1),
      onScoreboardUpdate: patch => scoreboardUpdates.push(patch),
    });

    assert.equal(
      isAlreadySyncedMatch(
        { sync_torneo_status: 'synced' },
        {
          estado: 'finalizado',
          resultado: { goles_a: 2, goles_b: 0 },
          ganador_equipo_id: 61,
        },
        { goles_a: 2, goles_b: 0 },
        61,
      ),
      true,
    );

    const result = await syncScoreboardToTorneoPartido(supabaseAdmin, 'sb-5');

    assert.equal(result.status, 'synced');
    assert.equal(result.reason, 'ya_sincronizado');
    assert.equal(partidoUpdates.length, 0);
    assert.equal(scoreboardUpdates.length, 0);
    assert.equal(state.scoreboard.synced_to_torneo_at, '2026-06-25T10:00:00.000Z');
  });
});


describe('real Nations scoreboard to national result contract', () => {
  function fixture(history, sets = [2, 0]) {
    const calls = [];
    const mock = createSyncMock({
      scoreboard: { id: 'sb-nations', partido_torneo_id: 177, estado: 'terminado', sets_a: sets[0], sets_b: sets[1], historial_sets: history },
      partido: { id: 177, torneo_id: 37, estado: 'programado', resultado: null, equipo_a_id: 101, equipo_b_id: 89, torneo: { modalidad_plantel: 'selecciones', plan_nations: true } },
      onRpc: async (name, payload) => {
        calls.push({name, payload});
        return { data: { ok: true, status: 'finalized', partido_id: 177, torneo_id: 37, ganador_equipo_id: sets[0] > sets[1] ? 101 : 89 }, error: null };
      },
    });
    return {...mock, calls};
  }
  it('completed scoreboard with 6-0 / 6-0 retains games in national RPC', async () => {
    const history = [{set:1,a:6,b:0},{set:2,a:6,b:0}];
    const f = fixture(history);
    const result = await syncScoreboardToTorneoPartido(f.supabaseAdmin, 'sb-nations');
    assert.equal(result.status, 'synced');
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].name, 'finalizar_partido_seleccion');
    assert.deepEqual(f.calls[0].payload.p_resultado, {goles_a:2,goles_b:0,historial_sets:history});
    assert.equal(f.calls[0].payload.p_fuente, 'scoreboard');
    assert.equal(f.state.scoreboard.sync_torneo_status, 'synced');
  });
  it('three actual sets ending in B victory preserve the complete history', async () => {
    const history = [{set:1,a:6,b:4},{set:2,a:4,b:6},{set:3,a:3,b:6}];
    const f = fixture(history, [1,2]);
    const result = await syncScoreboardToTorneoPartido(f.supabaseAdmin, 'sb-nations');
    assert.equal(result.ganador_equipo_id,89);
    assert.deepEqual(f.calls[0].payload.p_resultado.historial_sets,history);
  });
  for (const [label, history] of [
    ['missing', undefined],
    ['incomplete', [{a:6,b:0}]],
    ['tied set', [{a:6,b:6},{a:6,b:0}]],
    ['mismatching winner', [{a:0,b:6},{a:0,b:6}]],
    ['extra set after victory', [{a:6,b:0},{a:6,b:0},{a:0,b:6}]],
  ]) it(label+' history cannot finalize Nations or invent games', async () => {
    const f = fixture(history);
    await assert.rejects(syncScoreboardToTorneoPartido(f.supabaseAdmin,'sb-nations'),error => error.code === 'NATIONS_SCORE_INCOMPLETE' || error.code === 'NATIONS_INVALID_INPUT');
    assert.equal(f.calls.length,0);
    assert.equal(f.state.partido.estado,'programado');
  });
});
