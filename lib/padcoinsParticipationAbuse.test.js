import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PADCOINS_MOVEMENT_TYPES } from '../src/padcoins/padcoinsConfig.js';
import {
  MATCH_ATTENDANCE_STATUS,
  MATCH_PARTICIPANT_ROLES,
  MATCH_REWARD_EVENT_STATUS,
  MATCH_REWARD_TYPES,
  MATCH_TYPES,
  RESERVATION_REWARD_MODES,
} from '../src/matches/matchParticipantsConstants.js';
import {
  buildAttendanceParticipantPadcoinsSourceKey,
  creditIndividualAttendancePadcoins,
  evaluateReservationRewardMode,
  preventDuplicateRewardBySourceKey,
  processReservationPadcoinsOnComplete,
} from '../src/matches/matchRewardsService.js';
import { acreditarPadcoinsPorReservaCompletada } from '../src/padcoins/padcoinsReservasService.js';
import { revertirPadcoinsParticipacionPorReserva } from '../src/padcoins/matchParticipationPadcoinsReversalService.js';

const RESERVA_ID = 701;
const PARTIDO_ID = 81;
const SEDE_ID = 1;
const PAYER = '11111111-1111-1111-1111-111111111111';
const PLAYER_A = '22222222-2222-2222-2222-222222222222';
const PLAYER_B = '33333333-3333-3333-3333-333333333333';

function reservaBase(overrides = {}) {
  return {
    id: RESERVA_ID,
    user_id: PAYER,
    sede_id: SEDE_ID,
    sede: 'La Meca',
    estado: 'completada',
    precio: 100,
    monto_pagado: 100,
    moneda: 'USD',
    pago_estado: 'pagado',
    partido_id: PARTIDO_ID,
    ...overrides,
  };
}

function participant(userId, overrides = {}) {
  return {
    match_type: MATCH_TYPES.CASUAL,
    match_id: String(PARTIDO_ID),
    user_id: userId,
    role: userId === PAYER ? MATCH_PARTICIPANT_ROLES.ORGANIZER : MATCH_PARTICIPANT_ROLES.PARTICIPANT,
    attendance_status: MATCH_ATTENDANCE_STATUS.CONFIRMED,
    ...overrides,
  };
}

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
      then(resolve, reject) {
        const filters = { ...this._filters };
        this._filters = {};
        const filtered = rows.filter((row) =>
          Object.entries(filters).every(([key, val]) => String(row[key]) === String(val)),
        );
        Promise.resolve({ data: filtered, error: null }).then(resolve, reject);
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
        const filters = { ...this._filters };
        return {
          eq(field, value) {
            filters[field] = value;
            return this;
          },
          select() { return this; },
          single: async () => {
            const row = rows.find((r) =>
              Object.entries(filters).every(([k, v]) => String(r[k]) === String(v)),
            );
            if (row) Object.assign(row, payload);
            return { data: row ?? null, error: null };
          },
        };
      },
    },
  };
}

function buildRewardEventsStore(initial = []) {
  const rows = [...initial];
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
      then(resolve) {
        const filters = { ...this._filters };
        this._filters = {};
        const matched = rows.filter((row) =>
          Object.entries(filters).every(([k, v]) => String(row[k]) === String(v)),
        );
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
          then(resolve) {
            const row = rows.find((r) =>
              Object.entries(filters).every(([k, v]) => String(r[k]) === String(v)),
            );
            if (row) Object.assign(row, payload);
            resolve({ error: null });
          },
        };
        return builder;
      },
    },
  };
}

function buildMovimientosStore() {
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
      gt() { return this; },
      gte() { return this; },
      lte() { return this; },
      limit() { return this; },
      maybeSingle: async function maybeSingle() {
        const filters = { ...this._filters };
        this._filters = {};
        const row = rows.find((r) =>
          Object.entries(filters).every(([k, v]) => String(r[k]) === String(v)),
        );
        return { data: row ?? null, error: null };
      },
      insert(payload) {
        const row = { ...payload, id: `mov-${rows.length + 1}` };
        rows.push(row);
        return {
          select() { return this; },
          single: async () => ({ data: row, error: null }),
        };
      },
      then(resolve) {
        Promise.resolve({ data: [], error: null }).then(resolve);
      },
    },
  };
}

function buildSaldoMock(userId, disponible = 100) {
  let saldo = { id: 's1', user_id: userId, disponible, historico_total: disponible };
  return {
    select() { return this; },
    eq() { return this; },
    maybeSingle: async () => ({ data: saldo, error: null }),
    update(payload) {
      saldo = { ...saldo, ...payload };
      return {
        eq() { return this; },
        select() { return this; },
        single: async () => ({ data: saldo, error: null }),
      };
    },
  };
}

function buildPadcoinsSupabase({
  participantsStore,
  rewardStore,
  movStore,
  saldoUserId = PAYER,
  saldoDisponible = 1000,
} = {}) {
  const participants = participantsStore ?? buildParticipantsStore();
  const rewards = rewardStore ?? buildRewardEventsStore();
  const movimientos = movStore ?? buildMovimientosStore();

  return {
    participants,
    rewards,
    movimientos,
    admin: {
      from(table) {
        if (table === 'match_participants') return participants.handler;
        if (table === 'match_reward_events') return rewards.handler;
        if (table === 'padcoins_movimientos') return movimientos.handler;
        if (table === 'padcoins_saldo') return buildSaldoMock(saldoUserId, saldoDisponible);
        if (table === 'padcoins_sede_config') {
          return {
            select() { return this; },
            eq() { return this; },
            maybeSingle: async () => ({
              data: {
                id: 'cfg-1',
                sede_id: SEDE_ID,
                activo: true,
                participa: true,
                fecha_inicio: null,
                fecha_fin: null,
              },
              error: null,
            }),
          };
        }
        if (table === 'padcoins_global_config') {
          return {
            select() { return this; },
            order: async () => ({ data: [], error: null }),
          };
        }
        if (table === 'padcoins_campaigns' || table === 'padcoins_campaign_applications') {
          return {
            select() { return this; },
            eq() { return this; },
            maybeSingle: async () => ({ data: null, error: null }),
            order: async () => ({ data: [], error: null }),
          };
        }
        return {
          select() { return this; },
          eq() { return this; },
          maybeSingle: async () => ({ data: null, error: null }),
        };
      },
    },
  };
}

const RESERVATION_CONFIG = {
  reserva_confirmada_fallback: 30,
  porcentaje_devolucion_reserva: 5,
  padcoins_por_usd_equivalente: 100,
  modo_calculo_reserva: 'porcentaje_valor_pagado',
};

describe('padcoinsParticipationAbuse — cron y pagador', () => {
  it('reserva pagada (MP/Stripe) no acredita al pagador al completarse', async () => {
    const result = await processReservationPadcoinsOnComplete(
      {},
      reservaBase({ partido_id: null, pago_estado: 'pagado', monto_pagado: 50 }),
      null,
    );
    assert.equal(result.acreditado, false);
    assert.equal(result.reason, 'participation_requires_confirmed_attendance');
    assert.equal(result.omission_reason, 'no_direct_payer_credit');
  });

  it('reserva con partido vinculado difiere hasta asistencia confirmada', async () => {
    const participantsStore = buildParticipantsStore();
    const supabase = buildPadcoinsSupabase({ participantsStore });

    const result = await processReservationPadcoinsOnComplete(
      supabase.admin,
      reservaBase(),
      { id: PARTIDO_ID },
    );

    assert.equal(result.mode, RESERVATION_REWARD_MODES.MATCH_DEFERRED);
    assert.equal(result.acreditado, false);
    assert.equal(result.reason, 'match_linked_padcoins_deferred');
    assert.equal(participantsStore.rows.length, 1);
  });

  it('acreditarPadcoinsPorReservaCompletada bloquea crédito directo por defecto', async () => {
    const result = await acreditarPadcoinsPorReservaCompletada({}, String(RESERVA_ID), {
      reserva: reservaBase(),
    });
    assert.equal(result.acreditado, false);
    assert.equal(result.reason, 'participation_requires_confirmed_attendance');
  });

  it('evaluateReservationRewardMode usa attendance_only sin partido', () => {
    assert.equal(
      evaluateReservationRewardMode({ id: RESERVA_ID, partido_id: null }, null),
      RESERVATION_REWARD_MODES.ATTENDANCE_ONLY,
    );
  });
});

describe('padcoinsParticipationAbuse — asistencia confirmada', () => {
  it('pagador que también juega puede acreditarse si está en match_participants', async () => {
    const participants = [
      participant(PAYER),
      participant(PLAYER_A, { attendance_status: MATCH_ATTENDANCE_STATUS.PENDING }),
    ];
    const supabase = buildPadcoinsSupabase({
      participantsStore: buildParticipantsStore(participants),
    });

    const result = await creditIndividualAttendancePadcoins(supabase.admin, {
      matchId: PARTIDO_ID,
      userId: PAYER,
      reserva: reservaBase(),
      participants,
      reservationConfig: RESERVATION_CONFIG,
      campaign: null,
    });

    assert.equal(result.processed, true);
    assert.equal(result.acreditado, true);
    assert.ok(result.padcoins > 0);
    assert.equal(supabase.rewards.rows.length, 1);
    assert.equal(supabase.movimientos.rows.length, 1);
  });

  it('pagador que reserva para terceros no recibe PadCoins si no está en el partido', async () => {
    const participants = [participant(PLAYER_A), participant(PLAYER_B)];
    const supabase = buildPadcoinsSupabase();

    const result = await creditIndividualAttendancePadcoins(supabase.admin, {
      matchId: PARTIDO_ID,
      userId: PAYER,
      reserva: reservaBase(),
      participants,
    });

    assert.equal(result.acreditado, false);
    assert.equal(result.reason, 'pagador_no_participa');
    assert.equal(result.omission_reason, 'payer_not_identified_as_player');
  });

  it('varios jugadores confirmados comparten pool sin duplicar al pagador ausente', async () => {
    const participants = [participant(PLAYER_A), participant(PLAYER_B)];
    const supabase = buildPadcoinsSupabase({
      participantsStore: buildParticipantsStore(participants),
    });

    const first = await creditIndividualAttendancePadcoins(supabase.admin, {
      matchId: PARTIDO_ID,
      userId: PLAYER_A,
      reserva: reservaBase(),
      participants,
      reservationConfig: RESERVATION_CONFIG,
    });
    const second = await creditIndividualAttendancePadcoins(supabase.admin, {
      matchId: PARTIDO_ID,
      userId: PLAYER_B,
      reserva: reservaBase(),
      participants,
      reservationConfig: RESERVATION_CONFIG,
    });

    assert.equal(first.acreditado, true);
    assert.equal(second.acreditado, true);
    assert.equal(supabase.movimientos.rows.length, 2);
    assert.equal(
      supabase.movimientos.rows.some((row) => row.user_id === PAYER),
      false,
    );
  });

  it('confirmación repetida es idempotente por source_key', async () => {
    const sourceKey = buildAttendanceParticipantPadcoinsSourceKey(PARTIDO_ID, PLAYER_A);
    const rewardStore = buildRewardEventsStore([{
      id: 9,
      source_key: sourceKey,
      status: MATCH_REWARD_EVENT_STATUS.CREDITED,
      amount: 30,
      user_id: PLAYER_A,
    }]);

    const dup = await preventDuplicateRewardBySourceKey(
      { from: () => rewardStore.handler },
      sourceKey,
    );
    assert.equal(dup.duplicate, true);
    assert.equal(dup.event.amount, 30);
  });

  it('reserva cancelada antes de acreditar bloquea participación', async () => {
    const supabase = buildPadcoinsSupabase();
    const result = await creditIndividualAttendancePadcoins(supabase.admin, {
      matchId: PARTIDO_ID,
      userId: PLAYER_A,
      reserva: reservaBase({ estado: 'cancelada' }),
      participants: [participant(PLAYER_A)],
    });
    assert.equal(result.acreditado, false);
    assert.equal(result.reason, 'reserva_no_acreditable');
  });
});

describe('padcoinsParticipationAbuse — reversión participación', () => {
  it('revierte match_reward_events acreditados por reserva cancelada', async () => {
    const sourceKey = buildAttendanceParticipantPadcoinsSourceKey(PARTIDO_ID, PLAYER_A);
    const rewardStore = buildRewardEventsStore([{
      id: 1,
      reserva_id: RESERVA_ID,
      match_id: String(PARTIDO_ID),
      user_id: PLAYER_A,
      reward_type: MATCH_REWARD_TYPES.PADCOINS,
      status: MATCH_REWARD_EVENT_STATUS.CREDITED,
      amount: 30,
      source_key: sourceKey,
    }]);
    const movStore = buildMovimientosStore();
    const supabase = buildPadcoinsSupabase({
      rewardStore,
      movStore,
      saldoUserId: PLAYER_A,
      saldoDisponible: 100,
    });

    const result = await revertirPadcoinsParticipacionPorReserva(supabase.admin, RESERVA_ID, {
      reserva: reservaBase({ estado: 'cancelada' }),
    });

    assert.equal(result.revertido, true);
    assert.equal(result.participation_reversals.length, 1);
    assert.equal(result.participation_reversals[0].revertido, true);
    assert.equal(rewardStore.rows[0].status, MATCH_REWARD_EVENT_STATUS.REVERSED);
    assert.equal(movStore.rows.length, 1);
    assert.equal(movStore.rows[0].tipo, PADCOINS_MOVEMENT_TYPES.REVERSE);
  });
});

describe('padcoinsParticipationAbuse — reservas sin jugadores identificados', () => {
  it('jugador no listado en match_participants no acredita', async () => {
    const supabase = buildPadcoinsSupabase();
    const result = await creditIndividualAttendancePadcoins(supabase.admin, {
      matchId: PARTIDO_ID,
      userId: PLAYER_A,
      reserva: reservaBase(),
      participants: [],
    });

    assert.equal(result.acreditado, false);
    assert.equal(result.reason, 'not_in_match');
  });
});
