import assert from 'node:assert/strict';
import { describe, it, afterEach } from 'node:test';
import {
  isMissingOptionalPartidoTorneoColumnError,
  isScoreboardTorneoOutOfScope,
  isTorneoOutOfScopeForCasualAttendance,
} from '../src/matches/matchAttendanceTorneoScope.js';
import {
  PARTIDOS_ATTENDANCE_REWARDS_SELECT,
  tryFinalizeMatchAttendanceRewards,
} from '../src/matches/matchAttendanceService.js';
import {
  MATCH_ATTENDANCE_COLLECTION_STATUS,
  MATCH_ATTENDANCE_RESOLUTION_REASON,
  MATCH_ATTENDANCE_STATUS,
  MATCH_PARTICIPANT_ROLES,
  MATCH_REWARD_STATUS,
  MATCH_TYPES,
} from '../src/matches/matchParticipantsConstants.js';
import { adminReprocessAttendanceRewards } from '../src/matches/matchAttendanceAdminService.js';

const PARTIDO_ID = 91;
const SEDE_ID = 1;
const RESERVA_ID = 601;
const CAPTAIN_ID = 'aaaaaaaa-bbbb-cccc-dddd-111111111111';
const OPENED_AT = '2026-07-10T12:00:00.000Z';
const DEADLINE_AT = '2026-07-13T12:00:00.000Z';
const RESOLVED_AT = '2026-07-11T12:00:00.000Z';
const NOW = '2026-07-11T12:00:00.000Z';

describe('matchAttendanceTorneoScope', () => {
  it('scoreboard con partido_torneo_id → torneo out of scope', () => {
    assert.equal(isScoreboardTorneoOutOfScope({ partido_torneo_id: 44 }), true);
    assert.equal(isScoreboardTorneoOutOfScope({ partido_torneo_id: null }), false);
    assert.equal(isScoreboardTorneoOutOfScope(null), false);
  });

  it('partido_abiertos sin marcadores torneo → casual in scope', () => {
    assert.equal(isTorneoOutOfScopeForCasualAttendance({ partido: { id: 1 } }), false);
  });

  it('marcador legacy en memoria → torneo out of scope', () => {
    assert.equal(
      isTorneoOutOfScopeForCasualAttendance({ partido: { torneo_id: 3 } }),
      true,
    );
  });

  it('detecta error 42703 de columnas torneo opcionales', () => {
    assert.equal(
      isMissingOptionalPartidoTorneoColumnError({
        code: '42703',
        message: 'column partidos_abiertos.partido_torneo_id does not exist',
      }),
      true,
    );
    assert.equal(
      isMissingOptionalPartidoTorneoColumnError({
        code: '42703',
        message: 'column attendance_collection_status does not exist',
      }),
      false,
    );
  });

  it('PARTIDOS_ATTENDANCE_REWARDS_SELECT no incluye columnas torneo inexistentes', () => {
    assert.equal(PARTIDOS_ATTENDANCE_REWARDS_SELECT.includes('partido_torneo_id'), false);
    assert.equal(PARTIDOS_ATTENDANCE_REWARDS_SELECT.includes('torneo_id'), false);
  });
});

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
        this._filters = {};
        resolve({ data: matched, error: null });
      },
    },
  };
}

function readyPartidoProdSchema(overrides = {}) {
  return {
    id: PARTIDO_ID,
    sede_id: SEDE_ID,
    capitan_user_id: CAPTAIN_ID,
    estado: 'finalizado',
    ganador: 'equipo1',
    resultado: { equipo1: 2, equipo2: 1 },
    deporte: 'padbol',
    reserva_id: RESERVA_ID,
    equipos_asignacion: { equipo1: [CAPTAIN_ID], equipo2: [] },
    attendance_collection_status: MATCH_ATTENDANCE_COLLECTION_STATUS.READY,
    attendance_opened_at: OPENED_AT,
    attendance_deadline_at: DEADLINE_AT,
    attendance_resolved_at: RESOLVED_AT,
    attendance_resolution_reason: MATCH_ATTENDANCE_RESOLUTION_REASON.ALL_RESPONDED,
    rewards_processed_at: null,
    ...overrides,
  };
}

function createProdSchemaMock({ partido, participants = [], reserva = null, scoreboard = null } = {}) {
  const partidoStore = buildPartidoStore(partido);
  const participantsStore = buildParticipantsStore(participants);

  return {
    partidoStore,
    from(table) {
      if (table === 'partidos_abiertos') return partidoStore.handler;
      if (table === 'match_participants') return participantsStore.handler;
      if (table === 'reservas') {
        return {
          select() { return this; },
          eq() { return this; },
          maybeSingle: async () => ({ data: reserva ? { ...reserva } : null, error: null }),
        };
      }
      if (table === 'scoreboard_partidos') {
        return {
          select() { return this; },
          eq() { return this; },
          order() { return this; },
          limit() { return this; },
          maybeSingle: async () => ({ data: scoreboard ? { ...scoreboard } : null, error: null }),
        };
      }
      if (table === 'padbol_match_setup_status') {
        return {
          select() { return this; },
          eq() { return this; },
          maybeSingle: async () => ({ data: null, error: null }),
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  };
}

describe('matchAttendance Fase 3.3 — schema prod sin partido_torneo_id', () => {
  const originalFlag = process.env.MATCH_ATTENDANCE_CONFIRMATION_ENABLED;

  afterEach(() => {
    if (originalFlag == null) delete process.env.MATCH_ATTENDANCE_CONFIRMATION_ENABLED;
    else process.env.MATCH_ATTENDANCE_CONFIRMATION_ENABLED = originalFlag;
  });

  it('ready → credited sin columnas torneo en partidos_abiertos', async () => {
    process.env.MATCH_ATTENDANCE_CONFIRMATION_ENABLED = 'true';
    const mock = createProdSchemaMock({
      partido: readyPartidoProdSchema(),
      participants: [{
        match_type: MATCH_TYPES.CASUAL,
        match_id: String(PARTIDO_ID),
        user_id: CAPTAIN_ID,
        role: MATCH_PARTICIPANT_ROLES.ORGANIZER,
        attendance_status: MATCH_ATTENDANCE_STATUS.CONFIRMED,
        reward_status: MATCH_REWARD_STATUS.PENDING,
      }],
      reserva: { id: RESERVA_ID, user_id: CAPTAIN_ID, sede_id: SEDE_ID, partido_id: PARTIDO_ID },
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
          acreditado: true,
          credits: [{ acreditado: true, userId: CAPTAIN_ID, rp: 3 }],
        }),
        fetchTerminatedScoreboardForPartido: async () => null,
      },
    });

    assert.equal(result.credited, true);
    assert.equal(result.rewards.processed, true);
    assert.equal(
      mock.partidoStore.row.attendance_collection_status,
      MATCH_ATTENDANCE_COLLECTION_STATUS.CREDITED,
    );
  });

  it('scoreboard torneo → skip sin depender de columnas en partidos_abiertos', async () => {
    process.env.MATCH_ATTENDANCE_CONFIRMATION_ENABLED = 'true';
    const mock = createProdSchemaMock({
      partido: readyPartidoProdSchema(),
      participants: [{
        match_type: MATCH_TYPES.CASUAL,
        match_id: String(PARTIDO_ID),
        user_id: CAPTAIN_ID,
        role: MATCH_PARTICIPANT_ROLES.ORGANIZER,
        attendance_status: MATCH_ATTENDANCE_STATUS.CONFIRMED,
        reward_status: MATCH_REWARD_STATUS.PENDING,
      }],
      scoreboard: {
        id: 7,
        estado: 'terminado',
        partido_abierto_id: PARTIDO_ID,
        partido_torneo_id: 44,
        sets_a: 2,
        sets_b: 0,
      },
    });

    const result = await tryFinalizeMatchAttendanceRewards(mock, PARTIDO_ID, {
      now: new Date(NOW),
    });

    assert.equal(result.skipped, true);
    assert.equal(result.reason, 'torneo_out_of_scope');
  });

  it('admin reprocesar ready no falla con schema real de partido', async () => {
    process.env.MATCH_ATTENDANCE_CONFIRMATION_ENABLED = 'true';
    const mock = createProdSchemaMock({
      partido: readyPartidoProdSchema(),
      participants: [{
        match_type: MATCH_TYPES.CASUAL,
        match_id: String(PARTIDO_ID),
        user_id: CAPTAIN_ID,
        role: MATCH_PARTICIPANT_ROLES.ORGANIZER,
        attendance_status: MATCH_ATTENDANCE_STATUS.CONFIRMED,
        reward_status: MATCH_REWARD_STATUS.PENDING,
      }],
    });

    const result = await adminReprocessAttendanceRewards(mock, PARTIDO_ID, {
      actor: { user_id: CAPTAIN_ID, role: 'super_admin' },
      deps: {
        tryFinalizeMatchAttendanceRewards: async () => ({
          ok: true,
          credited: true,
          rewards: {
            processed: true,
            padcoins: { ok: true, reason: 'credited' },
            ranking: { ok: true, reason: 'credited' },
          },
        }),
      },
    });

    assert.equal(result.ok, true);
    assert.equal(result.rewards.processed, true);
  });
});
