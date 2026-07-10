import assert from 'node:assert/strict';
import { describe, it, afterEach } from 'node:test';
import {
  DEFAULT_MATCH_ATTENDANCE_WINDOW_HOURS,
  getMatchAttendanceWindowHours,
} from '../src/matches/matchAttendanceConfig.js';
import {
  MATCH_ATTENDANCE_COLLECTION_STATUS,
  MATCH_ATTENDANCE_STATUS,
  MATCH_REWARD_STATUS,
  MATCH_TYPES,
} from '../src/matches/matchParticipantsConstants.js';
import { processCasualMatchPadcoinsAfterResultConfirmed } from '../src/matches/matchRewardsService.js';
import { processScoreboardPadcoinsAfterFinished } from '../src/matches/scoreboardMatchRewardsService.js';
import {
  calculateAttendanceDeadline,
  maybeDeferCasualRewardsForAttendance,
  openAttendanceWindowForMatch,
  partidoHasClearManualResult,
  scoreboardHasClearResult,
  shouldOpenAttendanceWindow,
  syncPendingParticipantsForAttendance,
} from '../src/matches/matchAttendanceService.js';

const PARTIDO_ID = 77;
const RESERVA_ID = 501;
const USER_ORG = 'aaaaaaaa-bbbb-cccc-dddd-111111111111';
const USER_P1 = 'aaaaaaaa-bbbb-cccc-dddd-222222222222';
const USER_P2 = 'aaaaaaaa-bbbb-cccc-dddd-333333333333';
const USER_BAD = 'not-a-uuid';
const OPENED_AT = '2026-07-10T12:00:00.000Z';

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
        if (filters.match_type != null) {
          matched = matched.filter((r) => r.match_type === filters.match_type);
        }
        if (filters.match_id != null) {
          matched = matched.filter((r) => String(r.match_id) === String(filters.match_id));
        }
        if (filters.user_id != null) {
          matched = matched.filter((r) => r.user_id === filters.user_id);
        }
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
      insert(payload) {
        const existing = rows.find(
          (r) => r.match_type === payload.match_type
            && String(r.match_id) === String(payload.match_id)
            && r.user_id === payload.user_id,
        );
        if (existing) {
          return {
            select() { return this; },
            single: async () => ({
              data: null,
              error: { code: '23505', message: 'duplicate match_participants' },
            }),
          };
        }
        const row = { ...payload, id: nextId++ };
        rows.push(row);
        return {
          select() { return this; },
          single: async () => ({ data: row, error: null }),
        };
      },
      update(payload) {
        const filters = {};
        const builder = {
          eq(field, value) {
            filters[field] = value;
            return builder;
          },
          select() { return builder; },
          single: async () => {
            const row = rows.find((r) =>
              Object.entries(filters).every(([k, v]) => String(r[k]) === String(v)),
            );
            if (row) Object.assign(row, payload);
            return { data: row ?? null, error: row ? null : { message: 'not found' } };
          },
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
      select(_cols) {
        this._selectCols = _cols;
        return this;
      },
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
        this._selectCols = null;

        if (updatePayload) {
          const match = Object.entries(filters).every(([k, v]) => String(row[k]) === String(v));
          if (match) {
            row = { ...row, ...updatePayload };
          }
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
      then(resolve) {
        const filters = this._filters;
        this._filters = {};
        let matched = [...rows];
        if (filters.partido_id != null) {
          matched = matched.filter((r) => Number(r.partido_id) === Number(filters.partido_id));
        }
        resolve({ data: matched, error: null });
      },
    },
  };
}

function createAttendanceMock({
  partido,
  participants = [],
  jugadores = [],
  reserva = null,
} = {}) {
  const participantsStore = buildParticipantsStore(participants);
  const partidoStore = buildPartidoStore(partido);
  const jugadoresStore = buildJugadoresStore(jugadores);

  const reservaRow = reserva ?? {
    id: RESERVA_ID,
    user_id: USER_ORG,
    sede_id: 1,
    partido_id: PARTIDO_ID,
    estado: 'completada',
    monto_pagado: 100,
    moneda: 'USD',
    pago_estado: 'pagado',
  };

  const supabaseAdmin = {
    participantsStore,
    partidoStore,
    from(table) {
      if (table === 'partidos_abiertos') return partidoStore.handler;
      if (table === 'match_participants') return participantsStore.handler;
      if (table === 'partidos_abiertos_jugadores') return jugadoresStore.handler;
      if (table === 'reservas') {
        return {
          select() { return this; },
          eq(field, value) {
            this._eqField = field;
            this._eqValue = value;
            return this;
          },
          maybeSingle: async function maybeSingle() {
            const matchesId = this._eqField === 'id'
              && Number(this._eqValue) === Number(reservaRow.id);
            const matchesPartido = this._eqField === 'partido_id'
              && Number(this._eqValue) === Number(reservaRow.partido_id);
            return {
              data: matchesId || matchesPartido ? reservaRow : null,
              error: null,
            };
          },
        };
      }
      if (table === 'scoreboard_jugadores_temp') {
        return {
          select() { return this; },
          eq() { return this; },
          then(resolve) { resolve({ data: [], error: null }); },
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  };

  return supabaseAdmin;
}

describe('matchAttendance Fase 3.1 — helpers', () => {
  const originalWindow = process.env.MATCH_ATTENDANCE_WINDOW_HOURS;
  const originalFlag = process.env.MATCH_ATTENDANCE_CONFIRMATION_ENABLED;

  afterEach(() => {
    if (originalWindow == null) delete process.env.MATCH_ATTENDANCE_WINDOW_HOURS;
    else process.env.MATCH_ATTENDANCE_WINDOW_HOURS = originalWindow;
    if (originalFlag == null) delete process.env.MATCH_ATTENDANCE_CONFIRMATION_ENABLED;
    else process.env.MATCH_ATTENDANCE_CONFIRMATION_ENABLED = originalFlag;
  });

  it('deadline default 72 horas', () => {
    delete process.env.MATCH_ATTENDANCE_WINDOW_HOURS;
    assert.equal(getMatchAttendanceWindowHours(), DEFAULT_MATCH_ATTENDANCE_WINDOW_HOURS);
    const deadline = calculateAttendanceDeadline(OPENED_AT);
    assert.equal(deadline, '2026-07-13T12:00:00.000Z');
  });

  it('shouldOpenAttendanceWindow respeta flag, cancelado y resultado', () => {
    process.env.MATCH_ATTENDANCE_CONFIRMATION_ENABLED = 'true';
    assert.equal(shouldOpenAttendanceWindow({
      estado: 'finalizado',
      attendance_collection_status: 'none',
    }, { hasClearResult: true }), true);
    assert.equal(shouldOpenAttendanceWindow({
      estado: 'cancelado',
      attendance_collection_status: 'none',
    }, { hasClearResult: true }), false);
    assert.equal(shouldOpenAttendanceWindow({
      estado: 'finalizado',
      attendance_collection_status: 'open',
    }, { hasClearResult: true }), false);

    delete process.env.MATCH_ATTENDANCE_CONFIRMATION_ENABLED;
    assert.equal(shouldOpenAttendanceWindow({
      estado: 'finalizado',
      attendance_collection_status: 'none',
    }, { hasClearResult: true }), false);
  });

  it('partidoHasClearManualResult y scoreboardHasClearResult', () => {
    assert.equal(partidoHasClearManualResult({
      estado: 'finalizado',
      ganador: 'equipo1',
      resultado: { equipo1: 6, equipo2: 4 },
    }), true);
    assert.equal(partidoHasClearManualResult({
      estado: 'finalizado',
      resultado: { equipo1: 4, equipo2: 4 },
    }), false);
    assert.equal(scoreboardHasClearResult({ sets_a: 2, sets_b: 1 }), true);
    assert.equal(scoreboardHasClearResult({ sets_a: 1, sets_b: 1 }), false);
  });
});

describe('matchAttendance Fase 3.1 — sync y ventana', () => {
  const originalFlag = process.env.MATCH_ATTENDANCE_CONFIRMATION_ENABLED;

  afterEach(() => {
    if (originalFlag == null) delete process.env.MATCH_ATTENDANCE_CONFIRMATION_ENABLED;
    else process.env.MATCH_ATTENDANCE_CONFIRMATION_ENABLED = originalFlag;
  });

  it('sync pending inserta UUID válido y omite inválido', async () => {
    const supabase = createAttendanceMock({
      partido: {
        id: PARTIDO_ID,
        capitan_user_id: USER_ORG,
        estado: 'finalizado',
        equipos_asignacion: {
          equipo1: [USER_ORG],
          equipo2: [USER_P1],
        },
      },
      jugadores: [
        { partido_id: PARTIDO_ID, user_id: USER_ORG, email: 'org@test.com' },
        { partido_id: PARTIDO_ID, user_id: USER_P1, email: 'p1@test.com' },
        { partido_id: PARTIDO_ID, user_id: USER_BAD, email: 'bad@test.com' },
      ],
    });

    const result = await syncPendingParticipantsForAttendance(
      supabase,
      PARTIDO_ID,
      'manual',
      { requestedAt: OPENED_AT },
    );

    assert.equal(result.ok, true);
    assert.equal(result.inserted >= 2, true);
    assert.equal(result.skipped_no_user_id >= 1, true);
    for (const row of supabase.participantsStore.rows) {
      assert.equal(row.attendance_status, MATCH_ATTENDANCE_STATUS.PENDING);
      assert.equal(row.reward_status, MATCH_REWARD_STATUS.PENDING);
      assert.equal(row.attendance_requested_at, OPENED_AT);
      assert.equal(row.attendance_response_source, null);
    }
  });

  it('preserva confirmed/admin_validated existente', async () => {
    const supabase = createAttendanceMock({
      partido: { id: PARTIDO_ID, capitan_user_id: USER_ORG, estado: 'finalizado' },
      participants: [{
        match_type: MATCH_TYPES.CASUAL,
        match_id: String(PARTIDO_ID),
        user_id: USER_ORG,
        attendance_status: MATCH_ATTENDANCE_STATUS.ADMIN_VALIDATED,
        reward_status: MATCH_REWARD_STATUS.ELIGIBLE,
      }],
      jugadores: [{ partido_id: PARTIDO_ID, user_id: USER_ORG }],
    });

    const result = await syncPendingParticipantsForAttendance(
      supabase,
      PARTIDO_ID,
      'manual',
      { requestedAt: OPENED_AT },
    );

    assert.equal(result.preserved, 1);
    const row = supabase.participantsStore.rows.find((r) => r.user_id === USER_ORG);
    assert.equal(row.attendance_status, MATCH_ATTENDANCE_STATUS.ADMIN_VALIDATED);
    assert.equal(row.reward_status, MATCH_REWARD_STATUS.ELIGIBLE);
  });

  it('flag ON abre ventana open con deadline', async () => {
    process.env.MATCH_ATTENDANCE_CONFIRMATION_ENABLED = 'true';
    const supabase = createAttendanceMock({
      partido: {
        id: PARTIDO_ID,
        capitan_user_id: USER_ORG,
        estado: 'finalizado',
        ganador: 'equipo1',
        resultado: { equipo1: 6, equipo2: 3 },
        attendance_collection_status: MATCH_ATTENDANCE_COLLECTION_STATUS.NONE,
        sede_id: 1,
      },
      jugadores: [
        { partido_id: PARTIDO_ID, user_id: USER_ORG },
        { partido_id: PARTIDO_ID, user_id: USER_P1 },
      ],
    });

    const result = await openAttendanceWindowForMatch(supabase, PARTIDO_ID, {
      source: 'manual',
      now: new Date(OPENED_AT),
    });

    assert.equal(result.ok, true);
    assert.equal(result.opened, true);
    assert.equal(result.collection_status, MATCH_ATTENDANCE_COLLECTION_STATUS.OPEN);
    assert.equal(result.opened_at, OPENED_AT);
    assert.equal(result.deadline_at, '2026-07-13T12:00:00.000Z');
    assert.equal(
      supabase.partidoStore.row.attendance_collection_status,
      MATCH_ATTENDANCE_COLLECTION_STATUS.OPEN,
    );
  });

  it('segunda ejecución es idempotente y no reinicia deadline', async () => {
    process.env.MATCH_ATTENDANCE_CONFIRMATION_ENABLED = 'true';
    const supabase = createAttendanceMock({
      partido: {
        id: PARTIDO_ID,
        capitan_user_id: USER_ORG,
        estado: 'finalizado',
        ganador: 'equipo1',
        resultado: { equipo1: 6, equipo2: 3 },
        attendance_collection_status: MATCH_ATTENDANCE_COLLECTION_STATUS.OPEN,
        attendance_opened_at: OPENED_AT,
        attendance_deadline_at: '2026-07-13T12:00:00.000Z',
        sede_id: 1,
      },
      jugadores: [{ partido_id: PARTIDO_ID, user_id: USER_ORG }],
    });

    const result = await openAttendanceWindowForMatch(supabase, PARTIDO_ID, {
      source: 'manual',
      now: new Date('2026-07-11T12:00:00.000Z'),
    });

    assert.equal(result.ok, true);
    assert.equal(result.idempotent, true);
    assert.equal(result.already_open, true);
    assert.equal(supabase.partidoStore.row.attendance_opened_at, OPENED_AT);
    assert.equal(supabase.partidoStore.row.attendance_deadline_at, '2026-07-13T12:00:00.000Z');
  });

  it('cancelado y resultado no claro no abren ventana', async () => {
    process.env.MATCH_ATTENDANCE_CONFIRMATION_ENABLED = 'true';
    const supabase = createAttendanceMock({
      partido: {
        id: PARTIDO_ID,
        capitan_user_id: USER_ORG,
        estado: 'cancelado',
        attendance_collection_status: MATCH_ATTENDANCE_COLLECTION_STATUS.NONE,
      },
    });

    const cancelled = await openAttendanceWindowForMatch(supabase, PARTIDO_ID, {
      source: 'manual',
      hasClearResult: true,
    });
    assert.equal(cancelled.ok, false);

    const supabase2 = createAttendanceMock({
      partido: {
        id: PARTIDO_ID,
        capitan_user_id: USER_ORG,
        estado: 'finalizado',
        resultado: { equipo1: 4, equipo2: 4 },
        attendance_collection_status: MATCH_ATTENDANCE_COLLECTION_STATUS.NONE,
      },
    });
    const unclear = await openAttendanceWindowForMatch(supabase2, PARTIDO_ID, {
      source: 'manual',
    });
    assert.equal(unclear.ok, false);
    assert.equal(unclear.reason, 'resultado_no_claro');
  });
});

describe('matchAttendance Fase 3.1 — orquestación recompensas', () => {
  const originalFlag = process.env.MATCH_ATTENDANCE_CONFIRMATION_ENABLED;

  afterEach(() => {
    if (originalFlag == null) delete process.env.MATCH_ATTENDANCE_CONFIRMATION_ENABLED;
    else process.env.MATCH_ATTENDANCE_CONFIRMATION_ENABLED = originalFlag;
  });

  it('flag OFF manual mantiene sync admin_validated', async () => {
    delete process.env.MATCH_ATTENDANCE_CONFIRMATION_ENABLED;
    const supabase = createAttendanceMock({
      partido: {
        id: PARTIDO_ID,
        capitan_user_id: USER_ORG,
        reserva_id: RESERVA_ID,
        estado: 'finalizado',
        ganador: 'equipo1',
        resultado: { equipo1: 6, equipo2: 2 },
        attendance_collection_status: MATCH_ATTENDANCE_COLLECTION_STATUS.NONE,
      },
      jugadores: [{ partido_id: PARTIDO_ID, user_id: USER_ORG }],
    });

    const defer = await maybeDeferCasualRewardsForAttendance(supabase, PARTIDO_ID, {
      partido: supabase.partidoStore.row,
      source: 'manual',
    });
    assert.equal(defer.deferred, false);

    const result = await processCasualMatchPadcoinsAfterResultConfirmed(supabase, PARTIDO_ID);

    assert.equal(result.attendance_pending, undefined);
    const row = supabase.participantsStore.rows.find((r) => r.user_id === USER_ORG);
    assert.equal(row?.attendance_status, MATCH_ATTENDANCE_STATUS.ADMIN_VALIDATED);
  });

  it('flag ON manual difiere PadCoins y abre ventana pending', async () => {
    process.env.MATCH_ATTENDANCE_CONFIRMATION_ENABLED = 'true';
    const supabase = createAttendanceMock({
      partido: {
        id: PARTIDO_ID,
        capitan_user_id: USER_ORG,
        reserva_id: RESERVA_ID,
        estado: 'finalizado',
        ganador: 'equipo1',
        resultado: { equipo1: 6, equipo2: 2 },
        attendance_collection_status: MATCH_ATTENDANCE_COLLECTION_STATUS.NONE,
        sede_id: 1,
      },
      jugadores: [
        { partido_id: PARTIDO_ID, user_id: USER_ORG },
        { partido_id: PARTIDO_ID, user_id: USER_P1 },
      ],
    });

    const result = await processCasualMatchPadcoinsAfterResultConfirmed(supabase, PARTIDO_ID);

    assert.equal(result.attendance_pending, true);
    assert.equal(result.acreditado, false);
    assert.equal(
      supabase.partidoStore.row.attendance_collection_status,
      MATCH_ATTENDANCE_COLLECTION_STATUS.OPEN,
    );
    for (const row of supabase.participantsStore.rows.filter((r) =>
      r.attendance_status !== MATCH_ATTENDANCE_STATUS.ADMIN_VALIDATED,
    )) {
      assert.equal(row.attendance_status, MATCH_ATTENDANCE_STATUS.PENDING);
    }
  });

  it('flag ON Smart Score difiere PadCoins', async () => {
    process.env.MATCH_ATTENDANCE_CONFIRMATION_ENABLED = 'true';
    const scoreboard = {
      id: 'sb-31',
      estado: 'terminado',
      sets_a: 2,
      sets_b: 0,
      partido_abierto_id: PARTIDO_ID,
      reserva_id: RESERVA_ID,
      equipo_a_jugadores: [{ user_id: USER_ORG }],
      equipo_b_jugadores: [{ user_id: USER_P1 }],
    };

    const supabase = createAttendanceMock({
      partido: {
        id: PARTIDO_ID,
        capitan_user_id: USER_ORG,
        reserva_id: RESERVA_ID,
        estado: 'completo',
        attendance_collection_status: MATCH_ATTENDANCE_COLLECTION_STATUS.NONE,
        sede_id: 1,
      },
    });

    const result = await processScoreboardPadcoinsAfterFinished(supabase, scoreboard, {
      creditValidatedMatchPadcoins: async () => {
        throw new Error('PadCoins should not be called with flag ON');
      },
    });

    assert.equal(result.attendance_pending, true);
    assert.equal(result.acreditado, false);
  });

  it('torneo Smart Score sigue en skip', async () => {
    process.env.MATCH_ATTENDANCE_CONFIRMATION_ENABLED = 'true';
    const supabase = createAttendanceMock({});
    const result = await processScoreboardPadcoinsAfterFinished(supabase, {
      id: 'sb-t',
      estado: 'terminado',
      partido_torneo_id: 99,
      sets_a: 2,
      sets_b: 1,
    });

    assert.equal(result.skipped, true);
    assert.equal(result.reason, 'torneo_out_of_scope');
  });

  it('maybeDeferCasualRewardsForAttendance no abre con flag OFF', async () => {
    delete process.env.MATCH_ATTENDANCE_CONFIRMATION_ENABLED;
    const supabase = createAttendanceMock({
      partido: {
        id: PARTIDO_ID,
        estado: 'finalizado',
        ganador: 'equipo1',
        attendance_collection_status: MATCH_ATTENDANCE_COLLECTION_STATUS.NONE,
      },
    });

    const result = await maybeDeferCasualRewardsForAttendance(supabase, PARTIDO_ID, {
      partido: supabase.partidoStore.row,
      source: 'manual',
    });

    assert.equal(result.deferred, false);
    assert.equal(result.reason, 'feature_disabled');
  });
});
