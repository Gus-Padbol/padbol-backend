import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildPadcoinsReservaMovimientoReferencia,
  computePadcoinsAmountForReserva,
  getReservaPaidAmountInfo,
  isReservaCancelada,
  isReservaEstadoAcreditable,
  isReservaNoShow,
  PADCOINS_RESERVA_REFERENCIA_TIPO,
} from '../src/padcoins/padcoinsReservasService.js';
import { PADCOINS_RESERVATION_CALC_MODE } from '../src/padcoins/padcoinsGlobalConfigService.js';

const CONFIG_MAP = {
  porcentaje_devolucion_reserva: 5,
  padcoins_por_usd_equivalente: 100,
  reserva_confirmada: 30,
};

const CONFIG_TEXT_MAP = {
  modo_calculo_reserva: PADCOINS_RESERVATION_CALC_MODE.PERCENTAGE_PAID,
};

describe('padcoinsReservasService — referencia e idempotencia', () => {
  it('buildPadcoinsReservaMovimientoReferencia usa reserva + id', () => {
    assert.deepEqual(buildPadcoinsReservaMovimientoReferencia(42), {
      referencia_tipo: PADCOINS_RESERVA_REFERENCIA_TIPO,
      referencia_id: '42',
    });
  });
});

describe('padcoinsReservasService — estados', () => {
  it('solo completada acredita', () => {
    assert.equal(isReservaEstadoAcreditable('completada'), true);
    assert.equal(isReservaEstadoAcreditable('confirmada'), false);
    assert.equal(isReservaEstadoAcreditable('cancelada'), false);
  });

  it('cancelada no acredita', () => {
    assert.equal(isReservaCancelada({ estado: 'cancelada' }), true);
  });

  it('no_show no acredita', () => {
    assert.equal(isReservaNoShow({ estado: 'no_show' }), true);
    assert.equal(isReservaNoShow({ estado: 'completada' }), false);
  });
});

describe('padcoinsReservasService — cálculo', () => {
  it('USD 50 pagado con 5% y 100 PC/USD => 250 PadCoins', () => {
    const reserva = {
      monto_pagado: 50,
      moneda: 'USD',
      pago_estado: 'pagado',
    };
    const paid = getReservaPaidAmountInfo(reserva);
    assert.equal(paid.reliable, true);
    assert.equal(paid.paidAmount, 50);

    const result = computePadcoinsAmountForReserva(reserva, {
      configMap: CONFIG_MAP,
      configTextMap: CONFIG_TEXT_MAP,
    });
    assert.equal(result.method, 'proportional');
    assert.equal(result.padcoins, 250);
  });

  it('ARS sin conversión usa fallback reserva_confirmada', () => {
    const reserva = {
      monto_pagado: 5000,
      moneda: 'ARS',
      pago_estado: 'pagado',
    };
    const result = computePadcoinsAmountForReserva(reserva, {
      configMap: CONFIG_MAP,
      configTextMap: CONFIG_TEXT_MAP,
      fallbackFixed: 30,
    });
    assert.equal(result.method, 'fallback_reserva_confirmada');
    assert.equal(result.padcoins, 30);
  });

  it('sin valor pagado usa fallback seguro', () => {
    const result = computePadcoinsAmountForReserva({ estado: 'completada' }, {
      configMap: CONFIG_MAP,
      configTextMap: CONFIG_TEXT_MAP,
      fallbackFixed: 30,
    });
    assert.equal(result.padcoins, 30);
    assert.equal(result.method, 'fallback_reserva_confirmada');
  });
});

describe('padcoinsReservasService — yaFueAcreditadaReserva (mock)', () => {
  it('detecta movimiento earn existente', async () => {
    const { yaFueAcreditadaReserva } = await import('../src/padcoins/padcoinsReservasService.js');
    const supabaseAdmin = {
      from() {
        return {
          select() {
            return this;
          },
          eq() {
            return this;
          },
          limit() {
            return this;
          },
          maybeSingle: async () => ({ data: { id: 'mov-1' }, error: null }),
        };
      },
    };
    assert.equal(await yaFueAcreditadaReserva(supabaseAdmin, '99'), true);
  });
});

describe('padcoinsReservasService — acreditar (mock sede activa/inactiva)', () => {
  it('sede inactiva no acredita', async () => {
    const { acreditarPadcoinsPorReservaCompletada } = await import('../src/padcoins/padcoinsReservasService.js');
    const supabaseAdmin = {
      from(table) {
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
            maybeSingle: async () => ({ data: null, error: null }),
          };
        }
        return {
          select() { return this; },
          eq() { return this; },
          maybeSingle: async () => ({ data: null, error: null }),
        };
      },
    };

    const result = await acreditarPadcoinsPorReservaCompletada(supabaseAdmin, '1', {
      reserva: {
        id: 1,
        user_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        sede_id: 1,
        estado: 'completada',
        sede: 'Test',
      },
    });

    assert.equal(result.acreditado, false);
    assert.equal(result.reason, 'sede_no_participa');
  });

  it('sede activa acredita con config inyectada', async () => {
    const { acreditarPadcoinsPorReservaCompletada } = await import('../src/padcoins/padcoinsReservasService.js');
    const userId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

    const supabaseAdmin = {
      from(table) {
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
              return {
                select() { return this; },
                single: async () => ({ data: { ...payload, id: 'mov-new' }, error: null }),
              };
            },
            then(resolve, reject) {
              Promise.resolve({ data: [], error: null }).then(resolve, reject);
            },
          };
        }
        if (table === 'padcoins_global_config') {
          return {
            select() { return this; },
            order: async () => ({ data: [], error: null }),
          };
        }
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
        if (table === 'padcoins_saldo') {
          return {
            select() { return this; },
            eq() { return this; },
            maybeSingle: async () => ({
              data: { id: 's1', user_id: userId, disponible: 0, historico_total: 0 },
              error: null,
            }),
            update() {
              return {
                eq() { return this; },
                select() { return this; },
                single: async () => ({
                  data: { id: 's1', user_id: userId, disponible: 250, historico_total: 250 },
                  error: null,
                }),
              };
            },
          };
        }
        return {
          select() { return this; },
          eq() { return this; },
          maybeSingle: async () => ({ data: null, error: null }),
        };
      },
    };

    const result = await acreditarPadcoinsPorReservaCompletada(supabaseAdmin, '10', {
      reserva: {
        id: 10,
        user_id: userId,
        sede_id: 1,
        estado: 'completada',
        sede: 'La Meca',
        monto_pagado: 50,
        moneda: 'USD',
        pago_estado: 'pagado',
      },
      reservationConfig: {
        porcentaje_devolucion_reserva: 5,
        padcoins_por_usd_equivalente: 100,
        modo_calculo_reserva: 'porcentaje_valor_pagado',
        reserva_confirmada_fallback: 30,
      },
      configMap: CONFIG_MAP,
      configTextMap: CONFIG_TEXT_MAP,
    });

    assert.equal(result.acreditado, true);
    assert.equal(result.padcoins, 250);
    assert.equal(result.method, 'proportional');
    assert.equal(result.movimiento?.id, 'mov-new');
  });

  it('idempotencia evita duplicado en acreditar', async () => {
    const { acreditarPadcoinsPorReservaCompletada } = await import('../src/padcoins/padcoinsReservasService.js');
    const supabaseAdmin = {
      from(table) {
        if (table === 'padcoins_movimientos') {
          return {
            select() { return this; },
            eq() { return this; },
            limit() { return this; },
            maybeSingle: async () => ({ data: { id: 'existing' }, error: null }),
          };
        }
        if (table === 'padcoins_sede_config') {
          return {
            select() { return this; },
            eq() { return this; },
            maybeSingle: async () => ({
              data: { id: 'cfg-1', sede_id: 1, activo: true, fecha_inicio: null, fecha_fin: null },
              error: null,
            }),
          };
        }
        return {
          select() { return this; },
          eq() { return this; },
          maybeSingle: async () => ({ data: null, error: null }),
        };
      },
    };

    const result = await acreditarPadcoinsPorReservaCompletada(supabaseAdmin, '10', {
      reserva: {
        id: 10,
        user_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        sede_id: 1,
        estado: 'completada',
        sede: 'Test',
      },
    });

    assert.equal(result.acreditado, false);
    assert.equal(result.reason, 'ya_acreditada');
  });
});

function buildSupabaseReservaAcreditar({
  userId,
  sedeRuleOverrides = {},
  saldoDisponible = 0,
} = {}) {
  return {
    from(table) {
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
            return {
              select() { return this; },
              single: async () => ({ data: { ...payload, id: 'mov-new' }, error: null }),
            };
          },
          then(resolve, reject) {
            Promise.resolve({ data: [], error: null }).then(resolve, reject);
          },
        };
      }
      if (table === 'padcoins_global_config') {
        return {
          select() { return this; },
          eq() { return this; },
          order: async () => ({ data: [], error: null }),
          maybeSingle: async () => ({ data: null, error: null }),
        };
      }
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
              rule_overrides: sedeRuleOverrides,
            },
            error: null,
          }),
        };
      }
      if (table === 'padcoins_saldo') {
        return {
          select() { return this; },
          eq() { return this; },
          maybeSingle: async () => ({
            data: { id: 's1', user_id: userId, disponible: saldoDisponible, historico_total: saldoDisponible },
            error: null,
          }),
          update() {
            return {
              eq() { return this; },
              select() { return this; },
              single: async () => ({
                data: { id: 's1', user_id: userId, disponible: saldoDisponible + 500, historico_total: saldoDisponible + 500 },
                error: null,
              }),
            };
          },
        };
      }
      if (table === 'sedes') {
        return {
          select() { return this; },
          eq() { return this; },
          maybeSingle: async () => ({ data: { id: 1, nombre: 'La Meca' }, error: null }),
        };
      }
      return {
        select() { return this; },
        eq() { return this; },
        maybeSingle: async () => ({ data: null, error: null }),
      };
    },
  };
}

const RESERVA_USD_50 = {
  id: 10,
  user_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  sede_id: 1,
  estado: 'completada',
  sede: 'La Meca',
  monto_pagado: 50,
  moneda: 'USD',
  pago_estado: 'pagado',
};

describe('padcoinsReservasService — config efectiva por sede', () => {
  it('usa porcentaje_devolucion_reserva override de sede', async () => {
    const { acreditarPadcoinsPorReservaCompletada } = await import('../src/padcoins/padcoinsReservasService.js');
    const supabaseAdmin = buildSupabaseReservaAcreditar({
      userId: RESERVA_USD_50.user_id,
      sedeRuleOverrides: { porcentaje_devolucion_reserva: 10 },
    });

    const result = await acreditarPadcoinsPorReservaCompletada(supabaseAdmin, '10', {
      reserva: RESERVA_USD_50,
    });

    assert.equal(result.acreditado, true);
    assert.equal(result.padcoins, 500);
    assert.equal(result.method, 'proportional');
  });

  it('hereda global sin override de sede (5% × 50 × 100 = 250)', async () => {
    const { acreditarPadcoinsPorReservaCompletada } = await import('../src/padcoins/padcoinsReservasService.js');
    const supabaseAdmin = buildSupabaseReservaAcreditar({
      userId: RESERVA_USD_50.user_id,
      sedeRuleOverrides: {},
    });

    const result = await acreditarPadcoinsPorReservaCompletada(supabaseAdmin, '10', {
      reserva: RESERVA_USD_50,
    });

    assert.equal(result.acreditado, true);
    assert.equal(result.padcoins, 250);
  });

  it('usa padcoins_por_usd_equivalente override de sede', async () => {
    const { acreditarPadcoinsPorReservaCompletada } = await import('../src/padcoins/padcoinsReservasService.js');
    const supabaseAdmin = buildSupabaseReservaAcreditar({
      userId: RESERVA_USD_50.user_id,
      sedeRuleOverrides: { padcoins_por_usd_equivalente: 200 },
    });

    const result = await acreditarPadcoinsPorReservaCompletada(supabaseAdmin, '10', {
      reserva: RESERVA_USD_50,
    });

    assert.equal(result.acreditado, true);
    assert.equal(result.padcoins, 500);
  });

  it('usa reserva_confirmada fallback override en ARS sin conversión', async () => {
    const { acreditarPadcoinsPorReservaCompletada } = await import('../src/padcoins/padcoinsReservasService.js');
    const supabaseAdmin = buildSupabaseReservaAcreditar({
      userId: RESERVA_USD_50.user_id,
      sedeRuleOverrides: { reserva_confirmada: 75 },
    });

    const result = await acreditarPadcoinsPorReservaCompletada(supabaseAdmin, '10', {
      reserva: {
        ...RESERVA_USD_50,
        monto_pagado: 5000,
        moneda: 'ARS',
      },
    });

    assert.equal(result.acreditado, true);
    assert.equal(result.padcoins, 75);
    assert.equal(result.method, 'fallback_reserva_confirmada');
  });
});
