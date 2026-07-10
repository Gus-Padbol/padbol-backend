import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  MATCH_ATTENDANCE_STATUS,
  MATCH_PARTICIPANT_ROLES,
  MATCH_PARTICIPANT_SOURCES,
  MATCH_REWARD_STATUS,
  MATCH_REWARD_TYPES,
} from '../src/matches/matchParticipantsConstants.js';
import { PADCOINS_MOVEMENT_TYPES } from '../src/padcoins/padcoinsConfig.js';
import {
  maybeProcessCasualPadcoinsAfterScoreboardTerminated,
  processScoreboardPadcoinsAfterFinished,
  collectScoreboardParticipantCandidates,
  resolveCasualLinkFromScoreboard,
} from '../src/matches/scoreboardMatchRewardsService.js';

const TEST_CREDIT_OPTIONS = {
  reservationConfig: {
    porcentaje_devolucion_reserva: 5,
    padcoins_por_usd_equivalente: 100,
    modo_calculo_reserva: 'porcentaje_valor_pagado',
    reserva_confirmada_fallback: 30,
  },
};

const SCOREBOARD_ID = 'sb-f2-001';
const PARTIDO_ID = 55;
const RESERVA_ID = 101;
const USER_ORG = 'aaaaaaaa-bbbb-cccc-dddd-111111111111';
const USER_P1 = 'aaaaaaaa-bbbb-cccc-dddd-222222222222';
const USER_P2 = 'aaaaaaaa-bbbb-cccc-dddd-333333333333';
const USER_P3 = 'aaaaaaaa-bbbb-cccc-dddd-444444444444';
const USER_P4 = 'aaaaaaaa-bbbb-cccc-dddd-555555555555';

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
        try {
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
          if (filters.id != null) {
            matched = matched.filter((r) => String(r.id) === String(filters.id));
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
        const filters = this._filters;
        const row = rows.find((r) =>
          Object.entries(filters).every(([k, v]) => String(r[k]) === String(v)),
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
          then(resolve) { resolve({ error: null }); },
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
      gt() { return this; },
      gte() { return this; },
      lte() { return this; },
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
    insert() {
      return {
        select() { return this; },
        single: async () => ({ data: { id: 's1' }, error: null }),
      };
    },
    update(payload) {
      if (payload.disponible != null) disponible = payload.disponible;
      return {
        eq() { return this; },
        select() { return this; },
        single: async () => ({ data: { disponible }, error: null }),
      };
    },
  };
}

function createPhase2Mock({
  tempJugadores = [],
  equipoA = [],
  equipoB = [],
  partidoJugadores = [],
  reserva = null,
  partido = null,
} = {}) {
  const participantsStore = buildParticipantsStore();
  const rewardStore = buildRewardEventsStore();
  const movStore = buildMovimientosStore();

  const reservaRow = reserva ?? {
    id: RESERVA_ID,
    user_id: USER_ORG,
    sede_id: 1,
    estado: 'completada',
    monto_pagado: 100,
    moneda: 'USD',
    pago_estado: 'pagado',
    partido_id: PARTIDO_ID,
  };

  const partidoRow = partido ?? {
    id: PARTIDO_ID,
    reserva_id: RESERVA_ID,
    capitan_user_id: USER_ORG,
  };

  const supabaseAdmin = {
    from(table) {
      if (table === 'scoreboard_jugadores_temp') {
        return {
          select() { return this; },
          eq(_field, partidoId) {
            this._partidoId = partidoId;
            return this;
          },
          then(resolve) {
            const rows = tempJugadores.filter((r) => r.partido_id === this._partidoId || !r.partido_id);
            resolve({ data: rows, error: null });
          },
        };
      }
      if (table === 'partidos_abiertos_jugadores') {
        return {
          select() { return this; },
          eq() { return this; },
          then(resolve) {
            resolve({ data: partidoJugadores, error: null });
          },
        };
      }
      if (table === 'partidos_abiertos') {
        const api = {
          _id: null,
          select() { return api; },
          eq(_f, id) {
            api._id = id;
            return api;
          },
          maybeSingle: async function maybeSingle() {
            if (Number(api._id) === Number(partidoRow?.id)) {
              return { data: partidoRow, error: null };
            }
            return { data: null, error: null };
          },
        };
        return api;
      }
      if (table === 'reservas') {
        const api = {
          _id: null,
          select() { return api; },
          eq(_f, id) {
            api._id = id;
            return api;
          },
          maybeSingle: async function maybeSingle() {
            if (Number(api._id) === Number(reservaRow?.id)) {
              return { data: reservaRow, error: null };
            }
            return { data: null, error: null };
          },
        };
        return api;
      }
      if (table === 'match_participants') return participantsStore.handler;
      if (table === 'match_reward_events') return rewardStore.handler;
      if (table === 'padcoins_movimientos') return movStore.handler;
      if (table === 'padcoins_saldo') return buildSaldoMock();
      if (table === 'padcoins_sede_config') {
        return {
          select() { return this; },
          eq() { return this; },
          maybeSingle: async () => ({
            data: { id: 'cfg', sede_id: 1, activo: true, fecha_inicio: null, fecha_fin: null },
            error: null,
          }),
        };
      }
      if (table === 'padcoins_global_config') {
        return {
          select() { return this; },
          order: async () => ({
            data: [{
              reserva_confirmada_fallback: 30,
              porcentaje_devolucion_reserva: 5,
              padcoins_por_usd_equivalente: 100,
              modo_calculo_reserva: 'porcentaje_valor_pagado',
            }],
            error: null,
          }),
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

  const scoreboard = {
    id: SCOREBOARD_ID,
    partido_abierto_id: PARTIDO_ID,
    reserva_id: RESERVA_ID,
    estado: 'terminado',
    sets_a: 2,
    sets_b: 0,
    games_a: 6,
    games_b: 4,
    score_a: 0,
    score_b: 0,
    historial_sets: [],
    equipo_a_jugadores: equipoA,
    equipo_b_jugadores: equipoB,
  };

  return {
    supabaseAdmin,
    scoreboard,
    participantsStore,
    rewardStore,
    movStore,
  };
}

describe('scoreboard PadCoins Fase 2 — collectScoreboardParticipantCandidates', () => {
  it('solo incluye jugadores con user_id', async () => {
    const { supabaseAdmin, scoreboard } = createPhase2Mock({
      tempJugadores: [
        { user_id: USER_P1, equipo: 'a' },
        { user_id: null, equipo: 'a', nombre: 'Anónimo' },
      ],
      equipoA: [{ nombre: 'Sin UUID' }],
      equipoB: [{ user_id: USER_P2, nombre: 'B1' }],
    });

    const result = await collectScoreboardParticipantCandidates(supabaseAdmin, scoreboard);
    assert.equal(result.candidates.length, 2);
    assert.equal(result.skipped_no_user_id, 2);
    assert.ok(result.candidates.some((c) => c.user_id === USER_P1));
    assert.ok(result.candidates.some((c) => c.user_id === USER_P2));
  });
});

describe('scoreboard PadCoins Fase 2 — processScoreboardPadcoinsAfterFinished', () => {
  it('scoreboard casual con 4 user_id acredita PadCoins una vez', async () => {
    const { supabaseAdmin, scoreboard, movStore, participantsStore } = createPhase2Mock({
      tempJugadores: [
        { user_id: USER_ORG, equipo: 'a' },
        { user_id: USER_P1, equipo: 'a' },
        { user_id: USER_P2, equipo: 'b' },
        { user_id: USER_P3, equipo: 'b' },
      ],
    });

    const result = await processScoreboardPadcoinsAfterFinished(supabaseAdmin, scoreboard, {
      creditOptions: TEST_CREDIT_OPTIONS,
    });

    assert.equal(result.acreditado, true);
    assert.ok(result.total_padcoins > 0);
    const earnMovs = movStore.rows.filter((m) => m.tipo === PADCOINS_MOVEMENT_TYPES.EARN);
    assert.ok(earnMovs.length >= 1);
    assert.ok(participantsStore.rows.length >= 4);
    assert.ok(
      participantsStore.rows.every(
        (p) => p.source === MATCH_PARTICIPANT_SOURCES.SCOREBOARD
          || p.source === MATCH_PARTICIPANT_SOURCES.RESERVATION,
      ),
    );
  });

  it('segunda ejecución no duplica PadCoins', async () => {
    const { supabaseAdmin, scoreboard, movStore } = createPhase2Mock({
      tempJugadores: [
        { user_id: USER_ORG, equipo: 'a' },
        { user_id: USER_P1, equipo: 'b' },
      ],
    });

    const first = await processScoreboardPadcoinsAfterFinished(supabaseAdmin, scoreboard, {
      creditOptions: TEST_CREDIT_OPTIONS,
    });
    const earnAfterFirst = movStore.rows.filter((m) => m.tipo === PADCOINS_MOVEMENT_TYPES.EARN).length;

    const second = await processScoreboardPadcoinsAfterFinished(supabaseAdmin, scoreboard, {
      creditOptions: TEST_CREDIT_OPTIONS,
    });
    const earnAfterSecond = movStore.rows.filter((m) => m.tipo === PADCOINS_MOVEMENT_TYPES.EARN).length;

    assert.equal(first.acreditado, true);
    assert.equal(second.acreditado, false);
    assert.ok(earnAfterFirst >= 1);
    assert.equal(earnAfterSecond, earnAfterFirst);
  });

  it('scoreboard torneo no acredita PadCoins casual', async () => {
    const { supabaseAdmin, scoreboard } = createPhase2Mock();
    scoreboard.partido_torneo_id = 999;
    scoreboard.partido_abierto_id = null;

    const result = await processScoreboardPadcoinsAfterFinished(supabaseAdmin, scoreboard, {
      creditOptions: TEST_CREDIT_OPTIONS,
    });
    assert.equal(result.skipped, true);
    assert.equal(result.reason, 'torneo_out_of_scope');
  });

  it('scoreboard reserva_id sin partido_abierto documentado como skip', async () => {
    const { supabaseAdmin } = createPhase2Mock({
      reserva: {
        id: RESERVA_ID,
        user_id: USER_ORG,
        sede_id: 1,
        estado: 'completada',
        partido_id: null,
      },
      partido: null,
    });

    const scoreboard = {
      id: SCOREBOARD_ID,
      reserva_id: RESERVA_ID,
      partido_abierto_id: null,
      estado: 'terminado',
      sets_a: 2,
      sets_b: 1,
    };

    const link = await resolveCasualLinkFromScoreboard(supabaseAdmin, scoreboard);
    assert.equal(link.partidoId, null);
    assert.equal(link.reason, 'reserva_sin_partido_abierto');

    const result = await processScoreboardPadcoinsAfterFinished(supabaseAdmin, scoreboard, {
      creditOptions: TEST_CREDIT_OPTIONS,
    });
    assert.equal(result.skipped, true);
    assert.equal(result.reason, 'reserva_sin_partido_abierto');
  });

  it('scoreboard sin participantes identificados hace skip seguro', async () => {
    const { supabaseAdmin, scoreboard } = createPhase2Mock({
      tempJugadores: [{ user_id: null, nombre: 'Anónimo', equipo: 'a' }],
    });

    const result = await processScoreboardPadcoinsAfterFinished(supabaseAdmin, scoreboard, {
      creditOptions: TEST_CREDIT_OPTIONS,
    });
    assert.equal(result.acreditado, false);
    assert.equal(result.reason, 'sin_participantes_identificados');
  });

  it('no crea eventos ranking', async () => {
    const { supabaseAdmin, scoreboard, rewardStore } = createPhase2Mock({
      tempJugadores: [{ user_id: USER_ORG, equipo: 'a' }],
    });

    await processScoreboardPadcoinsAfterFinished(supabaseAdmin, scoreboard, {
      creditOptions: TEST_CREDIT_OPTIONS,
    });
    const rankingEvents = rewardStore.rows.filter((e) => e.reward_type === MATCH_REWARD_TYPES.RANKING);
    assert.equal(rankingEvents.length, 0);
  });
});

describe('scoreboard PadCoins Fase 2 — hook terminado', () => {
  it('maybeProcessCasualPadcoinsAfterScoreboardTerminated solo en transición a terminado', async () => {
    let calls = 0;
    const saved = { id: SCOREBOARD_ID, estado: 'terminado', partido_abierto_id: PARTIDO_ID, reserva_id: RESERVA_ID };

    await maybeProcessCasualPadcoinsAfterScoreboardTerminated({}, saved, 'en_curso', {
      processScoreboardPadcoinsAfterFinished: async () => {
        calls += 1;
        return { ok: true, acreditado: true };
      },
    });

    assert.equal(calls, 1);

    await maybeProcessCasualPadcoinsAfterScoreboardTerminated({}, saved, 'terminado', {
      processScoreboardPadcoinsAfterFinished: async () => {
        calls += 1;
        return { ok: true };
      },
    });

    assert.equal(calls, 1);
  });

  it('hook ignora scoreboard torneo', async () => {
    let calls = 0;
    const saved = {
      id: SCOREBOARD_ID,
      estado: 'terminado',
      partido_torneo_id: 44,
    };

    const result = await maybeProcessCasualPadcoinsAfterScoreboardTerminated({}, saved, 'en_curso', {
      processScoreboardPadcoinsAfterFinished: async () => {
        calls += 1;
        return { ok: true };
      },
    });

    assert.equal(calls, 0);
    assert.equal(result.reason, 'torneo');
  });
});

describe('scoreboard PadCoins Fase 2 — participantes marcados elegibles', () => {
  it('sync scoreboard marca admin_validated y eligible', async () => {
    const { supabaseAdmin, scoreboard, participantsStore } = createPhase2Mock({
      tempJugadores: [{ user_id: USER_P1, equipo: 'a' }],
    });

    await processScoreboardPadcoinsAfterFinished(supabaseAdmin, scoreboard, {
      creditOptions: TEST_CREDIT_OPTIONS,
    });

    const p1 = participantsStore.rows.find((r) => r.user_id === USER_P1);
    assert.ok(p1);
    assert.equal(p1.attendance_status, MATCH_ATTENDANCE_STATUS.ADMIN_VALIDATED);
    assert.equal(p1.reward_status, MATCH_REWARD_STATUS.ELIGIBLE);
    assert.equal(p1.role, MATCH_PARTICIPANT_ROLES.PARTICIPANT);
  });
});
