import assert from 'node:assert/strict';
import { describe, it, afterEach } from 'node:test';
import {
  MATCH_ATTENDANCE_COLLECTION_STATUS,
  MATCH_ATTENDANCE_STATUS,
  MATCH_PARTICIPANT_ROLES,
  MATCH_REWARD_EVENT_STATUS,
  MATCH_REWARD_STATUS,
  MATCH_REWARD_TYPES,
  MATCH_TYPES,
} from '../src/matches/matchParticipantsConstants.js';
import {
  buildSubmitPlayerAttendanceRewards,
  submitPlayerAttendanceResponse,
  tryFinalizeMatchAttendanceRewards,
} from '../src/matches/matchAttendanceService.js';
import {
  buildAttendanceParticipantPadcoinsSourceKey,
  creditIndividualAttendancePadcoins,
  creditValidatedMatchPadcoins,
  getParticipantsForPadcoinsShareProjection,
} from '../src/matches/matchRewardsService.js';

const PARTIDO_ID = 91;
const SEDE_ID = 1;
const RESERVA_ID = 601;
const CAP1 = '8beebdbe-e1d7-4607-9bb0-9a7d64701408';
const CAP2 = 'fdd06cfa-783f-405c-a191-ec413e04dd47';
const P3 = 'd4cbffdb-99fb-485e-953d-271f12143428';
const OPENED_AT = '2026-07-10T12:00:00.000Z';
const DEADLINE_AT = '2026-07-13T12:00:00.000Z';
const NOW = '2026-07-10T14:00:00.000Z';

function buildRewardEventsStore(initial = []) {
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
      insert(payload) {
        const row = { id: rows.length + 1, ...payload, status: payload.status ?? 'pending' };
        const dup = rows.find((r) => r.source_key === row.source_key);
        if (dup) {
          return {
            select: () => ({
              single: async () => ({
                error: { code: '23505', message: 'duplicate match_reward_events' },
              }),
            }),
          };
        }
        rows.push(row);
        return {
          select: () => ({
            single: async () => ({ data: row, error: null }),
          }),
        };
      },
      update(payload) {
        const filters = {};
        const builder = {
          eq(field, value) {
            filters[field] = value;
            return builder;
          },
          then: async (resolve) => {
            const row = rows.find((r) => String(r.id) === String(filters.id));
            if (row) Object.assign(row, payload);
            resolve({ error: null });
          },
        };
        return builder;
      },
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

function buildParticipantsStore(initial = []) {
  const rows = initial.map((row, index) => ({ id: index + 1, ...row }));
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

function createAttendanceMock({
  partido,
  participants = [],
  jugadores = [],
  reserva = null,
  rewardEvents = [],
} = {}) {
  const participantsStore = buildParticipantsStore(participants);
  const partidoStore = buildPartidoStore(partido);
  const jugadoresStore = buildJugadoresStore(jugadores);
  const reservasStore = buildReservasStore(reserva);
  const rewardEventsStore = buildRewardEventsStore(rewardEvents);

  return {
    participantsStore,
    partidoStore,
    rewardEventsStore,
    from(table) {
      if (table === 'partidos_abiertos') return partidoStore.handler;
      if (table === 'partidos_abiertos_jugadores') return jugadoresStore.handler;
      if (table === 'match_participants') return participantsStore.handler;
      if (table === 'reservas') return reservasStore.handler;
      if (table === 'match_reward_events') return rewardEventsStore.handler;
      if (table === 'scoreboard_partidos') {
        return {
          select: () => ({
            eq: () => ({
              order: () => ({
                limit: () => ({
                  maybeSingle: async () => ({ data: null, error: null }),
                }),
              }),
            }),
          }),
        };
      }
      if (table === 'padbol_match_setup_status') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: { sede_id: SEDE_ID, attendance_confirmation_enabled: true },
                error: null,
              }),
            }),
          }),
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  };
}

function openPartido(overrides = {}) {
  return {
    id: PARTIDO_ID,
    sede_id: SEDE_ID,
    capitan_user_id: CAP1,
    estado: 'finalizado',
    ganador: 'equipo1',
    resultado: { equipo1: 6, equipo2: 2 },
    deporte: 'padbol',
    reserva_id: RESERVA_ID,
    attendance_collection_status: MATCH_ATTENDANCE_COLLECTION_STATUS.OPEN,
    attendance_opened_at: OPENED_AT,
    attendance_deadline_at: DEADLINE_AT,
    attendance_resolved_at: null,
    attendance_resolution_reason: null,
    rewards_processed_at: null,
    ...overrides,
  };
}

function reservaRow(overrides = {}) {
  return {
    id: RESERVA_ID,
    user_id: CAP1,
    sede_id: SEDE_ID,
    estado: 'completada',
    partido_id: PARTIDO_ID,
    precio: 100,
    ...overrides,
  };
}

function participantRow(userId, overrides = {}) {
  return {
    match_type: MATCH_TYPES.CASUAL,
    match_id: String(PARTIDO_ID),
    user_id: userId,
    role: userId === CAP1 ? MATCH_PARTICIPANT_ROLES.ORGANIZER : MATCH_PARTICIPANT_ROLES.PARTICIPANT,
    attendance_status: MATCH_ATTENDANCE_STATUS.PENDING,
    reward_status: MATCH_REWARD_STATUS.PENDING,
    attendance_requested_at: OPENED_AT,
    attendance_responded_at: null,
    attendance_response_source: null,
    attendance_denial_reason: null,
    ...overrides,
  };
}

describe('PadCoins individual al confirmar asistencia', () => {
  const originalFlag = process.env.MATCH_ATTENDANCE_CONFIRMATION_ENABLED;

  afterEach(() => {
    if (originalFlag == null) delete process.env.MATCH_ATTENDANCE_CONFIRMATION_ENABLED;
    else process.env.MATCH_ATTENDANCE_CONFIRMATION_ENABLED = originalFlag;
  });

  it('buildAttendanceParticipantPadcoinsSourceKey es estable', () => {
    const key = buildAttendanceParticipantPadcoinsSourceKey(PARTIDO_ID, CAP1);
    assert.equal(key, `attendance|match|${PARTIDO_ID}|user|${CAP1}|padcoins`);
  });

  it('getParticipantsForPadcoinsShareProjection incluye pending y confirmed, excluye denied', () => {
    const projection = getParticipantsForPadcoinsShareProjection([
      participantRow(CAP1, { attendance_status: MATCH_ATTENDANCE_STATUS.CONFIRMED }),
      participantRow(CAP2, { attendance_status: MATCH_ATTENDANCE_STATUS.PENDING }),
      participantRow(P3, { attendance_status: MATCH_ATTENDANCE_STATUS.DENIED }),
    ]);
    assert.equal(projection.length, 2);
    assert.ok(projection.some((p) => p.user_id === CAP1));
    assert.ok(projection.some((p) => p.user_id === CAP2));
  });

  it('buildSubmitPlayerAttendanceRewards — confirm con PadCoins, Ranking pending', () => {
    const rewards = buildSubmitPlayerAttendanceRewards({
      individualPadcoins: {
        processed: true,
        acreditado: true,
        amount: 42,
        reason: 'credited',
      },
      globalRewards: {
        ranking: { ok: false, reason: 'not_ready' },
      },
      partidoFields: { collection_status: MATCH_ATTENDANCE_COLLECTION_STATUS.OPEN },
    });
    assert.equal(rewards.padcoins.processed, true);
    assert.equal(rewards.padcoins.credited, true);
    assert.equal(rewards.padcoins.amount, 42);
    assert.equal(rewards.ranking.pending, true);
    assert.equal(rewards.ranking.reason, 'pending_global_close');
  });

  it('primer jugador confirma → PadCoins inmediatos, ventana open', async () => {
    process.env.MATCH_ATTENDANCE_CONFIRMATION_ENABLED = 'true';
    const mock = createAttendanceMock({
      partido: openPartido(),
      participants: [
        participantRow(CAP1),
        participantRow(CAP2),
        participantRow(P3),
      ],
      jugadores: [
        { partido_id: PARTIDO_ID, user_id: CAP1 },
        { partido_id: PARTIDO_ID, user_id: CAP2 },
        { partido_id: PARTIDO_ID, user_id: P3 },
      ],
      reserva: reservaRow(),
    });

    const result = await submitPlayerAttendanceResponse(
      mock,
      PARTIDO_ID,
      CAP1,
      { response: 'confirm' },
      {
        now: new Date(NOW),
        deps: {
          creditIndividualAttendancePadcoins: async () => ({
            ok: true,
            processed: true,
            acreditado: true,
            amount: 30,
            padcoins: 30,
            reason: 'credited',
          }),
          tryFinalizeMatchAttendanceRewards: async () => ({
            ok: true,
            skipped: true,
            rewards: {
              processed: false,
              padcoins: { ok: false, reason: 'not_ready' },
              ranking: { ok: false, reason: 'not_ready' },
            },
          }),
        },
      },
    );

    assert.equal(result.ok, true);
    assert.equal(result.match.collection_status, MATCH_ATTENDANCE_COLLECTION_STATUS.OPEN);
    assert.equal(result.player.attendance_status, MATCH_ATTENDANCE_STATUS.CONFIRMED);
    assert.equal(result.padcoins.credited, true);
    assert.equal(result.padcoins.amount, 30);
    assert.equal(result.ranking.pending, true);
  });

  it('deny → sin PadCoins, reward skipped', async () => {
    process.env.MATCH_ATTENDANCE_CONFIRMATION_ENABLED = 'true';
    const mock = createAttendanceMock({
      partido: openPartido(),
      participants: [participantRow(P3)],
      jugadores: [{ partido_id: PARTIDO_ID, user_id: P3 }],
      reserva: reservaRow(),
    });

    const result = await submitPlayerAttendanceResponse(
      mock,
      PARTIDO_ID,
      P3,
      { response: 'deny', reason: 'no jugué' },
      {
        now: new Date(NOW),
        deps: {
          creditIndividualAttendancePadcoins: async () => {
            throw new Error('no debe llamarse en deny');
          },
        },
      },
    );

    assert.equal(result.player.attendance_status, MATCH_ATTENDANCE_STATUS.DENIED);
    assert.equal(result.padcoins.credited, false);
    assert.equal(result.padcoins.reason, 'denied');
    assert.equal(mock.participantsStore.rows[0].reward_status, MATCH_REWARD_STATUS.SKIPPED);
  });

  it('repetición confirm → idempotente sin duplicar PadCoins', async () => {
    process.env.MATCH_ATTENDANCE_CONFIRMATION_ENABLED = 'true';
    let calls = 0;
    const mock = createAttendanceMock({
      partido: openPartido(),
      participants: [
        participantRow(CAP1, {
          attendance_status: MATCH_ATTENDANCE_STATUS.CONFIRMED,
          attendance_responded_at: NOW,
          attendance_response_source: 'player',
        }),
      ],
      jugadores: [{ partido_id: PARTIDO_ID, user_id: CAP1 }],
      reserva: reservaRow(),
    });

    const creditMock = async () => {
      calls += 1;
      return {
        ok: true,
        processed: true,
        acreditado: false,
        reason: 'ya_acreditado_event',
        amount: 30,
        padcoins: 30,
      };
    };

    const result = await submitPlayerAttendanceResponse(
      mock,
      PARTIDO_ID,
      CAP1,
      { response: 'confirm' },
      { now: new Date(NOW), deps: { creditIndividualAttendancePadcoins: creditMock } },
    );

    assert.equal(result.idempotent, true);
    assert.equal(calls, 1);
    assert.equal(result.padcoins.credited, false);
    assert.equal(result.padcoins.reason, 'already_credited');
  });

  it('cierre global → Ranking acreditado, PadCoins ya individual no se repiten', async () => {
    process.env.MATCH_ATTENDANCE_CONFIRMATION_ENABLED = 'true';
    const sourceKey = buildAttendanceParticipantPadcoinsSourceKey(PARTIDO_ID, CAP1);
    const mock = createAttendanceMock({
      partido: {
        ...openPartido(),
        attendance_collection_status: MATCH_ATTENDANCE_COLLECTION_STATUS.READY,
        attendance_resolved_at: NOW,
        attendance_resolution_reason: 'all_responded',
      },
      participants: [
        participantRow(CAP1, { attendance_status: MATCH_ATTENDANCE_STATUS.CONFIRMED, reward_status: MATCH_REWARD_STATUS.CREDITED }),
        participantRow(CAP2, { attendance_status: MATCH_ATTENDANCE_STATUS.CONFIRMED, reward_status: MATCH_REWARD_STATUS.CREDITED }),
        participantRow(P3, { attendance_status: MATCH_ATTENDANCE_STATUS.DENIED, reward_status: MATCH_REWARD_STATUS.SKIPPED }),
      ],
      jugadores: [
        { partido_id: PARTIDO_ID, user_id: CAP1 },
        { partido_id: PARTIDO_ID, user_id: CAP2 },
      ],
      reserva: reservaRow(),
      rewardEvents: [{
        source_key: sourceKey,
        status: MATCH_REWARD_EVENT_STATUS.CREDITED,
        user_id: CAP1,
        reward_type: MATCH_REWARD_TYPES.PADCOINS,
        amount: 30,
      }],
    });

    let padcoinsCalls = 0;
    const result = await tryFinalizeMatchAttendanceRewards(mock, PARTIDO_ID, {
      now: new Date(NOW),
      deps: {
        creditValidatedMatchPadcoins: async () => {
          padcoinsCalls += 1;
          return {
            ok: true,
            acreditado: true,
            reason: 'already_credited_individually',
            credits: [
              { acreditado: false, reason: 'ya_acreditado_event', userId: CAP1 },
              { acreditado: false, reason: 'ya_acreditado_event', userId: CAP2 },
            ],
          };
        },
        processCasualMatchRankingAfterResultConfirmed: async () => ({
          ok: true,
          acreditado: true,
          credits: [{ acreditado: true, userId: CAP1 }],
        }),
        fetchTerminatedScoreboardForPartido: async () => null,
      },
    });

    assert.equal(padcoinsCalls, 1);
    assert.equal(result.credited, true);
    assert.equal(result.rewards.ranking.ok, true);
    assert.equal(result.rewards.padcoins.ok, true);
  });

  it('reserva no acreditable → confirm OK, PadCoins skipped', async () => {
    process.env.MATCH_ATTENDANCE_CONFIRMATION_ENABLED = 'true';
    const mock = createAttendanceMock({
      partido: openPartido(),
      participants: [participantRow(CAP2)],
      jugadores: [{ partido_id: PARTIDO_ID, user_id: CAP2 }],
      reserva: reservaRow({ estado: 'cancelada' }),
    });

    const result = await submitPlayerAttendanceResponse(
      mock,
      PARTIDO_ID,
      CAP2,
      { response: 'confirm' },
      {
        now: new Date(NOW),
        deps: {
          creditIndividualAttendancePadcoins: async () => ({
            ok: true,
            processed: true,
            acreditado: false,
            reason: 'reserva_no_acreditable',
            amount: 0,
          }),
        },
      },
    );

    assert.equal(result.ok, true);
    assert.equal(result.padcoins.credited, false);
    assert.equal(result.padcoins.reason, 'reserva_no_acreditable');
    assert.equal(result.ranking.pending, true);
  });
});
