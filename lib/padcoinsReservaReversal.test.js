import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  PADCOINS_MOVEMENT_TYPES,
} from '../src/padcoins/padcoinsConfig.js';
import {
  buildReservaReversalReferencia,
  fetchReservaEarnMovimiento,
  PADCOINS_RESERVA_REVERSAL_ACTIONS,
  revertirPadcoinsPorCancelacionTardeReserva,
  revertirPadcoinsPorNoShowReserva,
  revertirPadcoinsPorReservaIncumplimiento,
  yaFueRevertidaReserva,
} from '../src/padcoins/padcoinsReservaReversalService.js';
import {
  acreditarPadcoinsPorReservaCompletada,
  isReservaCancelada,
} from '../src/padcoins/padcoinsReservasService.js';
import {
  penalizarPadcoinsPorCancelacionTarde,
  penalizarPadcoinsPorNoShow,
} from '../src/padcoins/padcoinsPenaltiesService.js';
import { buildPadcoinsSourceKey } from '../src/padcoins/padcoinsIdempotencyService.js';

const USER_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const RESERVA_ID = '55';

const RESERVA_BASE = {
  id: 55,
  user_id: USER_ID,
  sede_id: 1,
  sede: 'La Meca',
  estado: 'confirmada',
  fecha: '2026-07-10',
  hora: '18:00',
  hora_inicio: '18:00',
};

const EARN_MOVIMIENTO = {
  id: 'earn-mov-1',
  user_id: USER_ID,
  tipo: PADCOINS_MOVEMENT_TYPES.EARN,
  monto: 350,
  referencia_tipo: 'reserva',
  referencia_id: RESERVA_ID,
};

const CAMPAIGN_APPLICATION = {
  id: 'camp-app-1',
  campaign_id: 'camp-1',
  reserva_id: RESERVA_ID,
  user_id: USER_ID,
  base_padcoins: 250,
  final_padcoins: 350,
};

function buildSaldoMock(initialDisponible, onUpdate) {
  let disponible = initialDisponible;
  return {
    select() { return this; },
    eq() { return this; },
    maybeSingle: async () => ({
      data: { id: 's1', user_id: USER_ID, disponible, historico_total: 500 },
      error: null,
    }),
    update(payload) {
      disponible = payload.disponible;
      if (onUpdate) onUpdate(payload);
      return {
        eq() { return this; },
        select() { return this; },
        single: async () => ({
          data: { id: 's1', user_id: USER_ID, disponible, historico_total: 500 },
          error: null,
        }),
      };
    },
  };
}

function buildMovimientosStore({
  earn = null,
  reversals = [],
  penalties = [],
} = {}) {
  const inserts = [];

  function matchRow(filters, row) {
    return Object.entries(filters).every(([key, value]) => row[key] === value);
  }

  function findExisting(filters) {
    if (filters.tipo === PADCOINS_MOVEMENT_TYPES.EARN && earn) {
      if (matchRow(filters, earn)) return earn;
    }
    const pool = filters.tipo === PADCOINS_MOVEMENT_TYPES.REVERSE ? reversals : penalties;
    return pool.find((row) => matchRow(filters, row)) ?? null;
  }

  return {
    inserts,
    handler: {
      select() { return this; },
      eq(field, value) {
        this._filters = this._filters ?? {};
        this._filters[field] = value;
        return this;
      },
      limit() { return this; },
      maybeSingle: async function maybeSingle() {
        const row = findExisting(this._filters ?? {});
        this._filters = {};
        return { data: row ?? null, error: null };
      },
      insert(payload) {
        inserts.push(payload);
        if (payload.tipo === PADCOINS_MOVEMENT_TYPES.REVERSE) {
          reversals.push({ ...payload, id: `rev-${reversals.length + 1}` });
        }
        return {
          select() { return this; },
          single: async () => ({ data: { ...payload, id: `mov-${inserts.length}` }, error: null }),
        };
      },
    },
  };
}

function buildSupabaseForReversal({
  earn = null,
  existingReversal = null,
  saldoDisponible = 500,
  campaignApplication = null,
  sedeActive = true,
} = {}) {
  const movStore = buildMovimientosStore({
    earn,
    reversals: existingReversal ? [existingReversal] : [],
  });

  return {
    movStore,
    from(table) {
      if (table === 'padcoins_movimientos') return movStore.handler;
      if (table === 'padcoins_saldo') return buildSaldoMock(saldoDisponible);
      if (table === 'padcoins_campaign_applications') {
        return {
          select() { return this; },
          eq() { return this; },
          limit() { return this; },
          maybeSingle: async () => ({
            data: campaignApplication,
            error: null,
          }),
        };
      }
      if (table === 'padcoins_sede_config') {
        return {
          select() { return this; },
          eq() { return this; },
          maybeSingle: async () => ({
            data: sedeActive
              ? { id: 'cfg-1', sede_id: 1, activo: true, rule_overrides: {} }
              : null,
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
      if (table === 'sedes') {
        return {
          select() { return this; },
          eq() { return this; },
          maybeSingle: async () => ({ data: { id: 1, nombre: 'La Meca' }, error: null }),
        };
      }
      if (table === 'reservas') {
        return {
          select() { return this; },
          eq() { return this; },
          maybeSingle: async () => ({ data: RESERVA_BASE, error: null }),
        };
      }
      return movStore.handler;
    },
  };
}

describe('padcoinsReservaReversalService — referencia e idempotencia', () => {
  it('buildReservaReversalReferencia usa reserva + acción', () => {
    assert.deepEqual(
      buildReservaReversalReferencia(55, PADCOINS_RESERVA_REVERSAL_ACTIONS.NO_SHOW),
      { referencia_tipo: 'reserva', referencia_id: '55:reversal_no_show' },
    );
  });

  it('yaFueRevertidaReserva detecta reversa previa', async () => {
    const supabaseAdmin = buildSupabaseForReversal({
      existingReversal: {
        id: 'rev-1',
        tipo: PADCOINS_MOVEMENT_TYPES.REVERSE,
        referencia_tipo: 'reserva',
        referencia_id: '55:reversal_cancelacion_tardia',
      },
    });
    assert.equal(
      await yaFueRevertidaReserva(
        supabaseAdmin,
        55,
        PADCOINS_RESERVA_REVERSAL_ACTIONS.CANCELACION_TARDIA,
      ),
      true,
    );
  });
});

describe('padcoinsReservaReversalService — reversa de earn', () => {
  it('sin acreditación previa no revierte', async () => {
    const supabaseAdmin = buildSupabaseForReversal({ earn: null });
    const result = await revertirPadcoinsPorCancelacionTardeReserva(supabaseAdmin, RESERVA_ID, {
      reserva: RESERVA_BASE,
    });
    assert.equal(result.revertido, false);
    assert.equal(result.reason, 'sin_acreditacion_previa');
    assert.equal(supabaseAdmin.movStore.inserts.length, 0);
  });

  it('reserva acreditada genera movimiento reverse con metadata', async () => {
    const supabaseAdmin = buildSupabaseForReversal({
      earn: EARN_MOVIMIENTO,
      campaignApplication: CAMPAIGN_APPLICATION,
    });

    const result = await revertirPadcoinsPorCancelacionTardeReserva(supabaseAdmin, RESERVA_ID, {
      reserva: RESERVA_BASE,
    });

    assert.equal(result.revertido, true);
    assert.equal(result.padcoins, 350);
    assert.equal(result.original_movement_id, 'earn-mov-1');
    assert.equal(supabaseAdmin.movStore.inserts.length, 1);

    const inserted = supabaseAdmin.movStore.inserts[0];
    assert.equal(inserted.tipo, PADCOINS_MOVEMENT_TYPES.REVERSE);
    assert.equal(inserted.monto, -350);
    assert.equal(inserted.referencia_tipo, 'reserva');
    assert.equal(inserted.referencia_id, '55:reversal_cancelacion_tardia');

    const expectedKey = buildPadcoinsSourceKey({
      userId: USER_ID,
      sourceType: 'reserva',
      sourceId: RESERVA_ID,
      action: PADCOINS_RESERVA_REVERSAL_ACTIONS.CANCELACION_TARDIA,
    });
    assert.equal(inserted.metadata.source_key, expectedKey);
    assert.equal(inserted.metadata.source_type, 'reserva');
    assert.equal(inserted.metadata.source_id, RESERVA_ID);
    assert.equal(inserted.metadata.action, PADCOINS_RESERVA_REVERSAL_ACTIONS.CANCELACION_TARDIA);
    assert.equal(
      inserted.metadata.calculation_detail.original_movement_id,
      'earn-mov-1',
    );
    assert.equal(inserted.metadata.calculation_detail.campaign_bonus_padcoins, 100);
  });

  it('no-show genera reversa con acción reversal_no_show', async () => {
    const supabaseAdmin = buildSupabaseForReversal({ earn: EARN_MOVIMIENTO });
    const result = await revertirPadcoinsPorNoShowReserva(supabaseAdmin, RESERVA_ID, {
      reserva: { ...RESERVA_BASE, estado: 'no_show' },
    });

    assert.equal(result.revertido, true);
    assert.equal(result.reversal_action, PADCOINS_RESERVA_REVERSAL_ACTIONS.NO_SHOW);
    assert.equal(
      supabaseAdmin.movStore.inserts[0].referencia_id,
      '55:reversal_no_show',
    );
  });

  it('reversa no se duplica si el evento llega dos veces', async () => {
    const existingReversal = {
      id: 'rev-existing',
      tipo: PADCOINS_MOVEMENT_TYPES.REVERSE,
      referencia_tipo: 'reserva',
      referencia_id: '55:reversal_cancelacion_tardia',
      monto: -350,
    };
    const supabaseAdmin = buildSupabaseForReversal({
      earn: EARN_MOVIMIENTO,
      existingReversal,
    });

    const result = await revertirPadcoinsPorReservaIncumplimiento(supabaseAdmin, RESERVA_ID, {
      reversalAction: PADCOINS_RESERVA_REVERSAL_ACTIONS.CANCELACION_TARDIA,
      reserva: RESERVA_BASE,
    });

    assert.equal(result.revertido, false);
    assert.equal(result.reason, 'ya_revertida');
    assert.equal(result.idempotent, true);
    assert.equal(supabaseAdmin.movStore.inserts.length, 0);
  });

  it('saldo insuficiente aplica reversa parcial y registra pendiente', async () => {
    const supabaseAdmin = buildSupabaseForReversal({
      earn: EARN_MOVIMIENTO,
      saldoDisponible: 120,
    });

    const result = await revertirPadcoinsPorCancelacionTardeReserva(supabaseAdmin, RESERVA_ID, {
      reserva: RESERVA_BASE,
    });

    assert.equal(result.revertido, true);
    assert.equal(result.partial, true);
    assert.equal(result.padcoins, 120);
    assert.equal(result.pendiente, 230);
    assert.equal(supabaseAdmin.movStore.inserts[0].monto, -120);
    assert.equal(
      supabaseAdmin.movStore.inserts[0].metadata.calculation_detail.clawback_pendiente,
      230,
    );
  });

  it('saldo cero no rompe el flujo', async () => {
    const supabaseAdmin = buildSupabaseForReversal({
      earn: EARN_MOVIMIENTO,
      saldoDisponible: 0,
    });

    const result = await revertirPadcoinsPorCancelacionTardeReserva(supabaseAdmin, RESERVA_ID, {
      reserva: RESERVA_BASE,
    });

    assert.equal(result.revertido, false);
    assert.equal(result.reason, 'saldo_insuficiente');
    assert.equal(result.pendiente, 350);
    assert.equal(supabaseAdmin.movStore.inserts.length, 0);
  });
});

describe('padcoinsReservaReversalService — integración penalización', () => {
  it('cancelación tardía ejecuta reversa y penalización', async () => {
    const supabaseAdmin = buildSupabaseForReversal({
      earn: EARN_MOVIMIENTO,
      saldoDisponible: 800,
    });

    const result = await penalizarPadcoinsPorCancelacionTarde(supabaseAdmin, RESERVA_ID, {
      reserva: RESERVA_BASE,
      horasAnticipacion: 6,
    });

    assert.equal(result.penalizado, true);
    assert.equal(result.reversal?.revertido, true);
    assert.equal(result.reversal?.padcoins, 350);
    assert.equal(supabaseAdmin.movStore.inserts.length, 2);
    assert.equal(supabaseAdmin.movStore.inserts[0].tipo, PADCOINS_MOVEMENT_TYPES.REVERSE);
    assert.equal(supabaseAdmin.movStore.inserts[1].tipo, 'spend');
  });

  it('no-show ejecuta reversa y penalización', async () => {
    const supabaseAdmin = buildSupabaseForReversal({
      earn: EARN_MOVIMIENTO,
      saldoDisponible: 800,
    });

    const result = await penalizarPadcoinsPorNoShow(supabaseAdmin, RESERVA_ID, {
      reserva: { ...RESERVA_BASE, estado: 'no_show' },
    });

    assert.equal(result.penalizado, true);
    assert.equal(result.reversal?.revertido, true);
    assert.equal(
      supabaseAdmin.movStore.inserts[0].referencia_id,
      '55:reversal_no_show',
    );
  });
});

describe('padcoinsReservaReversalService — acreditación bloqueada', () => {
  it('reserva cancelada antes de acreditar no acredita', async () => {
    assert.equal(isReservaCancelada({ estado: 'cancelada' }), true);

    const supabaseAdmin = buildSupabaseForReversal();
    const result = await acreditarPadcoinsPorReservaCompletada(supabaseAdmin, RESERVA_ID, {
      reserva: { ...RESERVA_BASE, estado: 'cancelada' },
    });

    assert.equal(result.acreditado, false);
    assert.equal(result.reason, 'reserva_cancelada');
    assert.equal(supabaseAdmin.movStore.inserts.length, 0);
  });

  it('fetchReservaEarnMovimiento devuelve earn existente', async () => {
    const supabaseAdmin = buildSupabaseForReversal({ earn: EARN_MOVIMIENTO });
    const earn = await fetchReservaEarnMovimiento(supabaseAdmin, RESERVA_ID);
    assert.equal(earn?.id, 'earn-mov-1');
    assert.equal(earn?.monto, 350);
  });
});
