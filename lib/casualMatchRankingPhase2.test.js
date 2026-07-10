import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  MATCH_ATTENDANCE_STATUS,
  MATCH_PARTICIPANT_ROLES,
  MATCH_REWARD_EVENT_STATUS,
  MATCH_REWARD_TYPES,
  MATCH_TYPES,
} from '../src/matches/matchParticipantsConstants.js';
import {
  CASUAL_RANKING_RP,
  applyStatsDeltaToRow,
  buildCasualMatchRankingSourceKey,
  computeStatsDeltaForOutcome,
  creditCasualMatchRanking,
  processCasualMatchRankingAfterScoreboardFinished,
  updatePlayerRanking,
} from '../src/ranking/casualMatchRankingService.js';

const PARTIDO_ID = 88;
const RESERVA_ID = 301;
const USER_W = 'bbbbbbbb-cccc-dddd-eeee-111111111111';
const USER_L = 'bbbbbbbb-cccc-dddd-eeee-222222222222';

const DEFAULT_RANKING_STATS = {
  partidos_jugados: 0,
  ganados: 0,
  perdidos: 0,
  empatados: 0,
  racha_actual: 0,
  mejor_racha: 0,
};

function buildParticipantsStore(initial = []) {
  const rows = [...initial];
  return {
    rows,
    handler: {
      _filters: {},
      select() { return this; },
      eq(field, value) {
        this._filters[field] = value;
        return this;
      },
      order() { return this; },
      then(resolve) {
        let matched = [...rows];
        const filters = this._filters;
        if (filters.match_type != null) {
          matched = matched.filter((r) => r.match_type === filters.match_type);
        }
        if (filters.match_id != null) {
          matched = matched.filter((r) => String(r.match_id) === String(filters.match_id));
        }
        resolve({ data: matched, error: null });
      },
    },
  };
}

function buildRewardEventsStore() {
  const rows = [];
  let nextId = 1;
  return {
    rows,
    handler: {
      _filters: {},
      select() { return this; },
      eq(field, value) {
        this._filters[field] = value;
        return this;
      },
      maybeSingle: async function maybeSingle() {
        const filters = this._filters;
        this._filters = {};
        const row = rows.find((r) =>
          Object.entries(filters).every(([k, v]) => r[k] === v),
        );
        return { data: row ?? null, error: null };
      },
      insert(payload) {
        const existing = rows.find((r) => r.source_key === payload.source_key);
        if (existing) {
          return {
            select() { return this; },
            single: async () => ({
              data: null,
              error: { code: '23505', message: 'duplicate match_reward_events' },
            }),
          };
        }
        const row = {
          ...payload,
          id: nextId++,
          reward_type: payload.reward_type ?? MATCH_REWARD_TYPES.RANKING,
          metadata: payload.metadata ?? {},
        };
        rows.push(row);
        return {
          select() { return this; },
          single: async () => ({ data: row, error: null }),
        };
      },
      update(payload) {
        const filters = {};
        const chain = {
          eq(field, value) {
            filters[field] = value;
            return chain;
          },
          then(resolve) {
            const row = rows.find((r) =>
              Object.entries(filters).every(([k, v]) => r[k] === v),
            );
            if (row) Object.assign(row, payload);
            resolve({ error: null });
          },
        };
        return chain;
      },
    },
  };
}

function buildRankingsLeaderboardStore({ statsColumnsAvailable = true, failUpdates = false } = {}) {
  const rows = [];
  const statsSelectError = {
    code: '42703',
    message: 'column "partidos_jugados" does not exist',
  };
  const isStatsSelect = (cols) => String(cols ?? '').includes('partidos_jugados');

  return {
    rows,
    handler: {
      _filters: {},
      _selectCols: null,
      select(cols) {
        this._selectCols = cols;
        return this;
      },
      eq(field, value) {
        this._filters[field] = value;
        return this;
      },
      maybeSingle: async function maybeSingle() {
        if (!statsColumnsAvailable && isStatsSelect(this._selectCols)) {
          this._selectCols = null;
          this._filters = {};
          return { data: null, error: statsSelectError };
        }
        const filters = this._filters;
        this._filters = {};
        this._selectCols = null;
        const row = rows.find((r) =>
          Object.entries(filters).every(([k, v]) => r[k] === v),
        );
        return { data: row ?? null, error: null };
      },
      insert(payload) {
        if (failUpdates) {
          return {
            select() { return this; },
            maybeSingle: async () => ({ data: null, error: { message: 'forced_update_failure' } }),
          };
        }
        rows.push({ ...DEFAULT_RANKING_STATS, ...payload, id: rows.length + 1 });
        const saved = rows[rows.length - 1];
        let selectCols = null;
        return {
          select(cols) {
            selectCols = cols;
            return this;
          },
          maybeSingle: async () => {
            if (!statsColumnsAvailable && isStatsSelect(selectCols)) {
              return { data: null, error: statsSelectError };
            }
            return { data: saved, error: null };
          },
        };
      },
      update(payload) {
        const filters = {};
        let selectCols = null;
        const chain = {
          eq(field, value) {
            filters[field] = value;
            return chain;
          },
          select(cols) {
            selectCols = cols;
            return chain;
          },
          maybeSingle: async () => {
            if (failUpdates) {
              return { data: null, error: { message: 'forced_update_failure' } };
            }
            if (!statsColumnsAvailable && isStatsSelect(selectCols)) {
              const row = rows.find((r) =>
                Object.entries(filters).every(([k, v]) => r[k] === v),
              );
              if (row) {
                Object.assign(row, { puntos: payload.puntos, updated_at: payload.updated_at });
              }
              return { data: null, error: statsSelectError };
            }
            const row = rows.find((r) =>
              Object.entries(filters).every(([k, v]) => r[k] === v),
            );
            if (row) Object.assign(row, payload);
            return { data: row ?? null, error: null };
          },
        };
        return chain;
      },
    },
  };
}

function createPhase2Mock({
  participants = [],
  statsColumnsAvailable = true,
  failLeaderboardUpdates = false,
  preloadedEvents = [],
} = {}) {
  const participantsStore = buildParticipantsStore(participants);
  const rewardStore = buildRewardEventsStore();
  rewardStore.rows.push(...preloadedEvents);
  const leaderboardStore = buildRankingsLeaderboardStore({
    statsColumnsAvailable,
    failUpdates: failLeaderboardUpdates,
  });

  const supabaseAdmin = {
    from(table) {
      if (table === 'match_participants') return participantsStore.handler;
      if (table === 'match_reward_events') return rewardStore.handler;
      if (table === 'rankings_leaderboard') return leaderboardStore.handler;
      if (table === 'partidos_abiertos') {
        return {
          select() { return this; },
          eq() { return this; },
          maybeSingle: async () => ({ data: null, error: null }),
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  };

  return { supabaseAdmin, participantsStore, rewardStore, leaderboardStore };
}

function winnerLoserParticipants() {
  return [
    {
      user_id: USER_W,
      team: 'A',
      match_type: MATCH_TYPES.CASUAL,
      match_id: String(PARTIDO_ID),
      attendance_status: MATCH_ATTENDANCE_STATUS.ADMIN_VALIDATED,
    },
    {
      user_id: USER_L,
      team: 'B',
      match_type: MATCH_TYPES.CASUAL,
      match_id: String(PARTIDO_ID),
      attendance_status: MATCH_ATTENDANCE_STATUS.ADMIN_VALIDATED,
    },
  ];
}

function manualWinPartido() {
  return {
    id: PARTIDO_ID,
    estado: 'finalizado',
    ganador: 'equipo1',
    resultado: { equipo1: 2, equipo2: 1 },
    deporte: 'padbol',
    equipos_asignacion: { equipo1: [USER_W], equipo2: [USER_L] },
  };
}

describe('casualMatchRanking Fase 2 — stats delta helpers', () => {
  it('computeStatsDeltaForOutcome win/loss/draw', () => {
    assert.deepEqual(computeStatsDeltaForOutcome('win'), {
      partidos_jugados: 1, ganados: 1, perdidos: 0, empatados: 0, reset_racha: false,
    });
    assert.deepEqual(computeStatsDeltaForOutcome('loss'), {
      partidos_jugados: 1, ganados: 0, perdidos: 1, empatados: 0, reset_racha: true,
    });
    assert.deepEqual(computeStatsDeltaForOutcome('draw'), {
      partidos_jugados: 1, ganados: 0, perdidos: 0, empatados: 1, reset_racha: true,
    });
  });

  it('applyStatsDeltaToRow acumula rachas', () => {
    const afterWin = applyStatsDeltaToRow({ racha_actual: 1, mejor_racha: 1 }, 'win');
    assert.equal(afterWin.racha_actual, 2);
    assert.equal(afterWin.mejor_racha, 2);

    const afterLoss = applyStatsDeltaToRow(afterWin, 'loss');
    assert.equal(afterLoss.racha_actual, 0);
    assert.equal(afterLoss.mejor_racha, 2);
  });
});

describe('casualMatchRanking Fase 2 — victoria manual', () => {
  it('RP +3, PJ +1, G +1, racha +1', async () => {
    const participants = [
      {
        user_id: USER_W,
        role: MATCH_PARTICIPANT_ROLES.ORGANIZER,
        attendance_status: MATCH_ATTENDANCE_STATUS.ADMIN_VALIDATED,
      },
      {
        user_id: USER_L,
        attendance_status: MATCH_ATTENDANCE_STATUS.ADMIN_VALIDATED,
      },
    ];
    const { supabaseAdmin, leaderboardStore, rewardStore } = createPhase2Mock({ participants });

    const result = await creditCasualMatchRanking(supabaseAdmin, {
      matchId: PARTIDO_ID,
      partido: manualWinPartido(),
      participants,
      reservaId: RESERVA_ID,
    });

    assert.equal(result.acreditado, true);
    const winner = leaderboardStore.rows.find((r) => r.user_id === USER_W);
    assert.equal(winner.puntos, CASUAL_RANKING_RP.WIN);
    assert.equal(winner.partidos_jugados, 1);
    assert.equal(winner.ganados, 1);
    assert.equal(winner.racha_actual, 1);
    assert.equal(winner.mejor_racha, 1);

    const event = rewardStore.rows.find((e) => e.user_id === USER_W);
    assert.equal(event.status, MATCH_REWARD_EVENT_STATUS.CREDITED);
    assert.equal(event.metadata.stats_applied, true);
    assert.equal(event.metadata.partidos_jugados_after, 1);
  });
});

describe('casualMatchRanking Fase 2 — derrota manual', () => {
  it('RP +1, PJ +1, P +1, racha 0', async () => {
    const participants = winnerLoserParticipants();
    const { supabaseAdmin, leaderboardStore } = createPhase2Mock({ participants });

    await creditCasualMatchRanking(supabaseAdmin, {
      matchId: PARTIDO_ID,
      scoreboard: { sets_a: 2, sets_b: 0, estado: 'terminado' },
      participants,
    });

    const loser = leaderboardStore.rows.find((r) => r.user_id === USER_L);
    assert.equal(loser.puntos, CASUAL_RANKING_RP.LOSS);
    assert.equal(loser.partidos_jugados, 1);
    assert.equal(loser.perdidos, 1);
    assert.equal(loser.racha_actual, 0);
  });
});

describe('casualMatchRanking Fase 2 — empate manual', () => {
  it('RP +2, PJ +1, E +1, racha 0', async () => {
    const participants = [
      {
        user_id: USER_W,
        attendance_status: MATCH_ATTENDANCE_STATUS.ADMIN_VALIDATED,
      },
      {
        user_id: USER_L,
        attendance_status: MATCH_ATTENDANCE_STATUS.ADMIN_VALIDATED,
      },
    ];
    const { supabaseAdmin, leaderboardStore } = createPhase2Mock({ participants });

    await creditCasualMatchRanking(supabaseAdmin, {
      matchId: PARTIDO_ID,
      partido: {
        id: PARTIDO_ID,
        estado: 'finalizado',
        ganador: 'equipo1',
        resultado: { equipo1: 2, equipo2: 2 },
        deporte: 'padbol',
        equipos_asignacion: { equipo1: [USER_W], equipo2: [USER_L] },
      },
      participants,
    });

    const row = leaderboardStore.rows.find((r) => r.user_id === USER_W);
    assert.equal(row.puntos, CASUAL_RANKING_RP.DRAW);
    assert.equal(row.partidos_jugados, 1);
    assert.equal(row.empatados, 1);
    assert.equal(row.racha_actual, 0);
  });
});

describe('casualMatchRanking Fase 2 — rachas consecutivas', () => {
  it('dos victorias → racha_actual 2 y mejor_racha 2', async () => {
    const participants = [
      {
        user_id: USER_W,
        team: 'A',
        match_type: MATCH_TYPES.CASUAL,
        match_id: '99',
        attendance_status: MATCH_ATTENDANCE_STATUS.ADMIN_VALIDATED,
      },
    ];
    const { supabaseAdmin, leaderboardStore } = createPhase2Mock({ participants });

    await creditCasualMatchRanking(supabaseAdmin, {
      matchId: 99,
      scoreboard: { sets_a: 2, sets_b: 0 },
      participants: participants.map((p) => ({ ...p, match_id: '99' })),
    });
    await creditCasualMatchRanking(supabaseAdmin, {
      matchId: 100,
      scoreboard: { sets_a: 2, sets_b: 1 },
      participants: participants.map((p) => ({ ...p, match_id: '100' })),
    });

    const row = leaderboardStore.rows.find((r) => r.user_id === USER_W);
    assert.equal(row.racha_actual, 2);
    assert.equal(row.mejor_racha, 2);
    assert.equal(row.ganados, 2);
  });

  it('victoria seguida de derrota conserva mejor_racha', async () => {
    const participants = winnerLoserParticipants();
    const { supabaseAdmin, leaderboardStore } = createPhase2Mock({ participants });

    await creditCasualMatchRanking(supabaseAdmin, {
      matchId: 101,
      scoreboard: { sets_a: 2, sets_b: 0 },
      participants,
    });
    await creditCasualMatchRanking(supabaseAdmin, {
      matchId: 102,
      scoreboard: { sets_a: 0, sets_b: 2 },
      participants,
    });

    const winnerRow = leaderboardStore.rows.find((r) => r.user_id === USER_W);
    assert.equal(winnerRow.racha_actual, 0);
    assert.equal(winnerRow.mejor_racha, 1);
    assert.equal(winnerRow.ganados, 1);
    assert.equal(winnerRow.perdidos, 1);
  });
});

describe('casualMatchRanking Fase 2 — idempotencia', () => {
  it('segunda ejecución no duplica RP ni stats', async () => {
    const participants = winnerLoserParticipants();
    const { supabaseAdmin, leaderboardStore, rewardStore } = createPhase2Mock({ participants });

    await creditCasualMatchRanking(supabaseAdmin, {
      matchId: PARTIDO_ID,
      scoreboard: { sets_a: 2, sets_b: 0 },
      participants,
    });
    await creditCasualMatchRanking(supabaseAdmin, {
      matchId: PARTIDO_ID,
      scoreboard: { sets_a: 2, sets_b: 0 },
      participants,
    });

    const row = leaderboardStore.rows.find((r) => r.user_id === USER_W);
    assert.equal(row.puntos, CASUAL_RANKING_RP.WIN);
    assert.equal(row.partidos_jugados, 1);
    assert.equal(rewardStore.rows.filter((e) => e.user_id === USER_W).length, 1);
  });

  it('manual y Smart Score del mismo partido no duplican', async () => {
    const participants = winnerLoserParticipants();
    const { supabaseAdmin, leaderboardStore, rewardStore } = createPhase2Mock({ participants });

    await creditCasualMatchRanking(supabaseAdmin, {
      matchId: PARTIDO_ID,
      partido: manualWinPartido(),
      participants,
    });
    await processCasualMatchRankingAfterScoreboardFinished(supabaseAdmin, {
      scoreboard: { partido_abierto_id: PARTIDO_ID, sets_a: 2, sets_b: 0, estado: 'terminado' },
      partidoId: PARTIDO_ID,
    });

    const row = leaderboardStore.rows.find((r) => r.user_id === USER_W);
    assert.equal(row.puntos, CASUAL_RANKING_RP.WIN);
    assert.equal(row.partidos_jugados, 1);
    assert.equal(rewardStore.rows.filter((e) => e.reward_type === MATCH_REWARD_TYPES.RANKING).length, 2);
  });
});

describe('casualMatchRanking Fase 2 — skips', () => {
  it('torneo skip completo', async () => {
    const { supabaseAdmin, rewardStore } = createPhase2Mock();
    const result = await processCasualMatchRankingAfterScoreboardFinished(supabaseAdmin, {
      scoreboard: { partido_torneo_id: 12, sets_a: 2, sets_b: 0 },
      partidoId: PARTIDO_ID,
    });
    assert.equal(result.skipped, true);
    assert.equal(rewardStore.rows.length, 0);
  });

  it('participante sin user_id skip completo', async () => {
    const participants = [
      { user_id: USER_W, team: 'A', attendance_status: MATCH_ATTENDANCE_STATUS.ADMIN_VALIDATED },
      { user_id: null, team: 'B', attendance_status: MATCH_ATTENDANCE_STATUS.ADMIN_VALIDATED },
    ];
    const { supabaseAdmin, rewardStore } = createPhase2Mock({ participants });

    await creditCasualMatchRanking(supabaseAdmin, {
      matchId: PARTIDO_ID,
      scoreboard: { sets_a: 2, sets_b: 0 },
      participants,
    });

    assert.equal(rewardStore.rows.length, 1);
    assert.equal(rewardStore.rows[0].user_id, USER_W);
  });
});

describe('casualMatchRanking Fase 2 — compatibilidad pre-SQL', () => {
  it('RP Fase 1 continúa y stats se omiten sin romper', async () => {
    const participants = winnerLoserParticipants();
    const { supabaseAdmin, leaderboardStore, rewardStore } = createPhase2Mock({
      participants,
      statsColumnsAvailable: false,
    });

    const result = await creditCasualMatchRanking(supabaseAdmin, {
      matchId: PARTIDO_ID,
      scoreboard: { sets_a: 2, sets_b: 0 },
      participants,
    });

    assert.equal(result.acreditado, true);
    const row = leaderboardStore.rows.find((r) => r.user_id === USER_W);
    assert.equal(row.puntos, CASUAL_RANKING_RP.WIN);
    assert.equal(row.partidos_jugados, 0);

    const event = rewardStore.rows.find((e) => e.user_id === USER_W);
    assert.equal(event.status, MATCH_REWARD_EVENT_STATUS.CREDITED);
    assert.equal(event.metadata.stats_applied, false);
    assert.equal(event.metadata.stats_omitted_reason, 'stats_columns_missing');
  });
});

describe('casualMatchRanking Fase 2 — pending recovery', () => {
  it('evento pending previo se recupera y termina credited sin duplicar', async () => {
    const participants = winnerLoserParticipants();
    const sourceKey = buildCasualMatchRankingSourceKey(PARTIDO_ID, USER_W);
    const { supabaseAdmin, rewardStore, leaderboardStore } = createPhase2Mock({
      participants,
      preloadedEvents: [{
        id: 9001,
        match_type: MATCH_TYPES.CASUAL,
        match_id: String(PARTIDO_ID),
        user_id: USER_W,
        reward_type: MATCH_REWARD_TYPES.RANKING,
        amount: CASUAL_RANKING_RP.WIN,
        status: MATCH_REWARD_EVENT_STATUS.PENDING,
        source_key: sourceKey,
        metadata: { outcome: 'win', rp: CASUAL_RANKING_RP.WIN },
      }],
    });

    const result = await creditCasualMatchRanking(supabaseAdmin, {
      matchId: PARTIDO_ID,
      scoreboard: { sets_a: 2, sets_b: 0 },
      participants,
    });

    assert.equal(result.acreditado, true);
    assert.equal(rewardStore.rows.filter((e) => e.source_key === sourceKey).length, 1);
    const event = rewardStore.rows.find((e) => e.source_key === sourceKey);
    assert.equal(event.status, MATCH_REWARD_EVENT_STATUS.CREDITED);
    assert.equal(event.metadata.stats_applied, true);
    assert.equal(leaderboardStore.rows.find((r) => r.user_id === USER_W).puntos, CASUAL_RANKING_RP.WIN);
  });

  it('fallo de ranking deja pending para reintento', async () => {
    const participants = winnerLoserParticipants();
    const sourceKey = buildCasualMatchRankingSourceKey(PARTIDO_ID, USER_W);
    const { supabaseAdmin, rewardStore } = createPhase2Mock({
      participants,
      failLeaderboardUpdates: true,
    });

    const result = await creditCasualMatchRanking(supabaseAdmin, {
      matchId: PARTIDO_ID,
      scoreboard: { sets_a: 2, sets_b: 0 },
      participants,
    });

    const credit = result.credits.find((c) => c.userId === USER_W);
    assert.equal(credit.acreditado, false);
    const event = rewardStore.rows.find((e) => e.source_key === sourceKey);
    assert.equal(event.status, MATCH_REWARD_EVENT_STATUS.PENDING);
  });
});

describe('casualMatchRanking Fase 2 — updatePlayerRanking unit', () => {
  it('persiste puntos y stats en una sola escritura', async () => {
    const leaderboardStore = buildRankingsLeaderboardStore();
    const supabaseAdmin = {
      from(table) {
        if (table === 'rankings_leaderboard') return leaderboardStore.handler;
        throw new Error(`unexpected ${table}`);
      },
    };

    const first = await updatePlayerRanking(supabaseAdmin, {
      userId: USER_W,
      rpDelta: 3,
      outcome: 'win',
    });
    assert.equal(first.ok, true);
    assert.equal(first.stats_applied, true);
    assert.equal(first.partidos_jugados_after, 1);

    const second = await updatePlayerRanking(supabaseAdmin, {
      userId: USER_W,
      rpDelta: 1,
      outcome: 'loss',
    });
    assert.equal(second.racha_actual_after, 0);
    assert.equal(second.mejor_racha_after, 1);
  });
});
