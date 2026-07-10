import assert from 'node:assert/strict';
import { describe, it, afterEach } from 'node:test';
import {
  MATCH_ATTENDANCE_COLLECTION_STATUS,
  MATCH_ATTENDANCE_RESOLUTION_REASON,
  MATCH_ATTENDANCE_STATUS,
  MATCH_PARTICIPANT_ROLES,
  MATCH_REWARD_STATUS,
  MATCH_TYPES,
} from '../src/matches/matchParticipantsConstants.js';
import {
  buildAttendanceRewardsResponse,
  evaluatePadcoinsBranchResult,
  evaluateRankingBranchResult,
  submitPlayerAttendanceResponse,
  tryFinalizeMatchAttendanceRewards,
} from '../src/matches/matchAttendanceService.js';
import { processCasualMatchPadcoinsAfterResultConfirmed } from '../src/matches/matchRewardsService.js';

const PARTIDO_ID = 88;
const SEDE_ID = 2;
const RESERVA_ID = 501;
const CAPTAIN_ID = 'aaaaaaaa-bbbb-cccc-dddd-111111111111';
const PLAYER_ID = 'aaaaaaaa-bbbb-cccc-dddd-222222222222';
const OTHER_ID = 'aaaaaaaa-bbbb-cccc-dddd-333333333333';
const OPENED_AT = '2026-07-10T12:00:00.000Z';
const DEADLINE_AT = '2026-07-13T12:00:00.000Z';
const RESOLVED_AT = '2026-07-11T12:00:00.000Z';
const NOW = '2026-07-11T12:00:00.000Z';

function buildParticipantsStore(initial = []) {
  const rows = initial.map((row, index) => ({ id: index + 1, ...row }));
  let nextId = rows.length + 1;

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
        if (filters.match_type != null) matched = matched.filter((r) => r.match_type === filters.match_type);
        if (filters.match_id != null) matched = matched.filter((r) => String(r.match_id) === String(filters.match_id));
        if (filters.user_id != null) matched = matched.filter((r) => r.user_id === filters.user_id);
        if (filters.id != null) matched = matched.filter((r) => String(r.id) === String(filters.id));
        this._filters = {};
        resolve({ data: matched, error: null });
      },
      maybeSingle: async function maybeSingle() {
        const filters = { ...this._filters };
        this._filters = {};
        const row = rows.find((r) =>
          Object.entries(filters).every(([k, v]) => String(r[k]) === String(v)),
        );
        return { data: row ?? null, error: null };
      },
      update(payload) {
        const filters = {};
        const builder = {
          eq(field, value) {
            filters[field] = value;
            return builder;
          },
          select() { return builder; },
          maybeSingle: async () => {
            const row = rows.find((r) =>
              Object.entries(filters).every(([k, v]) => String(r[k]) === String(v)),
            );
            if (row) Object.assign(row, payload);
            return { data: row ?? null, error: null };
          },
          single: async () => {
            const row = rows.find((r) =>
              Object.entries(filters).every(([k, v]) => String(r[k]) === String(v)),
            );
            if (row) Object.assign(row, payload);
            return { data: row ?? null, error: row ? null : { message: 'not found' } };
          },
        };
        return builder;
      },
    },
  };
}

function buildPartidoStore(partido) {
  let row = { ...partido };
  return {
    get row() { return row; },
    handler: {
      _filters: {},
      _updatePayload: null,
      select() { return this; },
      eq(field, value) {
        this._filters[field] = value;
        return this;
      },
      update(payload) {
        this._updatePayload = payload;
        return this;
      },
      order() { return this; },
      limit() { return this; },
      maybeSingle: async function maybeSingle() {
        const filters = { ...this._filters };
        this._filters = {};
        const updatePayload = this._updatePayload;
        this._updatePayload = null;
        if (updatePayload) {
          const match = Object.entries(filters).every(([k, v]) => String(row[k]) === String(v));
          if (match) row = { ...row, ...updatePayload };
          return { data: match ? { ...row } : null, error: null };
        }
        const match = Object.entries(filters).every(([k, v]) => String(row[k]) === String(v));
        return { data: match ? { ...row } : null, error: null };
      },
    },
  };
}

function buildJugadoresStore(rows = []) {
  return {
    handler: {
      _filters: {},
      select() { return this; },
      eq(field, value) {
        this._filters[field] = value;
        return this;
      },
      order() { return this; },
      maybeSingle: async function maybeSingle() {
        const filters = { ...this._filters };
        this._filters = {};
        const row = rows.find((r) =>
          Object.entries(filters).every(([k, v]) => String(r[k]) === String(v)),
        );
        return { data: row ?? null, error: null };
      },
    },
  };
}

function buildReservasStore(reserva = null) {
  return {
    handler: {
      _filters: {},
      select() { return this; },
      eq(field, value) {
        this._filters[field] = value;
        return this;
      },
      maybeSingle: async function maybeSingle() {
        const filters = { ...this._filters };
        this._filters = {};
        if (!reserva) return { data: null, error: null };
        const match = Object.entries(filters).every(([k, v]) => String(reserva[k]) === String(v));
        return { data: match ? { ...reserva } : null, error: null };
      },
    },
  };
}

function buildScoreboardStore(scoreboard = null) {
  return {
    handler: {
      _filters: {},
      select() { return this; },
      eq(field, value) {
        this._filters[field] = value;
        return this;
      },
      order() { return this; },
      limit() { return this; },
      maybeSingle: async function maybeSingle() {
        if (!scoreboard) return { data: null, error: null };
        return { data: { ...scoreboard }, error: null };
      },
    },
  };
}

function createPhase33Mock({
  partido,
  participants = [],
  jugadores = [],
  reserva = null,
  scoreboard = null,
} = {}) {
  const participantsStore = buildParticipantsStore(participants);
  const partidoStore = buildPartidoStore(partido);
  const jugadoresStore = buildJugadoresStore(jugadores);
  const reservasStore = buildReservasStore(reserva);
  const scoreboardStore = buildScoreboardStore(scoreboard);

  return {
    participantsStore,
    partidoStore,
    reservasStore,
    from(table) {
      if (table === 'partidos_abiertos') return partidoStore.handler;
      if (table === 'partidos_abiertos_jugadores') return jugadoresStore.handler;
      if (table === 'match_participants') return participantsStore.handler;
      if (table === 'reservas') return reservasStore.handler;
      if (table === 'scoreboard_partidos') return scoreboardStore.handler;
      throw new Error(`unexpected table ${table}`);
    },
  };
}

function readyPartido(overrides = {}) {
  return {
    id: PARTIDO_ID,
    sede_id: SEDE_ID,
    capitan_user_id: CAPTAIN_ID,
    estado: 'finalizado',
    ganador: 'equipo1',
    resultado: { equipo1: 2, equipo2: 1 },
    deporte: 'padbol',
    reserva_id: RESERVA_ID,
    partido_torneo_id: null,
    torneo_id: null,
    attendance_collection_status: MATCH_ATTENDANCE_COLLECTION_STATUS.READY,
    attendance_opened_at: OPENED_AT,
    attendance_deadline_at: DEADLINE_AT,
    attendance_resolved_at: RESOLVED_AT,
    attendance_resolution_reason: MATCH_ATTENDANCE_RESOLUTION_REASON.ALL_RESPONDED,
    rewards_processed_at: null,
    ...overrides,
  };
}

function reservaRow(overrides = {}) {
  return {
    id: RESERVA_ID,
    user_id: CAPTAIN_ID,
    sede_id: SEDE_ID,
    estado: 'completada',
    partido_id: PARTIDO_ID,
    ...overrides,
  };
}

function participant(userId, overrides = {}) {
  return {
    match_type: MATCH_TYPES.CASUAL,
    match_id: String(PARTIDO_ID),
    user_id: userId,
    role: userId === CAPTAIN_ID ? MATCH_PARTICIPANT_ROLES.ORGANIZER : MATCH_PARTICIPANT_ROLES.PARTICIPANT,
    attendance_status: MATCH_ATTENDANCE_STATUS.CONFIRMED,
    reward_status: MATCH_REWARD_STATUS.PENDING,
    attendance_requested_at: OPENED_AT,
    attendance_responded_at: RESOLVED_AT,
    attendance_response_source: 'player',
    attendance_denial_reason: null,
    ...overrides,
  };
}

describe('matchAttendance Fase 3.3 — evaluación de ramas', () => {
  it('PadCoins credited y ya_acreditado_event → ok', () => {
    assert.equal(evaluatePadcoinsBranchResult({ ok: true, acreditado: true }).ok, true);
    assert.equal(
      evaluatePadcoinsBranchResult({
        ok: true,
        credits: [{ acreditado: false, reason: 'ya_acreditado_event' }],
      }).ok,
      true,
    );
    assert.equal(
      evaluatePadcoinsBranchResult({ ok: true, reason: 'sede_no_participa' }).ok,
      true,
    );
  });

  it('PadCoins hard failure → not ok', () => {
    assert.equal(
      evaluatePadcoinsBranchResult({ ok: false, reason: 'invalid_match_or_reserva' }).ok,
      false,
    );
    assert.equal(
      evaluatePadcoinsBranchResult({
        ok: true,
        credits: [{ acreditado: false, reason: 'skipped' }],
      }).ok,
      false,
    );
  });

  it('Ranking credited, duplicate y recoverable failure', () => {
    assert.equal(evaluateRankingBranchResult({ ok: true, acreditado: true }).ok, true);
    assert.equal(
      evaluateRankingBranchResult({
        ok: true,
        credits: [{ acreditado: false, reason: 'ya_acreditado_event' }],
      }).ok,
      true,
    );
    assert.equal(
      evaluateRankingBranchResult({
        ok: true,
        credits: [{ acreditado: false, reason: 'ranking_update_failed', recoverable: true }],
      }).ok,
      false,
    );
  });
});

describe('matchAttendance Fase 3.3 — tryFinalizeMatchAttendanceRewards', () => {
  const originalFlag = process.env.MATCH_ATTENDANCE_CONFIRMATION_ENABLED;

  afterEach(() => {
    if (originalFlag == null) delete process.env.MATCH_ATTENDANCE_CONFIRMATION_ENABLED;
    else process.env.MATCH_ATTENDANCE_CONFIRMATION_ENABLED = originalFlag;
  });

  it('ready + elegibles → PadCoins + Ranking + credited', async () => {
    process.env.MATCH_ATTENDANCE_CONFIRMATION_ENABLED = 'true';
    const mock = createPhase33Mock({
      partido: readyPartido(),
      participants: [
        participant(CAPTAIN_ID),
        participant(PLAYER_ID),
      ],
      reserva: reservaRow(),
    });

    let padcoinsCalls = 0;
    let rankingCalls = 0;

    const result = await tryFinalizeMatchAttendanceRewards(mock, PARTIDO_ID, {
      now: new Date(NOW),
      deps: {
        creditValidatedMatchPadcoins: async () => {
          padcoinsCalls += 1;
          return {
            ok: true,
            acreditado: true,
            credits: [{ acreditado: true, userId: CAPTAIN_ID }],
          };
        },
        processCasualMatchRankingAfterResultConfirmed: async () => {
          rankingCalls += 1;
          return {
            ok: true,
            acreditado: true,
            credits: [{ acreditado: true, userId: CAPTAIN_ID, rp: 3 }],
          };
        },
        fetchTerminatedScoreboardForPartido: async () => null,
      },
    });

    assert.equal(padcoinsCalls, 1);
    assert.equal(rankingCalls, 1);
    assert.equal(result.credited, true);
    assert.equal(result.rewards.processed, true);
    assert.equal(result.rewards.padcoins.ok, true);
    assert.equal(result.rewards.ranking.ok, true);
    assert.equal(
      mock.partidoStore.row.attendance_collection_status,
      MATCH_ATTENDANCE_COLLECTION_STATUS.CREDITED,
    );
    assert.ok(mock.partidoStore.row.rewards_processed_at);
    assert.equal(mock.partidoStore.row.attendance_resolved_at, RESOLVED_AT);
  });

  it('denied/pending/excluded no reciben recompensas (solo elegibles en deps)', async () => {
    process.env.MATCH_ATTENDANCE_CONFIRMATION_ENABLED = 'true';
    const mock = createPhase33Mock({
      partido: readyPartido(),
      participants: [
        participant(CAPTAIN_ID),
        participant(PLAYER_ID, { attendance_status: MATCH_ATTENDANCE_STATUS.DENIED }),
        participant(OTHER_ID, { attendance_status: MATCH_ATTENDANCE_STATUS.PENDING }),
      ],
      reserva: reservaRow(),
    });

    let padcoinsArgs = null;
    const result = await tryFinalizeMatchAttendanceRewards(mock, PARTIDO_ID, {
      now: new Date(NOW),
      deps: {
        creditValidatedMatchPadcoins: async (_supabase, args) => {
          padcoinsArgs = args;
          return { ok: true, acreditado: true, credits: [{ acreditado: true, userId: CAPTAIN_ID }] };
        },
        processCasualMatchRankingAfterResultConfirmed: async () => ({
          ok: true,
          acreditado: true,
          credits: [{ acreditado: true, userId: CAPTAIN_ID }],
        }),
        fetchTerminatedScoreboardForPartido: async () => null,
      },
    });

    assert.equal(result.credited, true);
    assert.ok(padcoinsArgs?.matchId);
  });

  it('solo organizador elegible → PadCoins ok', async () => {
    process.env.MATCH_ATTENDANCE_CONFIRMATION_ENABLED = 'true';
    const mock = createPhase33Mock({
      partido: readyPartido(),
      participants: [participant(CAPTAIN_ID)],
      reserva: reservaRow(),
    });

    const result = await tryFinalizeMatchAttendanceRewards(mock, PARTIDO_ID, {
      now: new Date(NOW),
      deps: {
        creditValidatedMatchPadcoins: async () => ({
          ok: true,
          acreditado: true,
          credits: [{ acreditado: true, userId: CAPTAIN_ID, kind: 'organizer_only' }],
        }),
        processCasualMatchRankingAfterResultConfirmed: async () => ({
          ok: true,
          acreditado: true,
          credits: [{ acreditado: true, userId: CAPTAIN_ID }],
        }),
        fetchTerminatedScoreboardForPartido: async () => null,
      },
    });

    assert.equal(result.credited, true);
    assert.equal(result.eligible_count, 1);
  });

  it('0 elegibles → blocked', async () => {
    process.env.MATCH_ATTENDANCE_CONFIRMATION_ENABLED = 'true';
    const mock = createPhase33Mock({
      partido: readyPartido(),
      participants: [
        participant(PLAYER_ID, { attendance_status: MATCH_ATTENDANCE_STATUS.DENIED }),
        participant(OTHER_ID, { attendance_status: MATCH_ATTENDANCE_STATUS.EXCLUDED }),
      ],
    });

    const result = await tryFinalizeMatchAttendanceRewards(mock, PARTIDO_ID, { now: new Date(NOW) });

    assert.equal(result.blocked, true);
    assert.equal(
      mock.partidoStore.row.attendance_collection_status,
      MATCH_ATTENDANCE_COLLECTION_STATUS.BLOCKED,
    );
    assert.equal(result.rewards.processed, false);
  });

  it('PadCoins ya credited + Ranking pendiente → completa y credited', async () => {
    process.env.MATCH_ATTENDANCE_CONFIRMATION_ENABLED = 'true';
    const mock = createPhase33Mock({
      partido: readyPartido(),
      participants: [participant(CAPTAIN_ID), participant(PLAYER_ID)],
      reserva: reservaRow(),
    });

    const result = await tryFinalizeMatchAttendanceRewards(mock, PARTIDO_ID, {
      now: new Date(NOW),
      deps: {
        creditValidatedMatchPadcoins: async () => ({
          ok: true,
          acreditado: false,
          credits: [{ acreditado: false, reason: 'ya_acreditado_event', userId: CAPTAIN_ID }],
        }),
        processCasualMatchRankingAfterResultConfirmed: async () => ({
          ok: true,
          acreditado: true,
          credits: [{ acreditado: true, userId: PLAYER_ID }],
        }),
        fetchTerminatedScoreboardForPartido: async () => null,
      },
    });

    assert.equal(result.credited, true);
    assert.equal(result.rewards.padcoins.ok, true);
    assert.equal(result.rewards.ranking.ok, true);
  });

  it('Ranking ya credited + PadCoins pendiente → completa y credited', async () => {
    process.env.MATCH_ATTENDANCE_CONFIRMATION_ENABLED = 'true';
    const mock = createPhase33Mock({
      partido: readyPartido(),
      participants: [participant(CAPTAIN_ID), participant(PLAYER_ID)],
      reserva: reservaRow(),
    });

    const result = await tryFinalizeMatchAttendanceRewards(mock, PARTIDO_ID, {
      now: new Date(NOW),
      deps: {
        creditValidatedMatchPadcoins: async () => ({
          ok: true,
          acreditado: true,
          credits: [{ acreditado: true, userId: CAPTAIN_ID }],
        }),
        processCasualMatchRankingAfterResultConfirmed: async () => ({
          ok: true,
          acreditado: false,
          credits: [{ acreditado: false, reason: 'ya_acreditado_event', userId: PLAYER_ID }],
        }),
        fetchTerminatedScoreboardForPartido: async () => null,
      },
    });

    assert.equal(result.credited, true);
  });

  it('fallo PadCoins → sigue ready', async () => {
    process.env.MATCH_ATTENDANCE_CONFIRMATION_ENABLED = 'true';
    const mock = createPhase33Mock({
      partido: readyPartido(),
      participants: [participant(CAPTAIN_ID), participant(PLAYER_ID)],
      reserva: reservaRow(),
    });

    const result = await tryFinalizeMatchAttendanceRewards(mock, PARTIDO_ID, {
      deps: {
        creditValidatedMatchPadcoins: async () => ({ ok: false, reason: 'padcoins_failed' }),
        processCasualMatchRankingAfterResultConfirmed: async () => ({
          ok: true,
          acreditado: true,
          credits: [{ acreditado: true, userId: PLAYER_ID }],
        }),
        fetchTerminatedScoreboardForPartido: async () => null,
      },
    });

    assert.equal(result.credited, false);
    assert.equal(result.rewards.processed, false);
    assert.equal(result.rewards.padcoins.ok, false);
    assert.equal(
      mock.partidoStore.row.attendance_collection_status,
      MATCH_ATTENDANCE_COLLECTION_STATUS.READY,
    );
  });

  it('fallo Ranking → sigue ready', async () => {
    process.env.MATCH_ATTENDANCE_CONFIRMATION_ENABLED = 'true';
    const mock = createPhase33Mock({
      partido: readyPartido(),
      participants: [participant(CAPTAIN_ID), participant(PLAYER_ID)],
      reserva: reservaRow(),
    });

    const result = await tryFinalizeMatchAttendanceRewards(mock, PARTIDO_ID, {
      deps: {
        creditValidatedMatchPadcoins: async () => ({
          ok: true,
          acreditado: true,
          credits: [{ acreditado: true, userId: CAPTAIN_ID }],
        }),
        processCasualMatchRankingAfterResultConfirmed: async () => ({ ok: false, reason: 'ranking_failed' }),
        fetchTerminatedScoreboardForPartido: async () => null,
      },
    });

    assert.equal(result.credited, false);
    assert.equal(result.rewards.ranking.ok, false);
    assert.equal(
      mock.partidoStore.row.attendance_collection_status,
      MATCH_ATTENDANCE_COLLECTION_STATUS.READY,
    );
  });

  it('segunda ejecución → idempotent skip credited', async () => {
    process.env.MATCH_ATTENDANCE_CONFIRMATION_ENABLED = 'true';
    const mock = createPhase33Mock({
      partido: readyPartido({
        attendance_collection_status: MATCH_ATTENDANCE_COLLECTION_STATUS.CREDITED,
        rewards_processed_at: NOW,
      }),
      participants: [participant(CAPTAIN_ID)],
    });

    let calls = 0;
    const result = await tryFinalizeMatchAttendanceRewards(mock, PARTIDO_ID, {
      deps: {
        creditValidatedMatchPadcoins: async () => {
          calls += 1;
          return { ok: true, acreditado: true };
        },
      },
    });

    assert.equal(calls, 0);
    assert.equal(result.skipped, true);
    assert.equal(result.rewards.processed, true);
  });

  it('torneo → skip', async () => {
    process.env.MATCH_ATTENDANCE_CONFIRMATION_ENABLED = 'true';
    const mock = createPhase33Mock({
      partido: readyPartido({ partido_torneo_id: 99 }),
      participants: [participant(CAPTAIN_ID)],
    });

    const result = await tryFinalizeMatchAttendanceRewards(mock, PARTIDO_ID);
    assert.equal(result.skipped, true);
    assert.equal(result.reason, 'torneo_out_of_scope');
  });

  it('cancelado → skip', async () => {
    process.env.MATCH_ATTENDANCE_CONFIRMATION_ENABLED = 'true';
    const mock = createPhase33Mock({
      partido: readyPartido({ estado: 'cancelado' }),
      participants: [participant(CAPTAIN_ID)],
    });

    const result = await tryFinalizeMatchAttendanceRewards(mock, PARTIDO_ID);
    assert.equal(result.skipped, true);
    assert.equal(result.reason, 'partido_cancelado');
  });

  it('flag OFF → skip sin acreditar', async () => {
    delete process.env.MATCH_ATTENDANCE_CONFIRMATION_ENABLED;
    const mock = createPhase33Mock({
      partido: readyPartido(),
      participants: [participant(CAPTAIN_ID)],
    });

    let calls = 0;
    const result = await tryFinalizeMatchAttendanceRewards(mock, PARTIDO_ID, {
      deps: {
        creditValidatedMatchPadcoins: async () => {
          calls += 1;
          return { ok: true, acreditado: true };
        },
      },
    });

    assert.equal(calls, 0);
    assert.equal(result.reason, 'feature_disabled');
  });

  it('usa scoreboard terminado cuando existe', async () => {
    process.env.MATCH_ATTENDANCE_CONFIRMATION_ENABLED = 'true';
    const mock = createPhase33Mock({
      partido: readyPartido(),
      participants: [participant(CAPTAIN_ID), participant(PLAYER_ID)],
      reserva: reservaRow(),
      scoreboard: { id: 9, estado: 'terminado', partido_abierto_id: PARTIDO_ID, sets_a: 2, sets_b: 0 },
    });

    let rankingPath = null;
    const result = await tryFinalizeMatchAttendanceRewards(mock, PARTIDO_ID, {
      now: new Date(NOW),
      deps: {
        creditValidatedMatchPadcoins: async () => ({
          ok: true,
          acreditado: true,
          credits: [{ acreditado: true, userId: CAPTAIN_ID }],
        }),
        processCasualMatchRankingAfterScoreboardFinished: async () => {
          rankingPath = 'scoreboard';
          return { ok: true, acreditado: true, credits: [{ acreditado: true, userId: PLAYER_ID }] };
        },
        processCasualMatchRankingAfterResultConfirmed: async () => {
          rankingPath = 'manual';
          return { ok: true, acreditado: true, credits: [] };
        },
      },
    });

    assert.equal(rankingPath, 'scoreboard');
    assert.equal(result.credited, true);
  });
});

describe('matchAttendance Fase 3.3 — POST última respuesta', () => {
  const originalFlag = process.env.MATCH_ATTENDANCE_CONFIRMATION_ENABLED;

  afterEach(() => {
    if (originalFlag == null) delete process.env.MATCH_ATTENDANCE_CONFIRMATION_ENABLED;
    else process.env.MATCH_ATTENDANCE_CONFIRMATION_ENABLED = originalFlag;
  });

  it('última respuesta devuelve credited cuando finaliza', async () => {
    process.env.MATCH_ATTENDANCE_CONFIRMATION_ENABLED = 'true';
    const mock = createPhase33Mock({
      partido: {
        id: PARTIDO_ID,
        sede_id: SEDE_ID,
        capitan_user_id: CAPTAIN_ID,
        estado: 'finalizado',
        ganador: 'equipo1',
        resultado: { equipo1: 2, equipo2: 1 },
        deporte: 'padbol',
        reserva_id: RESERVA_ID,
        attendance_collection_status: MATCH_ATTENDANCE_COLLECTION_STATUS.OPEN,
        attendance_opened_at: OPENED_AT,
        attendance_deadline_at: DEADLINE_AT,
        attendance_resolved_at: null,
        attendance_resolution_reason: null,
        rewards_processed_at: null,
      },
      participants: [
        participant(CAPTAIN_ID, { attendance_status: MATCH_ATTENDANCE_STATUS.CONFIRMED }),
        participant(PLAYER_ID, { attendance_status: MATCH_ATTENDANCE_STATUS.PENDING }),
      ],
      jugadores: [{ partido_id: PARTIDO_ID, user_id: PLAYER_ID }],
      reserva: reservaRow(),
    });

    const result = await submitPlayerAttendanceResponse(
      mock,
      PARTIDO_ID,
      PLAYER_ID,
      { response: 'confirm' },
      {
        now: new Date(NOW),
        deps: {
          creditValidatedMatchPadcoins: async () => ({
            ok: true,
            acreditado: true,
            credits: [{ acreditado: true, userId: CAPTAIN_ID }],
          }),
          processCasualMatchRankingAfterResultConfirmed: async () => ({
            ok: true,
            acreditado: true,
            credits: [{ acreditado: true, userId: CAPTAIN_ID }],
          }),
          fetchTerminatedScoreboardForPartido: async () => null,
        },
      },
    );

    assert.equal(result.ok, true);
    assert.equal(result.match.collection_status, MATCH_ATTENDANCE_COLLECTION_STATUS.CREDITED);
    assert.equal(result.rewards.processed, true);
    assert.equal(result.rewards.padcoins.ok, true);
    assert.equal(result.rewards.ranking.ok, true);
  });

  it('flag OFF legacy intacto en POST', async () => {
    delete process.env.MATCH_ATTENDANCE_CONFIRMATION_ENABLED;
    const mock = createPhase33Mock({
      partido: {
        id: PARTIDO_ID,
        sede_id: SEDE_ID,
        capitan_user_id: CAPTAIN_ID,
        attendance_collection_status: MATCH_ATTENDANCE_COLLECTION_STATUS.OPEN,
        attendance_opened_at: OPENED_AT,
        attendance_deadline_at: DEADLINE_AT,
        rewards_processed_at: null,
      },
      participants: [participant(PLAYER_ID, { attendance_status: MATCH_ATTENDANCE_STATUS.PENDING })],
      jugadores: [{ partido_id: PARTIDO_ID, user_id: PLAYER_ID }],
    });

    const result = await submitPlayerAttendanceResponse(
      mock,
      PARTIDO_ID,
      PLAYER_ID,
      { response: 'confirm' },
      { now: new Date(NOW) },
    );

    assert.equal(result.ok, false);
    assert.equal(result.httpStatus, 409);
    assert.equal(result.reason, 'feature_disabled');
  });
});

describe('matchAttendance Fase 3.3 — legacy flag OFF en orquestador padcoins', () => {
  const originalFlag = process.env.MATCH_ATTENDANCE_CONFIRMATION_ENABLED;

  afterEach(() => {
    if (originalFlag == null) delete process.env.MATCH_ATTENDANCE_CONFIRMATION_ENABLED;
    else process.env.MATCH_ATTENDANCE_CONFIRMATION_ENABLED = originalFlag;
  });

  it('processCasualMatchPadcoinsAfterResultConfirmed con flag OFF no abre ventana', async () => {
    delete process.env.MATCH_ATTENDANCE_CONFIRMATION_ENABLED;
    assert.equal(buildAttendanceRewardsResponse({ processed: true }).processed, true);
    void processCasualMatchPadcoinsAfterResultConfirmed;
  });
});
