import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  logBracketAdvanceResult,
  maybeSyncTorneoAfterScoreboardTerminated,
} from '../routes/scoreboard.js';

const SCOREBOARD_TERMINADO = {
  id: 'sb-hook-1',
  partido_torneo_id: 44,
  estado: 'terminado',
};

describe('logBracketAdvanceResult', () => {
  it('no lanza para status skipped', () => {
    assert.doesNotThrow(() => {
      logBracketAdvanceResult('sb-1', 44, { status: 'skipped', reason: 'no_destino' });
    });
  });
});

describe('maybeSyncTorneoAfterScoreboardTerminated bracket hook', () => {
  it('llama advanceWinnerIfNeeded cuando sync queda synced', async () => {
    let advanceCalled = false;
    let advancePartidoId = null;

    await maybeSyncTorneoAfterScoreboardTerminated(
      {},
      SCOREBOARD_TERMINADO,
      'en_curso',
      {
        syncScoreboardToTorneoPartido: async () => ({ status: 'synced' }),
        advanceWinnerIfNeeded: async (_admin, { partidoId }) => {
          advanceCalled = true;
          advancePartidoId = partidoId;
          return { status: 'advanced', reason: 'ganador_avanzado', partido_id: partidoId };
        },
      },
    );

    assert.equal(advanceCalled, true);
    assert.equal(advancePartidoId, 44);
  });

  it('no llama advanceWinnerIfNeeded cuando sync no queda synced', async () => {
    let advanceCalled = false;

    await maybeSyncTorneoAfterScoreboardTerminated(
      {},
      SCOREBOARD_TERMINADO,
      'en_curso',
      {
        syncScoreboardToTorneoPartido: async () => ({ status: 'failed', reason: 'partido_not_found' }),
        advanceWinnerIfNeeded: async () => {
          advanceCalled = true;
          return { status: 'advanced', reason: 'ganador_avanzado', partido_id: 44 };
        },
      },
    );

    assert.equal(advanceCalled, false);
  });

  it('no llama advanceWinnerIfNeeded cuando sync queda skipped', async () => {
    let advanceCalled = false;

    await maybeSyncTorneoAfterScoreboardTerminated(
      {},
      SCOREBOARD_TERMINADO,
      'en_curso',
      {
        syncScoreboardToTorneoPartido: async () => ({ status: 'skipped', reason: 'already_synced' }),
        advanceWinnerIfNeeded: async () => {
          advanceCalled = true;
          return { status: 'advanced', reason: 'ganador_avanzado', partido_id: 44 };
        },
      },
    );

    assert.equal(advanceCalled, false);
  });

  it('conflict en advanceWinnerIfNeeded no rompe el hook', async () => {
    await assert.doesNotReject(async () => {
      await maybeSyncTorneoAfterScoreboardTerminated(
        {},
        SCOREBOARD_TERMINADO,
        'en_curso',
        {
          syncScoreboardToTorneoPartido: async () => ({ status: 'synced' }),
          advanceWinnerIfNeeded: async () => ({
            status: 'conflict',
            reason: 'slot_ocupado',
            partido_id: 44,
          }),
        },
      );
    });
  });

  it('error inesperado en advanceWinnerIfNeeded se captura y no rompe el hook', async () => {
    await assert.doesNotReject(async () => {
      await maybeSyncTorneoAfterScoreboardTerminated(
        {},
        SCOREBOARD_TERMINADO,
        'en_curso',
        {
          syncScoreboardToTorneoPartido: async () => ({ status: 'synced' }),
          advanceWinnerIfNeeded: async () => {
            throw new Error('db down');
          },
        },
      );
    });
  });

  it('legacy sin destino queda skipped sin romper el hook', async () => {
    let advanceResult = null;

    await assert.doesNotReject(async () => {
      await maybeSyncTorneoAfterScoreboardTerminated(
        {},
        SCOREBOARD_TERMINADO,
        'en_curso',
        {
          syncScoreboardToTorneoPartido: async () => ({ status: 'synced' }),
          advanceWinnerIfNeeded: async () => {
            advanceResult = {
              status: 'skipped',
              reason: 'no_destino',
              partido_id: 44,
            };
            return advanceResult;
          },
        },
      );
    });

    assert.deepEqual(advanceResult, {
      status: 'skipped',
      reason: 'no_destino',
      partido_id: 44,
    });
  });

  it('no intenta sync si el scoreboard ya estaba terminado antes', async () => {
    let syncCalled = false;

    await maybeSyncTorneoAfterScoreboardTerminated(
      {},
      SCOREBOARD_TERMINADO,
      'terminado',
      {
        syncScoreboardToTorneoPartido: async () => {
          syncCalled = true;
          return { status: 'synced' };
        },
        advanceWinnerIfNeeded: async () => ({ status: 'skipped', reason: 'no_destino', partido_id: 44 }),
      },
    );

    assert.equal(syncCalled, false);
  });
});

describe('maybeSyncTorneoAfterScoreboardTerminated bracket scoreboard hook', () => {
  const advancedWithDestino = {
    syncScoreboardToTorneoPartido: async () => ({ status: 'synced' }),
    advanceWinnerIfNeeded: async () => ({
      status: 'advanced',
      reason: 'ganador_avanzado',
      partido_id: 44,
      destino_partido_id: 47,
    }),
  };

  it('llama ensureScoreboard solo cuando advance queda advanced con destino', async () => {
    let ensureCalled = false;
    let ensurePartidoId = null;

    await maybeSyncTorneoAfterScoreboardTerminated(
      {},
      SCOREBOARD_TERMINADO,
      'en_curso',
      {
        ...advancedWithDestino,
        ensureScoreboardForCompletedBracketPartido: async (_admin, { partidoId }) => {
          ensureCalled = true;
          ensurePartidoId = partidoId;
          return { status: 'created', reason: 'scoreboard_creado', partido_id: partidoId };
        },
      },
    );

    assert.equal(ensureCalled, true);
    assert.equal(ensurePartidoId, 47);
  });

  it('no llama ensureScoreboard si advance es skipped', async () => {
    let ensureCalled = false;

    await maybeSyncTorneoAfterScoreboardTerminated(
      {},
      SCOREBOARD_TERMINADO,
      'en_curso',
      {
        syncScoreboardToTorneoPartido: async () => ({ status: 'synced' }),
        advanceWinnerIfNeeded: async () => ({ status: 'skipped', reason: 'no_destino', partido_id: 44 }),
        ensureScoreboardForCompletedBracketPartido: async () => {
          ensureCalled = true;
          return { status: 'created', reason: 'scoreboard_creado', partido_id: 47 };
        },
      },
    );

    assert.equal(ensureCalled, false);
  });

  it('no llama ensureScoreboard si advance es conflict', async () => {
    let ensureCalled = false;

    await maybeSyncTorneoAfterScoreboardTerminated(
      {},
      SCOREBOARD_TERMINADO,
      'en_curso',
      {
        syncScoreboardToTorneoPartido: async () => ({ status: 'synced' }),
        advanceWinnerIfNeeded: async () => ({ status: 'conflict', reason: 'slot_ocupado', partido_id: 44 }),
        ensureScoreboardForCompletedBracketPartido: async () => {
          ensureCalled = true;
          return { status: 'created', reason: 'scoreboard_creado', partido_id: 47 };
        },
      },
    );

    assert.equal(ensureCalled, false);
  });

  it('no llama ensureScoreboard si advance es advanced pero sin destino_partido_id', async () => {
    let ensureCalled = false;

    await maybeSyncTorneoAfterScoreboardTerminated(
      {},
      SCOREBOARD_TERMINADO,
      'en_curso',
      {
        syncScoreboardToTorneoPartido: async () => ({ status: 'synced' }),
        advanceWinnerIfNeeded: async () => ({
          status: 'advanced',
          reason: 'ganador_avanzado',
          partido_id: 44,
        }),
        ensureScoreboardForCompletedBracketPartido: async () => {
          ensureCalled = true;
          return { status: 'created', reason: 'scoreboard_creado', partido_id: 47 };
        },
      },
    );

    assert.equal(ensureCalled, false);
  });

  it('error inesperado en ensureScoreboard se captura y no rompe el hook', async () => {
    await assert.doesNotReject(async () => {
      await maybeSyncTorneoAfterScoreboardTerminated(
        {},
        SCOREBOARD_TERMINADO,
        'en_curso',
        {
          ...advancedWithDestino,
          ensureScoreboardForCompletedBracketPartido: async () => {
            throw new Error('scoreboard db down');
          },
        },
      );
    });
  });

  it('status skipped/failed de ensureScoreboard no rompe el marcador', async () => {
    await assert.doesNotReject(async () => {
      await maybeSyncTorneoAfterScoreboardTerminated(
        {},
        SCOREBOARD_TERMINADO,
        'en_curso',
        {
          ...advancedWithDestino,
          ensureScoreboardForCompletedBracketPartido: async () => ({
            status: 'failed',
            reason: 'scoreboard_insert_failed',
            partido_id: 47,
          }),
        },
      );
    });
  });
});
