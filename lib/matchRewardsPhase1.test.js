import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  evaluateReservationRewardMode,
  buildReservationOrganizerSourceKey,
  buildMatchParticipantPadcoinsSourceKey,
  splitMatchPadcoinsPool,
  processReservationPadcoinsOnComplete,
  creditValidatedMatchPadcoins,
  preventDuplicateRewardBySourceKey,
  MATCH_REWARDS_ORGANIZER_BONUS_PERCENT,
} from '../src/matches/matchRewardsService.js';
import {
  ensureOrganizerParticipantFromReserva,
  getEligibleParticipantsForRewards,
  resolveEligibleParticipantsForRewards,
  upsertMatchParticipant,
} from '../src/matches/matchParticipantsService.js';
import {
  MATCH_ATTENDANCE_STATUS,
  MATCH_PARTICIPANT_ROLES,
  MATCH_REWARD_STATUS,
  RESERVATION_REWARD_MODES,
} from '../src/matches/matchParticipantsConstants.js';
import { PADCOINS_MOVEMENT_TYPES } from '../src/padcoins/padcoinsConfig.js';

const USER_ORG = 'aaaaaaaa-bbbb-cccc-dddd-111111111111';
const USER_P1 = 'aaaaaaaa-bbbb-cccc-dddd-222222222222';
const USER_P2 = 'aaaaaaaa-bbbb-cccc-dddd-333333333333';
const RESERVA_ID = 101;
const PARTIDO_ID = 55;

describe('matchRewards Fase 1 — evaluateReservationRewardMode', () => {
  it('reserva sin partido → organizer_only', () => {
    assert.equal(
      evaluateReservationRewardMode({ id: 1, partido_id: null }, null),
      RESERVATION_REWARD_MODES.ORGANIZER_ONLY,
    );
  });

  it('reserva con partido_id → match_deferred', () => {
    assert.equal(
      evaluateReservationRewardMode({ id: 1, partido_id: 99 }, null),
      RESERVATION_REWARD_MODES.MATCH_DEFERRED,
    );
  });

  it('reserva con partido resuelto por cron → match_deferred', () => {
    assert.equal(
      evaluateReservationRewardMode({ id: 1 }, { id: 42 }),
      RESERVATION_REWARD_MODES.MATCH_DEFERRED,
    );
  });
});

describe('matchParticipants — elegibilidad', () => {
  it('participante sin user_id no es elegible', () => {
    const eligible = getEligibleParticipantsForRewards([
      { user_id: null, attendance_status: MATCH_ATTENDANCE_STATUS.ADMIN_VALIDATED },
      { user_id: 'not-a-uuid', attendance_status: MATCH_ATTENDANCE_STATUS.CONFIRMED },
    ]);
    assert.equal(eligible.length, 0);
  });

  it('pending no es elegible', () => {
    const eligible = getEligibleParticipantsForRewards([
      { user_id: USER_P1, attendance_status: MATCH_ATTENDANCE_STATUS.PENDING },
    ]);
    assert.equal(eligible.length, 0);
  });

  it('admin_validated es elegible', () => {
    const eligible = getEligibleParticipantsForRewards([
      { user_id: USER_P1, attendance_status: MATCH_ATTENDANCE_STATUS.ADMIN_VALIDATED },
    ]);
    assert.equal(eligible.length, 1);
  });

  it('si solo organizador validado, solo él es elegible', () => {
    const participants = [
      {
        user_id: USER_ORG,
        role: MATCH_PARTICIPANT_ROLES.ORGANIZER,
        attendance_status: MATCH_ATTENDANCE_STATUS.ADMIN_VALIDATED,
      },
      {
        user_id: USER_P1,
        role: MATCH_PARTICIPANT_ROLES.PARTICIPANT,
        attendance_status: MATCH_ATTENDANCE_STATUS.PENDING,
      },
    ];
    const resolved = resolveEligibleParticipantsForRewards(participants);
    assert.equal(resolved.length, 1);
    assert.equal(resolved[0].user_id, USER_ORG);
  });

  it('con participantes validados, incluye a todos los elegibles', () => {
    const participants = [
      {
        user_id: USER_ORG,
        role: MATCH_PARTICIPANT_ROLES.ORGANIZER,
        attendance_status: MATCH_ATTENDANCE_STATUS.ADMIN_VALIDATED,
      },
      {
        user_id: USER_P1,
        role: MATCH_PARTICIPANT_ROLES.PARTICIPANT,
        attendance_status: MATCH_ATTENDANCE_STATUS.ADMIN_VALIDATED,
      },
    ];
    const resolved = resolveEligibleParticipantsForRewards(participants);
    assert.equal(resolved.length, 2);
  });
});

describe('matchRewards — splitMatchPadcoinsPool', () => {
  it('solo organizador recibe 100%', () => {
    const shares = splitMatchPadcoinsPool(250, [
      {
        user_id: USER_ORG,
        role: MATCH_PARTICIPANT_ROLES.ORGANIZER,
        attendance_status: MATCH_ATTENDANCE_STATUS.ADMIN_VALIDATED,
      },
    ], USER_ORG);
    assert.equal(shares.length, 1);
    assert.equal(shares[0].amount, 250);
    assert.equal(shares[0].kind, 'organizer_only');
  });

  it('varios participantes reparten pool con bonus organizador', () => {
    const shares = splitMatchPadcoinsPool(100, [
      { user_id: USER_ORG, role: MATCH_PARTICIPANT_ROLES.ORGANIZER },
      { user_id: USER_P1, role: MATCH_PARTICIPANT_ROLES.PARTICIPANT },
      { user_id: USER_P2, role: MATCH_PARTICIPANT_ROLES.PARTICIPANT },
    ], USER_ORG);

    const total = shares.reduce((sum, s) => sum + s.amount, 0);
    assert.equal(total, 100);

    const orgShare = shares.find((s) => s.userId === USER_ORG);
    assert.ok(orgShare.amount >= Math.floor((100 * MATCH_REWARDS_ORGANIZER_BONUS_PERCENT) / 100));
  });
});

describe('matchRewards — source keys', () => {
  it('reservation organizer key estable', () => {
    assert.equal(
      buildReservationOrganizerSourceKey(42),
      'user|reservation|42|organizer',
    );
  });

  it('match participant key incluye userId para unicidad', () => {
    assert.equal(
      buildMatchParticipantPadcoinsSourceKey('casual', 7, USER_P1),
      `user|match|casual|7|padcoins|participant|${USER_P1}`,
    );
  });
});

function buildParticipantsStore() {
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
      order() { return this; },
      then(resolve, reject) {
        const filters = this._filters ?? {};
        this._filters = {};
        const filtered = rows.filter((row) =>
          Object.entries(filters).every(([key, val]) => row[key] === val),
        );
        Promise.resolve({ data: filtered, error: null }).then(resolve, reject);
      },
      maybeSingle: async function maybeSingle() {
        const filters = this._filters;
        this._filters = {};
        const row = rows.find((r) =>
          Object.entries(filters).every(([k, v]) => r[k] === v),
        );
        return { data: row ?? null, error: null };
      },
      single: async function single() {
        const result = await this.maybeSingle();
        if (!result.data) throw new Error('not found');
        return result;
      },
      insert(payload) {
        const row = { ...payload, id: nextId++, created_at: new Date().toISOString() };
        rows.push(row);
        return {
          select() { return this; },
          single: async () => ({ data: row, error: null }),
        };
      },
      update(payload) {
        const filters = this._filters;
        const row = rows.find((r) =>
          Object.entries(filters).every(([k, v]) => r[k] === v),
        );
        if (row) Object.assign(row, payload);
        return {
          eq(field, value) {
            filters[field] = value;
            return this;
          },
          select() { return this; },
          maybeSingle: async () => ({ data: row ?? null, error: null }),
          single: async () => ({ data: row, error: null }),
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
          Object.entries(filters).every(([k, v]) => r[k] === v),
        );
        if (row) Object.assign(row, payload);
        return {
          eq() { return this; },
          then(resolve) {
            resolve({ error: null });
          },
        };
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
      limit() { return this; },
      maybeSingle: async function maybeSingle() {
        const filters = this._filters;
        this._filters = {};
        const row = rows.find((r) =>
          Object.entries(filters).every(([k, v]) => r[k] === v),
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
    },
  };
}

function buildSaldoMock() {
  let disponible = 1000;
  return {
    select() { return this; },
    eq() { return this; },
    maybeSingle: async () => ({
      data: { id: 's1', user_id: USER_ORG, disponible, historico_total: 1000 },
      error: null,
    }),
    update(payload) {
      disponible = payload.disponible;
      return {
        eq() { return this; },
        select() { return this; },
        single: async () => ({
          data: { id: 's1', user_id: USER_ORG, disponible, historico_total: 1000 },
          error: null,
        }),
      };
    },
  };
}

describe('matchParticipants — ensureOrganizerParticipantFromReserva', () => {
  it('crea organizer con source reservation', async () => {
    const store = buildParticipantsStore();
    const supabaseAdmin = {
      from(table) {
        if (table === 'match_participants') return store.handler;
        throw new Error(`unexpected table ${table}`);
      },
    };

    const result = await ensureOrganizerParticipantFromReserva(supabaseAdmin, {
      reserva: { id: RESERVA_ID, user_id: USER_ORG, partido_id: PARTIDO_ID },
      partido: { id: PARTIDO_ID },
    });

    assert.equal(result.ok, true);
    assert.equal(result.created, true);
    assert.equal(store.rows.length, 1);
    assert.equal(store.rows[0].role, MATCH_PARTICIPANT_ROLES.ORGANIZER);
    assert.equal(store.rows[0].source, 'reservation');
    assert.equal(store.rows[0].reward_status, MATCH_REWARD_STATUS.PENDING);
  });
});

describe('matchRewards — processReservationPadcoinsOnComplete', () => {
  it('reserva sin partido mantiene modo organizer_only', async () => {
    const mode = evaluateReservationRewardMode(
      { id: RESERVA_ID, partido_id: null },
      null,
    );
    assert.equal(mode, RESERVATION_REWARD_MODES.ORGANIZER_ONLY);
  });

  it('reserva con partido vinculado no acredita automático', async () => {
    const participantsStore = buildParticipantsStore();
    let acreditacionLlamada = false;

    const supabaseAdmin = {
      from(table) {
        if (table === 'match_participants') return participantsStore.handler;
        if (table === 'match_reward_events') return buildRewardEventsStore().handler;
        if (table === 'padcoins_movimientos') {
          acreditacionLlamada = true;
          return buildMovimientosStore().handler;
        }
        throw new Error(`unexpected table ${table}`);
      },
    };

    const reserva = {
      id: RESERVA_ID,
      user_id: USER_ORG,
      sede_id: 1,
      partido_id: PARTIDO_ID,
      estado: 'completada',
    };

    const result = await processReservationPadcoinsOnComplete(
      supabaseAdmin,
      reserva,
      { id: PARTIDO_ID },
    );

    assert.equal(result.mode, RESERVATION_REWARD_MODES.MATCH_DEFERRED);
    assert.equal(result.acreditado, false);
    assert.equal(result.reason, 'match_linked_padcoins_deferred');
    assert.equal(acreditacionLlamada, false);
    assert.equal(participantsStore.rows.length, 1);
  });
});

describe('matchRewards — idempotencia eventos', () => {
  it('preventDuplicateRewardBySourceKey detecta duplicado', async () => {
    const store = buildRewardEventsStore();
    store.rows.push({
      id: 1,
      source_key: 'user|reservation|1|organizer',
      status: 'credited',
    });

    const supabaseAdmin = {
      from(table) {
        if (table === 'match_reward_events') return store.handler;
        throw new Error(`unexpected ${table}`);
      },
    };

    const check = await preventDuplicateRewardBySourceKey(
      supabaseAdmin,
      'user|reservation|1|organizer',
    );
    assert.equal(check.duplicate, true);
    assert.equal(check.event.id, 1);
  });
});

describe('matchRewards — creditValidatedMatchPadcoins idempotente', () => {
  it('doble ejecución no duplica PadCoins por referencia', async () => {
    const participantsStore = buildParticipantsStore();
    participantsStore.rows.push({
      id: 1,
      match_type: 'casual',
      match_id: String(PARTIDO_ID),
      user_id: USER_ORG,
      role: MATCH_PARTICIPANT_ROLES.ORGANIZER,
      attendance_status: MATCH_ATTENDANCE_STATUS.ADMIN_VALIDATED,
      reward_status: MATCH_REWARD_STATUS.ELIGIBLE,
    });

    const rewardStore = buildRewardEventsStore();
    const movStore = buildMovimientosStore();

    const supabaseAdmin = {
      from(table) {
        if (table === 'match_participants') return participantsStore.handler;
        if (table === 'match_reward_events') return rewardStore.handler;
        if (table === 'padcoins_movimientos') {
          return {
            select() { return this; },
            eq() { return this; },
            gt() { return this; },
            gte() { return this; },
            lte() { return this; },
            limit() { return this; },
            maybeSingle: async () => ({ data: null, error: null }),
            insert(payload) {
              movStore.rows.push({ ...payload, id: `mov-${movStore.rows.length + 1}` });
              return {
                select() { return this; },
                single: async () => ({
                  data: movStore.rows[movStore.rows.length - 1],
                  error: null,
                }),
              };
            },
            then(resolve) {
              Promise.resolve({ data: [], error: null }).then(resolve);
            },
          };
        }
        if (table === 'padcoins_saldo') return buildSaldoMock();
        if (table === 'padcoins_sede_config') {
          return {
            select() { return this; },
            eq() { return this; },
            maybeSingle: async () => ({
              data: {
                id: 'cfg-1',
                sede_id: 1,
                activo: true,
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
    };

    const reserva = {
      id: RESERVA_ID,
      user_id: USER_ORG,
      sede_id: 1,
      estado: 'completada',
      monto_pagado: 50,
      moneda: 'USD',
      pago_estado: 'pagado',
    };

    const creditOptions = {
      reservationConfig: {
        porcentaje_devolucion_reserva: 5,
        padcoins_por_usd_equivalente: 100,
        modo_calculo_reserva: 'porcentaje_valor_pagado',
        reserva_confirmada_fallback: 30,
      },
    };

    const first = await creditValidatedMatchPadcoins(supabaseAdmin, {
      matchId: PARTIDO_ID,
      reserva,
      organizerUserId: USER_ORG,
      ...creditOptions,
    });

    const second = await creditValidatedMatchPadcoins(supabaseAdmin, {
      matchId: PARTIDO_ID,
      reserva,
      organizerUserId: USER_ORG,
      ...creditOptions,
    });

    assert.equal(first.acreditado, true, `first reason: ${first.reason ?? 'n/a'}`);
    assert.equal(second.acreditado, false);
    const earnMovs = movStore.rows.filter((m) => m.tipo === PADCOINS_MOVEMENT_TYPES.EARN);
    assert.equal(earnMovs.length, 1);
  });
});

describe('matchRewards Fase 1 — no ranking', () => {
  it('creditValidatedMatchPadcoins no crea eventos ranking', async () => {
    const rewardStore = buildRewardEventsStore();
    const participantsStore = buildParticipantsStore();
    participantsStore.rows.push({
      id: 1,
      match_type: 'casual',
      match_id: String(PARTIDO_ID),
      user_id: USER_ORG,
      role: MATCH_PARTICIPANT_ROLES.ORGANIZER,
      attendance_status: MATCH_ATTENDANCE_STATUS.ADMIN_VALIDATED,
    });

    const supabaseAdmin = {
      from(table) {
        if (table === 'match_reward_events') return rewardStore.handler;
        if (table === 'match_participants') return participantsStore.handler;
        if (table === 'padcoins_movimientos') {
          return {
            select() { return this; },
            eq() { return this; },
            limit() { return this; },
            maybeSingle: async () => ({ data: null, error: null }),
          };
        }
        if (table === 'padcoins_sede_config') {
          return {
            select() { return this; },
            eq() { return this; },
            maybeSingle: async () => ({ data: { activo: true }, error: null }),
          };
        }
        if (table === 'padcoins_global_config') {
          return {
            select() { return this; },
            eq() { return this; },
            maybeSingle: async () => ({
              data: {
                reserva_confirmada_fallback: 30,
                porcentaje_devolucion_reserva: 5,
                padcoins_por_usd_equivalente: 100,
                modo_calculo_reserva: 'percentage_paid',
              },
              error: null,
            }),
          };
        }
        if (table === 'padcoins_campaigns') {
          return {
            select() { return this; },
            eq() { return this; },
            maybeSingle: async () => ({ data: null, error: null }),
          };
        }
        throw new Error(`unexpected ${table}`);
      },
    };

    await creditValidatedMatchPadcoins(supabaseAdmin, {
      matchId: PARTIDO_ID,
      reserva: {
        id: RESERVA_ID,
        user_id: USER_ORG,
        sede_id: 1,
        estado: 'completada',
        monto_pagado: 50,
        moneda: 'USD',
        pago_estado: 'pagado',
      },
    }).catch(() => null);

    const rankingEvents = rewardStore.rows.filter((e) => e.reward_type === 'ranking');
    assert.equal(rankingEvents.length, 0);
  });
});
