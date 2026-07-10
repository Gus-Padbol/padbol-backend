import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  MATCH_ATTENDANCE_STATUS,
  MATCH_PARTICIPANT_ROLES,
  MATCH_REWARD_EVENT_STATUS,
  MATCH_REWARD_TYPES,
} from '../src/matches/matchParticipantsConstants.js';
import {
  CASUAL_RANKING_RP,
  buildCasualMatchRankingSourceKey,
  buildParticipantSideMap,
  creditCasualMatchRanking,
  processCasualMatchRankingAfterResultConfirmed,
  processCasualMatchRankingAfterScoreboardFinished,
  resolveCasualMatchRankingResult,
  resolveParticipantRankingPoints,
} from '../src/ranking/casualMatchRankingService.js';

const PARTIDO_ID = 77;
const RESERVA_ID = 201;
const SCOREBOARD_ID = 'sb-rank-001';
const USER_W1 = 'aaaaaaaa-bbbb-cccc-dddd-111111111111';
const USER_W2 = 'aaaaaaaa-bbbb-cccc-dddd-222222222222';
const USER_L1 = 'aaaaaaaa-bbbb-cccc-dddd-333333333333';
const USER_L2 = 'aaaaaaaa-bbbb-cccc-dddd-444444444444';

function buildParticipantsStore(initial = []) {
  const rows = [...initial];
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
      order() { return this; },
      then(resolve, reject) {
        try {
          let matched = [...rows];
          const filters = this._filters;
          if (filters.match_type != null) {
            matched = matched.filter((r) => r.match_type === filters.match_type);
          }
          if (filters.match_id != null) {
            matched = matched.filter((r) => String(r.match_id) === String(filters.match_id));
          }
          resolve({ data: matched, error: null });
        } catch (err) {
          reject(err);
        }
      },
      maybeSingle: async function maybeSingle() {
        const filters = { ...this._filters };
        this._filters = {};
        const row = rows.find((r) =>
          Object.entries(filters).every(([k, v]) => String(r[k]) === String(v)),
        );
        return { data: row ?? null, error: null };
      },
      insert(payload) {
        const row = { ...payload, id: nextId++ };
        rows.push(row);
        return {
          select() { return this; },
          single: async () => ({ data: row, error: null }),
        };
      },
      update(payload) {
        const filters = this._filters;
        const row = rows.find((r) =>
          Object.entries(filters).every(([k, v]) => String(r[k]) === v),
        );
        if (row) Object.assign(row, payload);
        return {
          eq() { return this; },
          then(resolve) { resolve({ error: null }); },
        };
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
        const row = { ...payload, id: nextId++, metadata: payload.metadata ?? {} };
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

function buildRankingsLeaderboardStore() {
  const rows = [];
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
      upsert(payload) {
        const existing = rows.find(
          (r) => r.user_id === payload.user_id
            && r.deporte === payload.deporte
            && r.nivel === payload.nivel,
        );
        if (existing) {
          Object.assign(existing, payload);
        } else {
          rows.push({ ...payload, id: rows.length + 1 });
        }
        const saved = existing ?? rows[rows.length - 1];
        return {
          select() { return this; },
          single: async () => ({ data: saved, error: null }),
        };
      },
      insert(payload) {
        const existing = rows.find(
          (r) => r.user_id === payload.user_id
            && r.deporte === payload.deporte
            && r.nivel === payload.nivel,
        );
        if (existing) {
          return {
            select() { return this; },
            single: async () => ({
              data: null,
              error: { code: '23505', message: 'duplicate rankings_leaderboard' },
            }),
          };
        }
        rows.push({ ...payload, id: rows.length + 1 });
        const saved = rows[rows.length - 1];
        return {
          select() { return this; },
          single: async () => ({ data: saved, error: null }),
        };
      },
      update(payload) {
        const filters = {};
        const chain = {
          eq(field, value) {
            filters[field] = value;
            return chain;
          },
          select() { return chain; },
          single: async () => {
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

function createRankingMock({
  participants = [],
  partido = null,
  scoreboard = null,
  partidoJugadores = [],
} = {}) {
  const participantsStore = buildParticipantsStore(participants);
  const rewardStore = buildRewardEventsStore();
  const leaderboardStore = buildRankingsLeaderboardStore();

  const partidoRow = partido ?? {
    id: PARTIDO_ID,
    reserva_id: RESERVA_ID,
    capitan_user_id: USER_W1,
    estado: 'finalizado',
    ganador: 'equipo1',
    resultado: { equipo1: 2, equipo2: 1 },
    deporte: 'padbol',
    equipos_asignacion: {
      equipo1: [USER_W1, USER_W2],
      equipo2: [USER_L1, USER_L2],
    },
  };

  const scoreboardRow = scoreboard ?? {
    id: SCOREBOARD_ID,
    partido_abierto_id: PARTIDO_ID,
    reserva_id: RESERVA_ID,
    estado: 'terminado',
    sets_a: 2,
    sets_b: 0,
    equipo_a_jugadores: [{ user_id: USER_W1 }, { user_id: USER_W2 }],
    equipo_b_jugadores: [{ user_id: USER_L1 }, { user_id: USER_L2 }],
  };

  const supabaseAdmin = {
    from(table) {
      if (table === 'match_participants') return participantsStore.handler;
      if (table === 'match_reward_events') return rewardStore.handler;
      if (table === 'rankings_leaderboard') return leaderboardStore.handler;
      if (table === 'partidos_abiertos') {
        return {
          select() { return this; },
          eq() { return this; },
          maybeSingle: async () => ({ data: partidoRow, error: null }),
        };
      }
      if (table === 'partidos_abiertos_jugadores') {
        return {
          select() { return this; },
          eq() { return this; },
          order() { return this; },
          then(resolve) {
            resolve({ data: partidoJugadores, error: null });
          },
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  };

  return {
    supabaseAdmin,
    participantsStore,
    rewardStore,
    leaderboardStore,
    partidoRow,
    scoreboardRow,
  };
}

describe('casualMatchRanking — resolveCasualMatchRankingResult', () => {
  it('manual confirmado con ganador equipo1', () => {
    const result = resolveCasualMatchRankingResult({
      partido: {
        estado: 'finalizado',
        ganador: 'equipo1',
        resultado: { equipo1: 2, equipo2: 1 },
      },
    });
    assert.equal(result.ok, true);
    assert.equal(result.mode, 'manual');
    assert.equal(result.ganadorSide, 'equipo1');
    assert.equal(result.isDraw, false);
  });

  it('scoreboard terminado con ganador A', () => {
    const result = resolveCasualMatchRankingResult({
      scoreboard: { sets_a: 2, sets_b: 1, estado: 'terminado' },
    });
    assert.equal(result.ok, true);
    assert.equal(result.mode, 'scoreboard');
    assert.equal(result.ganadorSide, 'A');
  });

  it('sin resultado claro → skip', () => {
    const result = resolveCasualMatchRankingResult({
      partido: { estado: 'completo', ganador: null },
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'sin_resultado_claro');
  });

  it('torneo scoreboard → skip', () => {
    const result = resolveCasualMatchRankingResult({
      scoreboard: { partido_torneo_id: 99, sets_a: 2, sets_b: 0 },
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'torneo_out_of_scope');
  });
});

describe('casualMatchRanking — scoring +3/+1', () => {
  it('manual validado acredita +3 ganadores y +1 perdedores', async () => {
    const participants = [
      { user_id: USER_W1, team: null, role: MATCH_PARTICIPANT_ROLES.ORGANIZER, attendance_status: MATCH_ATTENDANCE_STATUS.ADMIN_VALIDATED },
      { user_id: USER_W2, team: null, role: MATCH_PARTICIPANT_ROLES.PARTICIPANT, attendance_status: MATCH_ATTENDANCE_STATUS.ADMIN_VALIDATED },
      { user_id: USER_L1, team: null, role: MATCH_PARTICIPANT_ROLES.PARTICIPANT, attendance_status: MATCH_ATTENDANCE_STATUS.ADMIN_VALIDATED },
      { user_id: USER_L2, team: null, role: MATCH_PARTICIPANT_ROLES.PARTICIPANT, attendance_status: MATCH_ATTENDANCE_STATUS.ADMIN_VALIDATED },
    ];

    const { supabaseAdmin, rewardStore, leaderboardStore } = createRankingMock({ participants });

    const result = await creditCasualMatchRanking(supabaseAdmin, {
      matchId: PARTIDO_ID,
      partido: {
        id: PARTIDO_ID,
        estado: 'finalizado',
        ganador: 'equipo1',
        resultado: { equipo1: 2, equipo2: 1 },
        deporte: 'padbol',
        equipos_asignacion: {
          equipo1: [USER_W1, USER_W2],
          equipo2: [USER_L1, USER_L2],
        },
      },
      reservaId: RESERVA_ID,
      participants,
    });

    assert.equal(result.acreditado, true);
    assert.equal(result.total_rp, 8);

    const rankingEvents = rewardStore.rows.filter((e) => e.reward_type === MATCH_REWARD_TYPES.RANKING);
    assert.equal(rankingEvents.length, 4);
    assert.equal(rankingEvents.filter((e) => e.amount === CASUAL_RANKING_RP.WIN).length, 2);
    assert.equal(rankingEvents.filter((e) => e.amount === CASUAL_RANKING_RP.LOSS).length, 2);

    const w1 = leaderboardStore.rows.find((r) => r.user_id === USER_W1);
    const l1 = leaderboardStore.rows.find((r) => r.user_id === USER_L1);
    assert.equal(w1.puntos, CASUAL_RANKING_RP.WIN);
    assert.equal(l1.puntos, CASUAL_RANKING_RP.LOSS);
  });

  it('Smart Score terminado acredita +3/+1 por team A/B', async () => {
    const participants = [
      { user_id: USER_W1, team: 'A', attendance_status: MATCH_ATTENDANCE_STATUS.ADMIN_VALIDATED },
      { user_id: USER_L1, team: 'B', attendance_status: MATCH_ATTENDANCE_STATUS.ADMIN_VALIDATED },
    ];

    const { supabaseAdmin, rewardStore } = createRankingMock({
      participants: participants.map((p) => ({
        ...p,
        match_type: 'casual',
        match_id: String(PARTIDO_ID),
      })),
    });

    const result = await processCasualMatchRankingAfterScoreboardFinished(supabaseAdmin, {
      scoreboard: {
        id: SCOREBOARD_ID,
        partido_abierto_id: PARTIDO_ID,
        sets_a: 2,
        sets_b: 1,
        estado: 'terminado',
      },
      partidoId: PARTIDO_ID,
      reservaId: RESERVA_ID,
    });

    assert.equal(result.acreditado, true);
    const rankingEvents = rewardStore.rows.filter((e) => e.reward_type === MATCH_REWARD_TYPES.RANKING);
    assert.equal(rankingEvents.length, 2);
    assert.equal(rankingEvents.find((e) => e.user_id === USER_W1).amount, CASUAL_RANKING_RP.WIN);
    assert.equal(rankingEvents.find((e) => e.user_id === USER_L1).amount, CASUAL_RANKING_RP.LOSS);
  });
});

describe('casualMatchRanking — idempotencia y skips', () => {
  it('segunda ejecución no duplica ranking events', async () => {
    const participants = [
      {
        user_id: USER_W1,
        team: 'A',
        match_type: 'casual',
        match_id: String(PARTIDO_ID),
        attendance_status: MATCH_ATTENDANCE_STATUS.ADMIN_VALIDATED,
      },
      {
        user_id: USER_L1,
        team: 'B',
        match_type: 'casual',
        match_id: String(PARTIDO_ID),
        attendance_status: MATCH_ATTENDANCE_STATUS.ADMIN_VALIDATED,
      },
    ];
    const { supabaseAdmin, rewardStore, leaderboardStore } = createRankingMock({ participants });

    const first = await creditCasualMatchRanking(supabaseAdmin, {
      matchId: PARTIDO_ID,
      scoreboard: { sets_a: 2, sets_b: 0, estado: 'terminado' },
    });
    const second = await creditCasualMatchRanking(supabaseAdmin, {
      matchId: PARTIDO_ID,
      scoreboard: { sets_a: 2, sets_b: 0, estado: 'terminado' },
    });

    assert.equal(first.acreditado, true);
    assert.equal(second.acreditado, false);
    assert.equal(rewardStore.rows.filter((e) => e.reward_type === MATCH_REWARD_TYPES.RANKING).length, 2);
    assert.equal(leaderboardStore.rows.find((r) => r.user_id === USER_W1).puntos, CASUAL_RANKING_RP.WIN);
  });

  it('participantes sin user_id no reciben ranking', async () => {
    const participants = [
      {
        user_id: USER_W1,
        team: 'A',
        match_type: 'casual',
        match_id: String(PARTIDO_ID),
        attendance_status: MATCH_ATTENDANCE_STATUS.ADMIN_VALIDATED,
      },
      {
        user_id: null,
        team: 'B',
        match_type: 'casual',
        match_id: String(PARTIDO_ID),
        attendance_status: MATCH_ATTENDANCE_STATUS.ADMIN_VALIDATED,
      },
      {
        user_id: USER_L1,
        match_type: 'casual',
        match_id: String(PARTIDO_ID),
        attendance_status: MATCH_ATTENDANCE_STATUS.PENDING,
      },
    ];

    const { supabaseAdmin, rewardStore } = createRankingMock({ participants });

    const result = await creditCasualMatchRanking(supabaseAdmin, {
      matchId: PARTIDO_ID,
      scoreboard: { sets_a: 2, sets_b: 0 },
    });

    assert.equal(result.acreditado, true);
    assert.equal(rewardStore.rows.length, 1);
    assert.equal(rewardStore.rows[0].user_id, USER_W1);
  });

  it('torneo scoreboard skip ranking', async () => {
    const { supabaseAdmin, rewardStore } = createRankingMock();

    const result = await processCasualMatchRankingAfterScoreboardFinished(supabaseAdmin, {
      scoreboard: { partido_torneo_id: 55, sets_a: 2, sets_b: 0 },
      partidoId: PARTIDO_ID,
    });

    assert.equal(result.skipped, true);
    assert.equal(rewardStore.rows.length, 0);
  });

  it('source_key ranking es estable', () => {
    const key = buildCasualMatchRankingSourceKey(PARTIDO_ID, USER_W1);
    assert.equal(key, `user|match|casual|${PARTIDO_ID}|ranking|${USER_W1}`);
  });
});

describe('casualMatchRanking — resolveParticipantRankingPoints', () => {
  it('empate manual +2 RP', () => {
    const rp = resolveParticipantRankingPoints({
      participant: { user_id: USER_W1 },
      userSideMap: new Map([[USER_W1, 'equipo1']]),
      mode: 'manual',
      ganadorSide: null,
      isDraw: true,
    });
    assert.equal(rp, CASUAL_RANKING_RP.DRAW);
  });

  it('sin lado determinado → null', () => {
    const rp = resolveParticipantRankingPoints({
      participant: { user_id: USER_W1, team: null },
      userSideMap: new Map(),
      mode: 'manual',
      ganadorSide: 'equipo1',
      isDraw: false,
    });
    assert.equal(rp, null);
  });
});

describe('casualMatchRanking — buildParticipantSideMap', () => {
  it('usa equipos_asignacion en manual', () => {
    const map = buildParticipantSideMap({
      mode: 'manual',
      partido: {
        equipos_asignacion: {
          equipo1: [USER_W1],
          equipo2: [USER_L1],
        },
      },
      participants: [],
    });
    assert.equal(map.get(USER_W1), 'equipo1');
    assert.equal(map.get(USER_L1), 'equipo2');
  });
});

describe('casualMatchRanking — integración PadCoins no duplica', () => {
  it('processCasualMatchRankingAfterResultConfirmed crea ranking sin romper PadCoins mock', async () => {
    const participants = [
      {
        id: 1,
        match_type: 'casual',
        match_id: String(PARTIDO_ID),
        user_id: USER_W1,
        role: MATCH_PARTICIPANT_ROLES.ORGANIZER,
        attendance_status: MATCH_ATTENDANCE_STATUS.ADMIN_VALIDATED,
      },
    ];

    const { supabaseAdmin, rewardStore } = createRankingMock({ participants });

    const ranking = await processCasualMatchRankingAfterResultConfirmed(supabaseAdmin, PARTIDO_ID, {
      partido: {
        id: PARTIDO_ID,
        estado: 'finalizado',
        ganador: 'equipo1',
        resultado: { equipo1: 2, equipo2: 1 },
        deporte: 'padbol',
        capitan_user_id: USER_W1,
        equipos_asignacion: { equipo1: [USER_W1], equipo2: [USER_L1] },
        reserva_id: RESERVA_ID,
      },
      reservaId: RESERVA_ID,
    });

    assert.equal(ranking.acreditado, true);
    const rankingEvents = rewardStore.rows.filter((e) => e.reward_type === MATCH_REWARD_TYPES.RANKING);
    assert.equal(rankingEvents.length, 1);
    assert.equal(rankingEvents[0].status, MATCH_REWARD_EVENT_STATUS.CREDITED);
    assert.equal(rewardStore.rows.filter((e) => e.reward_type === MATCH_REWARD_TYPES.PADCOINS).length, 0);
  });
});
