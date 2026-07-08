import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildPadcoinsPenaltyReferencia,
  getPadcoinsPenaltyAmount,
  isCancelacionTardeReserva,
  penalizarPadcoinsPorCancelacionTarde,
  penalizarPadcoinsPorNoShow,
  yaFuePenalizadaReserva,
  PADCOINS_PENALTY_TYPES,
} from '../src/padcoins/padcoinsPenaltiesService.js';
import { deductPadcoins } from '../src/padcoins/padcoinsService.js';
import { PADCOINS_ORIGINS } from '../src/padcoins/padcoinsConfig.js';
import { PENALIZACION_UMBRAL_HORAS } from '../routes/reputacion.js';

const USER_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

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

function buildSedeConfigMock(active = true, ruleOverrides = {}) {
  return {
    select() { return this; },
    eq() { return this; },
    maybeSingle: async () => ({
      data: active
        ? {
          id: 'cfg-1',
          sede_id: 1,
          activo: true,
          fecha_inicio: null,
          fecha_fin: null,
          rule_overrides: ruleOverrides,
        }
        : null,
      error: null,
    }),
  };
}

function buildSaldoMock(disponible = 500, historico = 500) {
  return {
    select() { return this; },
    eq() { return this; },
    maybeSingle: async () => ({
      data: { id: 's1', user_id: USER_ID, disponible, historico_total: historico },
      error: null,
    }),
    update() {
      return {
        eq() { return this; },
        select() { return this; },
        single: async () => ({
          data: { id: 's1', user_id: USER_ID, disponible: disponible - 100, historico_total: historico },
          error: null,
        }),
      };
    },
  };
}

function buildMovimientosMock({ existingPenalty = false, insertSpy = null } = {}) {
  return {
    select() { return this; },
    eq() { return this; },
    limit() { return this; },
    maybeSingle: async () => (
      existingPenalty ? { data: { id: 'pen-existing' }, error: null } : { data: null, error: null }
    ),
    insert(payload) {
      if (insertSpy) insertSpy(payload);
      return {
        select() { return this; },
        single: async () => ({ data: { ...payload, id: 'mov-penalty' }, error: null }),
      };
    },
  };
}

function buildSupabaseForPenalty({
  sedeActive = true,
  saldoDisponible = 500,
  existingPenalty = false,
  insertSpy = null,
  configRows = [],
  sedeRuleOverrides = {},
} = {}) {
  return {
    from(table) {
      if (table === 'padcoins_movimientos') {
        return buildMovimientosMock({ existingPenalty, insertSpy });
      }
      if (table === 'padcoins_sede_config') {
        return buildSedeConfigMock(sedeActive, sedeRuleOverrides);
      }
      if (table === 'padcoins_saldo') return buildSaldoMock(saldoDisponible, saldoDisponible);
      if (table === 'padcoins_global_config') {
        return {
          select() { return this; },
          eq() { return this; },
          order: async () => ({ data: configRows, error: null }),
          maybeSingle: async () => ({ data: null, error: null }),
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
          maybeSingle: async () => ({ data: null, error: null }),
        };
      }
      return buildMovimientosMock();
    },
  };
}

describe('padcoinsPenaltiesService — referencia e idempotencia', () => {
  it('buildPadcoinsPenaltyReferencia usa penalizacion + reserva:tipo', () => {
    assert.deepEqual(
      buildPadcoinsPenaltyReferencia(99, PADCOINS_PENALTY_TYPES.CANCELACION_TARDE),
      {
        referencia_tipo: PADCOINS_ORIGINS.PENALIZACION,
        referencia_id: '99:cancelacion_tarde',
      },
    );
  });

  it('yaFuePenalizadaReserva detecta movimiento existente', async () => {
    const supabaseAdmin = buildSupabaseForPenalty({ existingPenalty: true });
    assert.equal(
      await yaFuePenalizadaReserva(supabaseAdmin, 99, PADCOINS_PENALTY_TYPES.NO_SHOW),
      true,
    );
  });
});

describe('padcoinsPenaltiesService — cancelación tardía', () => {
  it('isCancelacionTardeReserva usa umbral 24h', () => {
    assert.equal(isCancelacionTardeReserva('2026-07-10', '18:00', 12), true);
    assert.equal(isCancelacionTardeReserva('2026-07-10', '18:00', 24), false);
    assert.equal(isCancelacionTardeReserva('2026-07-10', '18:00', 48), false);
    assert.equal(PENALIZACION_UMBRAL_HORAS, 24);
  });

  it('cancelación tarde descuenta -100', async () => {
    let inserted = null;
    const supabaseAdmin = buildSupabaseForPenalty({
      saldoDisponible: 500,
      insertSpy: (payload) => { inserted = payload; },
    });

    const result = await penalizarPadcoinsPorCancelacionTarde(supabaseAdmin, 55, {
      reserva: RESERVA_BASE,
      horasAnticipacion: 6,
    });

    assert.equal(result.penalizado, true);
    assert.equal(result.padcoins, 100);
    assert.equal(result.padcoins_solicitados, 100);
    assert.equal(inserted.monto, -100);
    assert.equal(inserted.tipo, 'spend');
    assert.equal(inserted.referencia_tipo, PADCOINS_ORIGINS.PENALIZACION);
    assert.match(inserted.descripcion, /cancelación tardía/i);
  });

  it('cancelación no tardía no descuenta', async () => {
    let insertCalled = false;
    const supabaseAdmin = buildSupabaseForPenalty({
      insertSpy: () => { insertCalled = true; },
    });

    const result = await penalizarPadcoinsPorCancelacionTarde(supabaseAdmin, 55, {
      reserva: RESERVA_BASE,
      horasAnticipacion: 48,
    });

    assert.equal(result.penalizado, false);
    assert.equal(result.reason, 'cancelacion_no_tardia');
    assert.equal(insertCalled, false);
  });
});

describe('padcoinsPenaltiesService — no show', () => {
  it('no_show descuenta -300', async () => {
    let inserted = null;
    const supabaseAdmin = buildSupabaseForPenalty({
      saldoDisponible: 1000,
      insertSpy: (payload) => { inserted = payload; },
    });

    const result = await penalizarPadcoinsPorNoShow(supabaseAdmin, 55, {
      reserva: { ...RESERVA_BASE, estado: 'no_show' },
    });

    assert.equal(result.penalizado, true);
    assert.equal(result.padcoins, 300);
    assert.equal(inserted.monto, -300);
    assert.match(inserted.descripcion, /no show/i);
    assert.equal(inserted.referencia_id, '55:no_show');
  });

  it('estado distinto de no_show no penaliza', async () => {
    const result = await penalizarPadcoinsPorNoShow(
      buildSupabaseForPenalty(),
      55,
      { reserva: RESERVA_BASE },
    );
    assert.equal(result.penalizado, false);
    assert.equal(result.reason, 'estado_no_show');
  });
});

describe('padcoinsPenaltiesService — exclusiones', () => {
  it('sede inactiva no penaliza', async () => {
    const result = await penalizarPadcoinsPorCancelacionTarde(
      buildSupabaseForPenalty({ sedeActive: false }),
      55,
      { reserva: RESERVA_BASE, horasAnticipacion: 2 },
    );
    assert.equal(result.penalizado, false);
    assert.equal(result.reason, 'sede_no_participa');
  });

  it('reserva sin usuario no penaliza', async () => {
    const result = await penalizarPadcoinsPorCancelacionTarde(
      buildSupabaseForPenalty(),
      55,
      { reserva: { ...RESERVA_BASE, user_id: null }, horasAnticipacion: 2 },
    );
    assert.equal(result.penalizado, false);
    assert.equal(result.reason, 'user_id_invalido');
  });

  it('idempotencia evita doble penalización', async () => {
    const result = await penalizarPadcoinsPorCancelacionTarde(
      buildSupabaseForPenalty({ existingPenalty: true }),
      55,
      { reserva: RESERVA_BASE, horasAnticipacion: 2 },
    );
    assert.equal(result.penalizado, false);
    assert.equal(result.reason, 'ya_penalizada');
  });
});

describe('padcoinsPenaltiesService — saldo insuficiente', () => {
  it('deductPadcoins descuenta parcial sin romper', async () => {
    let inserted = null;
    const supabaseAdmin = {
      from(table) {
        if (table === 'padcoins_movimientos') {
          return buildMovimientosMock({
            insertSpy: (payload) => { inserted = payload; },
          });
        }
        if (table === 'padcoins_saldo') return buildSaldoMock(50, 50);
        return buildMovimientosMock();
      },
    };

    const result = await deductPadcoins(supabaseAdmin, USER_ID, 100, {
      descripcion: 'Test penalización',
    });

    assert.equal(result.partial, true);
    assert.equal(result.monto_aplicado, 50);
    assert.equal(inserted.monto, -50);
    assert.match(inserted.descripcion, /descuento parcial/);
  });

  it('saldo cero devuelve skipped sin movimiento', async () => {
    let insertCalled = false;
    const supabaseAdmin = buildSupabaseForPenalty({
      saldoDisponible: 0,
      insertSpy: () => { insertCalled = true; },
    });

    const result = await penalizarPadcoinsPorCancelacionTarde(supabaseAdmin, 55, {
      reserva: RESERVA_BASE,
      horasAnticipacion: 2,
    });

    assert.equal(result.penalizado, false);
    assert.equal(result.reason, 'saldo_insuficiente');
    assert.equal(insertCalled, false);
  });
});

describe('padcoinsPenaltiesService — config global', () => {
  it('getPadcoinsPenaltyAmount usa valor absoluto de config', async () => {
    const supabaseAdmin = buildSupabaseForPenalty({
      configRows: [{
        key: 'cancelacion_tarde',
        value_integer: -100,
        activo: true,
      }],
    });
    assert.equal(await getPadcoinsPenaltyAmount(supabaseAdmin, 'cancelacion_tarde'), 100);
  });

  it('config inactiva no penaliza', async () => {
    const supabaseAdmin = buildSupabaseForPenalty({
      configRows: [{
        key: 'cancelacion_tarde',
        value_integer: -100,
        activo: false,
      }],
    });

    const result = await penalizarPadcoinsPorCancelacionTarde(supabaseAdmin, 55, {
      reserva: RESERVA_BASE,
      horasAnticipacion: 2,
    });

    assert.equal(result.penalizado, false);
    assert.equal(result.reason, 'penalizacion_inactiva_o_cero');
  });
});

describe('padcoinsPenaltiesService — config efectiva por sede', () => {
  it('cancelacion_tarde usa override de sede', async () => {
    let inserted = null;
    const supabaseAdmin = buildSupabaseForPenalty({
      sedeRuleOverrides: { cancelacion_tarde: -50 },
      insertSpy: (payload) => { inserted = payload; },
    });

    const result = await penalizarPadcoinsPorCancelacionTarde(supabaseAdmin, 55, {
      reserva: RESERVA_BASE,
      horasAnticipacion: 2,
    });

    assert.equal(result.penalizado, true);
    assert.equal(result.padcoins, 50);
    assert.equal(inserted.monto, -50);
  });

  it('no_show usa override de sede si existe', async () => {
    let inserted = null;
    const supabaseAdmin = buildSupabaseForPenalty({
      sedeRuleOverrides: { no_show: -150 },
      insertSpy: (payload) => { inserted = payload; },
    });

    const result = await penalizarPadcoinsPorNoShow(supabaseAdmin, 55, {
      reserva: { ...RESERVA_BASE, estado: 'no_show' },
    });

    assert.equal(result.penalizado, true);
    assert.equal(result.padcoins, 150);
    assert.equal(inserted.monto, -150);
  });

  it('sin sedeId en getPadcoinsPenaltyAmount conserva global', async () => {
    const supabaseAdmin = buildSupabaseForPenalty({
      configRows: [{
        key: 'cancelacion_tarde',
        value_integer: -80,
        activo: true,
      }],
    });
    assert.equal(await getPadcoinsPenaltyAmount(supabaseAdmin, 'cancelacion_tarde'), 80);
  });

  it('sin override de sede hereda penalización global efectiva', async () => {
    const supabaseAdmin = buildSupabaseForPenalty({
      sedeRuleOverrides: {},
    });
    const amount = await getPadcoinsPenaltyAmount(supabaseAdmin, 'no_show', 1);
    assert.equal(amount, 300);
  });
});
