import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  applyPadcoinsEarnCaps,
  getEarnPeriodBounds,
  getPadcoinsEarnedInPeriod,
  getPadcoinsEarnLimits,
  appendPadcoinsEarnCapToDescripcion,
} from '../src/padcoins/padcoinsEarnLimitsService.js';
import { addPadcoins, adjustPadcoins } from '../src/padcoins/padcoinsService.js';
import { PADCOINS_MOVEMENT_TYPES } from '../src/padcoins/padcoinsConfig.js';

const USER_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const FIXED_NOW = new Date('2026-07-06T15:00:00.000-03:00');

const DEFAULT_LIMITS = {
  limite_diario_jugador: 1000,
  limite_mensual_jugador: 10000,
};

function buildMovimientosMock(rows = []) {
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
      Promise.resolve({ data: rows, error: null }).then(resolve, reject);
    },
  };
}

function buildSaldoMock(userId, disponible = 0, historico = 0) {
  return {
    select() { return this; },
    eq() { return this; },
    maybeSingle: async () => ({
      data: { id: 's1', user_id: userId, disponible, historico_total: historico },
      error: null,
    }),
    update() {
      return {
        eq() { return this; },
        select() { return this; },
        single: async () => ({
          data: { id: 's1', user_id: userId, disponible: disponible + 100, historico_total: historico + 100 },
          error: null,
        }),
      };
    },
  };
}

function buildSupabaseForEarned(rows) {
  return {
    from(table) {
      if (table === 'padcoins_movimientos') return buildMovimientosMock(rows);
      if (table === 'padcoins_global_config') {
        return {
          select() { return this; },
          order: async () => ({ data: [], error: null }),
        };
      }
      return buildMovimientosMock([]);
    },
  };
}

describe('padcoinsEarnLimitsService — periodos', () => {
  it('getEarnPeriodBounds día AR cubre 00:00–23:59', () => {
    const { desde, hasta } = getEarnPeriodBounds('day', FIXED_NOW);
    assert.equal(desde.toISOString(), '2026-07-06T03:00:00.000Z');
    assert.equal(hasta.toISOString(), '2026-07-07T02:59:59.999Z');
  });

  it('getEarnPeriodBounds mes AR cubre julio 2026', () => {
    const { desde, hasta } = getEarnPeriodBounds('month', FIXED_NOW);
    assert.equal(desde.toISOString(), '2026-07-01T03:00:00.000Z');
    assert.equal(hasta.toISOString(), '2026-08-01T02:59:59.999Z');
  });
});

describe('padcoinsEarnLimitsService — getPadcoinsEarnedInPeriod', () => {
  it('suma solo earn positivos en el rango', async () => {
    const rows = [{ monto: 100 }, { monto: 50 }];
    const supabaseAdmin = buildSupabaseForEarned(rows);
    const { desde, hasta } = getEarnPeriodBounds('day', FIXED_NOW);
    const total = await getPadcoinsEarnedInPeriod(supabaseAdmin, USER_ID, desde, hasta);
    assert.equal(total, 150);
  });
});

describe('padcoinsEarnLimitsService — applyPadcoinsEarnCaps', () => {
  it('acredita completo si está bajo límite', async () => {
    const supabaseAdmin = buildSupabaseForEarned([]);
    const result = await applyPadcoinsEarnCaps(supabaseAdmin, USER_ID, 250, {
      now: FIXED_NOW,
      limits: DEFAULT_LIMITS,
    });
    assert.equal(result.amountToCredit, 250);
    assert.equal(result.capped, false);
    assert.equal(result.reason, null);
  });

  it('acredita parcial si supera límite diario', async () => {
    const supabaseAdmin = buildSupabaseForEarned([{ monto: 900 }]);
    const result = await applyPadcoinsEarnCaps(supabaseAdmin, USER_ID, 250, {
      now: FIXED_NOW,
      limits: DEFAULT_LIMITS,
    });
    assert.equal(result.amountToCredit, 100);
    assert.equal(result.capped, true);
    assert.equal(result.reason, 'limite_diario_aplicado');
  });

  it('no acredita si ya llegó al límite diario', async () => {
    const supabaseAdmin = buildSupabaseForEarned([{ monto: 1000 }]);
    const result = await applyPadcoinsEarnCaps(supabaseAdmin, USER_ID, 250, {
      now: FIXED_NOW,
      limits: DEFAULT_LIMITS,
    });
    assert.equal(result.amountToCredit, 0);
    assert.equal(result.reason, 'limite_diario_alcanzado');
  });

  it('acredita parcial si supera límite mensual', async () => {
    const limits = { limite_diario_jugador: null, limite_mensual_jugador: 10000 };
    const supabaseAdmin = buildSupabaseForEarned([{ monto: 9900 }]);
    const result = await applyPadcoinsEarnCaps(supabaseAdmin, USER_ID, 250, {
      now: FIXED_NOW,
      limits,
    });
    assert.equal(result.amountToCredit, 100);
    assert.equal(result.capped, true);
    assert.equal(result.reason, 'limite_mensual_aplicado');
  });

  it('no acredita si ya llegó al límite mensual', async () => {
    const limits = { limite_diario_jugador: null, limite_mensual_jugador: 10000 };
    const supabaseAdmin = buildSupabaseForEarned([{ monto: 10000 }]);
    const result = await applyPadcoinsEarnCaps(supabaseAdmin, USER_ID, 250, {
      now: FIXED_NOW,
      limits,
    });
    assert.equal(result.amountToCredit, 0);
    assert.equal(result.reason, 'limite_mensual_alcanzado');
  });

  it('appendPadcoinsEarnCapToDescripcion indica monto limitado', () => {
    const text = appendPadcoinsEarnCapToDescripcion('Bonus reserva', {
      capped: true,
      requested: 250,
      amountToCredit: 100,
    });
    assert.match(text, /límite aplicado: solicitado 250, acreditado 100/);
  });
});

describe('padcoinsService — límites en addPadcoins', () => {
  it('addPadcoins earn respeta tope parcial', async () => {
    let insertedMonto = null;
    const supabaseAdmin = {
      from(table) {
        if (table === 'padcoins_movimientos') {
          const base = buildMovimientosMock([{ monto: 900 }]);
          return {
            ...base,
            insert(payload) {
              insertedMonto = payload.monto;
              return base.insert(payload);
            },
          };
        }
        if (table === 'padcoins_saldo') return buildSaldoMock(USER_ID, 0, 900);
        if (table === 'padcoins_global_config') {
          return { select() { return this; }, order: async () => ({ data: [], error: null }) };
        }
        return buildMovimientosMock([]);
      },
    };

    const result = await addPadcoins(supabaseAdmin, USER_ID, 250, {
      tipo: PADCOINS_MOVEMENT_TYPES.EARN,
      descripcion: 'Test earn',
      now: FIXED_NOW,
      earnLimits: DEFAULT_LIMITS,
    });

    assert.equal(result.skipped, undefined);
    assert.equal(result.monto_aplicado, 100);
    assert.equal(insertedMonto, 100);
    assert.match(result.movimiento.descripcion, /límite aplicado/);
  });

  it('addPadcoins earn bloqueado devuelve skipped sin movimiento', async () => {
    let insertCalled = false;
    const supabaseAdmin = {
      from(table) {
        if (table === 'padcoins_movimientos') {
          const base = buildMovimientosMock([{ monto: 1000 }]);
          return {
            ...base,
            insert() {
              insertCalled = true;
              return base.insert({});
            },
          };
        }
        if (table === 'padcoins_saldo') return buildSaldoMock(USER_ID, 500, 1000);
        return buildMovimientosMock([]);
      },
    };

    const result = await addPadcoins(supabaseAdmin, USER_ID, 250, {
      tipo: PADCOINS_MOVEMENT_TYPES.EARN,
      now: FIXED_NOW,
      earnLimits: DEFAULT_LIMITS,
    });

    assert.equal(result.skipped, true);
    assert.equal(result.reason, 'limite_diario_alcanzado');
    assert.equal(insertCalled, false);
  });

  it('adjustPadcoins admin no aplica límites', async () => {
    let insertedMonto = null;
    const supabaseAdmin = {
      from(table) {
        if (table === 'padcoins_movimientos') {
          const base = buildMovimientosMock([{ monto: 1000 }]);
          return {
            ...base,
            insert(payload) {
              insertedMonto = payload.monto;
              return base.insert(payload);
            },
          };
        }
        if (table === 'padcoins_saldo') return buildSaldoMock(USER_ID, 100, 1000);
        return buildMovimientosMock([]);
      },
    };

    await adjustPadcoins(supabaseAdmin, USER_ID, 500, { descripcion: 'Ajuste admin' });
    assert.equal(insertedMonto, 500);
  });
});

describe('padcoinsReservasService — límites e idempotencia', () => {
  it('reserva acredita parcial y segunda llamada es ya_acreditada', async () => {
    const { acreditarPadcoinsPorReservaCompletada } = await import('../src/padcoins/padcoinsReservasService.js');
    let earnQueryCount = 0;
    let idempotencyHit = false;

    const supabaseAdmin = {
      from(table) {
        if (table === 'padcoins_movimientos') {
          return {
            select() { return this; },
            eq(_col, val) {
              if (val === 'earn') earnQueryCount += 1;
              return this;
            },
            gt() { return this; },
            gte() { return this; },
            lte() { return this; },
            limit() { return this; },
            maybeSingle: async () => {
              if (idempotencyHit) return { data: { id: 'existing' }, error: null };
              return { data: null, error: null };
            },
            insert(payload) {
              idempotencyHit = true;
              return {
                select() { return this; },
                single: async () => ({ data: { ...payload, id: 'mov-reserva' }, error: null }),
              };
            },
            then(resolve, reject) {
              Promise.resolve({ data: [{ monto: 900 }], error: null }).then(resolve, reject);
            },
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
        if (table === 'padcoins_saldo') {
          return buildSaldoMock(USER_ID, 0, 900);
        }
        return {
          select() { return this; },
          eq() { return this; },
          maybeSingle: async () => ({ data: null, error: null }),
        };
      },
    };

    const reserva = {
      id: 77,
      user_id: USER_ID,
      sede_id: 1,
      estado: 'completada',
      sede: 'Test',
      monto_pagado: 50,
      moneda: 'USD',
      pago_estado: 'pagado',
    };

    const first = await acreditarPadcoinsPorReservaCompletada(supabaseAdmin, '77', {
      reserva,
      reservationConfig: {
        porcentaje_devolucion_reserva: 5,
        padcoins_por_usd_equivalente: 100,
        modo_calculo_reserva: 'porcentaje_valor_pagado',
        reserva_confirmada_fallback: 30,
      },
      configMap: {
        porcentaje_devolucion_reserva: 5,
        padcoins_por_usd_equivalente: 100,
        reserva_confirmada: 30,
      },
      configTextMap: { modo_calculo_reserva: 'porcentaje_valor_pagado' },
      now: FIXED_NOW,
      earnLimits: DEFAULT_LIMITS,
    });

    assert.equal(first.acreditado, true);
    assert.equal(first.padcoins_solicitados, 250);
    assert.equal(first.padcoins, 100);
    assert.equal(first.capped, true);

    const second = await acreditarPadcoinsPorReservaCompletada(supabaseAdmin, '77', {
      reserva,
      now: FIXED_NOW,
      earnLimits: DEFAULT_LIMITS,
    });

    assert.equal(second.acreditado, false);
    assert.equal(second.reason, 'ya_acreditada');
    assert.ok(earnQueryCount >= 1);
  });
});

describe('logrosSyncService — límites en logro desbloqueado', () => {
  it('logro respeta límite diario parcial', async () => {
    const { sumarPadcoinsLogroDesbloqueado } = await import('../src/arena/logrosSyncService.js');

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
                single: async () => ({ data: { ...payload, id: 'mov-logro' }, error: null }),
              };
            },
            then(resolve, reject) {
              Promise.resolve({ data: [{ monto: 900 }], error: null }).then(resolve, reject);
            },
          };
        }
        if (table === 'padcoins_saldo') return buildSaldoMock(USER_ID, 0, 900);
        if (table === 'padcoins_global_config') {
          return {
            select() { return this; },
            eq() { return this; },
            order: async () => ({ data: [], error: null }),
            maybeSingle: async () => ({
              data: { key: 'logro_desbloqueado', value_integer: 500, activo: true },
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

    const result = await sumarPadcoinsLogroDesbloqueado(
      supabaseAdmin,
      USER_ID,
      'test-logro',
      'Test Logro',
    );

    assert.ok(result);
    assert.equal(result.monto_aplicado, 100);
    assert.equal(result.cap?.capped, true);
  });
});

describe('padcoinsEarnLimitsService — movimientos excluidos del cómputo', () => {
  it('getPadcoinsEarnedInPeriod filtra tipo earn en query', async () => {
    const filters = [];
    const supabaseAdmin = {
      from() {
        return {
          select() { return this; },
          eq(col, val) {
            filters.push([col, val]);
            return this;
          },
          gt(col, val) {
            filters.push([col, val]);
            return this;
          },
          gte() { return this; },
          lte() { return this; },
          then(resolve, reject) {
            Promise.resolve({ data: [], error: null }).then(resolve, reject);
          },
        };
      },
    };

    const { desde, hasta } = getEarnPeriodBounds('day', FIXED_NOW);
    await getPadcoinsEarnedInPeriod(supabaseAdmin, USER_ID, desde, hasta);

    assert.deepEqual(filters, [
      ['user_id', USER_ID],
      ['tipo', PADCOINS_MOVEMENT_TYPES.EARN],
      ['monto', 0],
    ]);
  });
});

describe('padcoinsEarnLimitsService — getPadcoinsEarnLimits defaults', () => {
  it('usa defaults cuando no hay filas en config', async () => {
    const supabaseAdmin = {
      from() {
        return {
          select() { return this; },
          order: async () => ({ data: [], error: null }),
        };
      },
    };
    const limits = await getPadcoinsEarnLimits(supabaseAdmin);
    assert.equal(limits.limite_diario_jugador, 1000);
    assert.equal(limits.limite_mensual_jugador, 10000);
  });
});
