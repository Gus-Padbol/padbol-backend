import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { onPartidoTorneoFinalizado } from './torneos/partidoTorneoFinalizadoEffectsService.js';

describe('onPartidoTorneoFinalizado', () => {
  it('ejecuta advanceWinnerIfNeeded con el partido indicado', async () => {
    let advancePartidoId = null;

    const result = await onPartidoTorneoFinalizado(
      {},
      { partidoId: 45, fuente: 'scoreboard' },
      {
        advanceWinnerIfNeeded: async (_admin, { partidoId }) => {
          advancePartidoId = partidoId;
          return {
            status: 'advanced',
            reason: 'ganador_avanzado',
            partido_id: partidoId,
            destino_partido_id: 47,
          };
        },
        ensureScoreboardForCompletedBracketPartido: async () => ({
          status: 'skipped',
          reason: 'scoreboard_existente',
          partido_id: 47,
        }),
      },
    );

    assert.equal(advancePartidoId, 45);
    assert.equal(result.ok, true);
    assert.equal(result.partido_id, 45);
    assert.equal(result.fuente, 'scoreboard');
    assert.equal(result.advance.status, 'advanced');
  });

  it('asegura scoreboard siguiente cuando advance queda advanced con destino', async () => {
    let ensurePartidoId = null;

    const result = await onPartidoTorneoFinalizado(
      {},
      { partidoId: 45, torneoId: 28, fuente: 'scoreboard' },
      {
        advanceWinnerIfNeeded: async () => ({
          status: 'advanced',
          reason: 'ganador_avanzado',
          partido_id: 45,
          destino_partido_id: 47,
        }),
        ensureScoreboardForCompletedBracketPartido: async (_admin, { partidoId }) => {
          ensurePartidoId = partidoId;
          return {
            status: 'created',
            reason: 'scoreboard_creado',
            partido_id: partidoId,
            scoreboard_id: 'sb-next',
          };
        },
      },
    );

    assert.equal(ensurePartidoId, 47);
    assert.equal(result.scoreboard.status, 'created');
    assert.equal(result.scoreboard.scoreboard_id, 'sb-next');
    assert.equal(result.torneo_id, 28);
  });

  it('fase grupos no avanza llave y no crea scoreboard siguiente', async () => {
    let ensureCalled = false;

    const result = await onPartidoTorneoFinalizado(
      {},
      { partidoId: 48, fuente: 'scoreboard' },
      {
        advanceWinnerIfNeeded: async () => ({
          status: 'skipped',
          reason: 'fase_grupos',
          partido_id: 48,
        }),
        ensureScoreboardForCompletedBracketPartido: async () => {
          ensureCalled = true;
          return { status: 'created', reason: 'scoreboard_creado', partido_id: 99 };
        },
      },
    );

    assert.equal(result.ok, true);
    assert.equal(result.advance.status, 'skipped');
    assert.equal(result.advance.reason, 'fase_grupos');
    assert.equal(result.scoreboard, null);
    assert.equal(ensureCalled, false);
  });

  it('no rompe si el partido no tiene destino de llave', async () => {
    let ensureCalled = false;

    const result = await onPartidoTorneoFinalizado(
      {},
      { partidoId: 47, fuente: 'scoreboard' },
      {
        advanceWinnerIfNeeded: async () => ({
          status: 'skipped',
          reason: 'no_destino',
          partido_id: 47,
        }),
        ensureScoreboardForCompletedBracketPartido: async () => {
          ensureCalled = true;
          return { status: 'created', reason: 'scoreboard_creado', partido_id: 99 };
        },
      },
    );

    assert.equal(result.ok, true);
    assert.deepEqual(result.advance, {
      status: 'skipped',
      reason: 'no_destino',
      partido_id: 47,
    });
    assert.equal(result.scoreboard, null);
    assert.equal(ensureCalled, false);
  });

  it('acepta fuente manual_admin sin endpoint', async () => {
    const result = await onPartidoTorneoFinalizado(
      {},
      {
        partidoId: 45,
        fuente: 'manual_admin',
        resultado: { goles_a: 2, goles_b: 0 },
      },
      {
        advanceWinnerIfNeeded: async () => ({
          status: 'skipped',
          reason: 'no_destino',
          partido_id: 45,
        }),
      },
    );

    assert.equal(result.fuente, 'manual_admin');
    assert.deepEqual(result.resultado, { goles_a: 2, goles_b: 0 });
  });

  it('captura error de advanceWinnerIfNeeded sin lanzar', async () => {
    const result = await onPartidoTorneoFinalizado(
      {},
      { partidoId: 45, fuente: 'scoreboard' },
      {
        advanceWinnerIfNeeded: async () => {
          throw new Error('db down');
        },
      },
    );

    assert.equal(result.ok, false);
    assert.equal(result.advance.status, 'failed');
    assert.equal(result.advance.reason, 'exception');
    assert.equal(result.advance.error, 'db down');
    assert.equal(result.scoreboard, null);
  });

  it('captura error de ensureScoreboard sin lanzar', async () => {
    const result = await onPartidoTorneoFinalizado(
      {},
      { partidoId: 45, fuente: 'scoreboard' },
      {
        advanceWinnerIfNeeded: async () => ({
          status: 'advanced',
          reason: 'ganador_avanzado',
          partido_id: 45,
          destino_partido_id: 47,
        }),
        ensureScoreboardForCompletedBracketPartido: async () => {
          throw new Error('scoreboard db down');
        },
      },
    );

    assert.equal(result.ok, false);
    assert.equal(result.advance.status, 'advanced');
    assert.equal(result.scoreboard.status, 'failed');
    assert.equal(result.scoreboard.reason, 'exception');
    assert.equal(result.scoreboard.error, 'scoreboard db down');
  });

  it('rechaza partidoId inválido', async () => {
    const result = await onPartidoTorneoFinalizado(
      {},
      { partidoId: 'invalid', fuente: 'scoreboard' },
    );

    assert.equal(result.ok, false);
    assert.equal(result.advance.reason, 'partido_id_invalido');
  });
});
