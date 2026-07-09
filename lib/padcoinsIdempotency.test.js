import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildPadcoinsSourceKey,
  ensurePadcoinsNotAlreadyApplied,
  registerPadcoinsApplication,
} from '../src/padcoins/padcoinsIdempotencyService.js';
import { addPadcoins, spendPadcoins } from '../src/padcoins/padcoinsService.js';
import { acreditarPadcoinsPorReservaCompletada } from '../src/padcoins/padcoinsReservasService.js';
import { canjearPremioPadcoins } from '../src/padcoins/padcoinsCanjesService.js';
import { recordCampaignApplication } from '../src/padcoins/padcoinsCampaignResolverService.js';
import { penalizarPadcoinsPorCancelacionTarde } from '../src/padcoins/padcoinsPenaltiesService.js';
import { PADCOINS_ORIGINS } from '../src/padcoins/padcoinsConfig.js';

const USER_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const ADMIN_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const SEDE_ID = 1;
const RESERVA_ID = '10';
const PREMIO_ID = 'premio-uuid-1';

function buildSaldoStore(initialDisponible = 500, { premioStock = 5 } = {}) {
  let disponible = initialDisponible;
  const movimientos = [];
  const canjes = [];
  const campaignApps = [];

  return {
    movimientos,
    canjes,
    campaignApps,
    supabase: {
      from(table) {
        if (table === 'padcoins_saldo') {
          const row = {
            id: 'saldo-1',
            user_id: USER_ID,
            disponible,
            historico_total: disponible,
          };
          return {
            select() { return this; },
            eq() { return this; },
            maybeSingle: async () => ({ data: row, error: null }),
            insert: async () => ({ data: row, error: null }),
            update(payload) {
              disponible = payload.disponible;
              return {
                eq() { return this; },
                select() { return this; },
                single: async () => ({
                  data: { ...row, disponible, historico_total: payload.historico_total },
                  error: null,
                }),
              };
            },
          };
        }

        if (table === 'padcoins_movimientos') {
          return {
            select() { return this; },
            eq(col, val) {
              this._filters = this._filters ?? {};
              this._filters[col] = val;
              return this;
            },
            limit() { return this; },
            maybeSingle: async () => {
              const found = movimientos.find((m) => {
                const f = this._filters ?? {};
                return Object.entries(f).every(([k, v]) => m[k] === v);
              });
              return { data: found ?? null, error: null };
            },
            insert(payload) {
              const dup = movimientos.find(
                (m) => m.referencia_tipo === payload.referencia_tipo
                  && m.referencia_id === payload.referencia_id
                  && m.tipo === payload.tipo,
              );
              if (dup) {
                return {
                  select() { return this; },
                  single: async () => ({
                    data: null,
                    error: { code: '23505', message: 'padcoins_movimientos duplicate' },
                  }),
                };
              }
              const row = { id: `mov-${movimientos.length + 1}`, ...payload };
              movimientos.push(row);
              return {
                select() { return this; },
                single: async () => ({ data: row, error: null }),
              };
            },
          };
        }

        if (table === 'premios_canjeables') {
          const premio = {
            id: PREMIO_ID,
            sede_id: SEDE_ID,
            nombre: 'Bebida',
            costo_padcoins: 200,
            stock_disponible: premioStock,
            activo: true,
          };
          return {
            select() { return this; },
            eq() { return this; },
            maybeSingle: async () => ({ data: premio, error: null }),
            update(payload) {
              premio.stock_disponible = payload.stock_disponible;
              return {
                eq() { return this; },
                select() { return this; },
                maybeSingle: async () => ({ data: premio, error: null }),
              };
            },
          };
        }

        if (table === 'padcoins_canjes') {
          return {
            select() { return this; },
            eq(col, val) {
              this._filters = this._filters ?? {};
              this._filters[col] = val;
              return this;
            },
            in() { return this; },
            order() { return this; },
            limit() { return this; },
            maybeSingle: async () => {
              const f = this._filters ?? {};
              const found = canjes.find((c) => Object.entries(f).every(([k, v]) => c[k] === v));
              return { data: found ?? null, error: null };
            },
            insert(payload) {
              const row = { ...payload, created_at: new Date().toISOString() };
              canjes.push(row);
              return {
                select() { return this; },
                single: async () => ({ data: row, error: null }),
              };
            },
          };
        }

        if (table === 'padcoins_campaign_applications') {
          return {
            insert(payload) {
              const dup = campaignApps.find(
                (a) => a.campaign_id === payload.campaign_id && a.reserva_id === payload.reserva_id,
              );
              if (dup) {
                return {
                  select() { return this; },
                  single: async () => ({
                    data: null,
                    error: { code: '23505', message: 'padcoins_campaign_applications duplicate' },
                  }),
                };
              }
              const row = { id: `app-${campaignApps.length + 1}`, ...payload };
              campaignApps.push(row);
              return {
                select() { return this; },
                single: async () => ({ data: row, error: null }),
              };
            },
          };
        }

        if (table === 'padcoins_sede_config') {
          return {
            select() { return this; },
            eq() { return this; },
            maybeSingle: async () => ({
              data: { sede_id: SEDE_ID, activo: true, participa: true },
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

        if (table === 'reservas') {
          return {
            select() { return this; },
            eq() { return this; },
            maybeSingle: async () => ({
              data: {
                id: RESERVA_ID,
                user_id: USER_ID,
                sede_id: SEDE_ID,
                sede: 'Sede Test',
                estado: 'completada',
                precio: 3000,
                monto_pagado: 3000,
                moneda: 'USD',
                pago_estado: 'pagado',
              },
              error: null,
            }),
          };
        }

        if (table === 'padcoins_campaigns') {
          return {
            select() { return this; },
            eq() { return this; },
            lte() { return this; },
            gte() { return this; },
            order() { return this; },
            limit: async () => ({ data: [], error: null }),
          };
        }

        throw new Error(`tabla inesperada: ${table}`);
      },
    },
  };
}

describe('padcoinsIdempotency — source key', () => {
  it('buildPadcoinsSourceKey concatena user, tipo, id y acción', () => {
    const key = buildPadcoinsSourceKey({
      userId: USER_ID,
      sourceType: 'reserva',
      sourceId: '99',
      action: 'earn',
    });
    assert.equal(key, `${USER_ID}|reserva|99|earn`);
  });
});

describe('padcoinsIdempotency — acreditación reserva', () => {
  it('misma reserva no acredita dos veces', async () => {
    const store = buildSaldoStore(0);

    const first = await addPadcoins(store.supabase, USER_ID, 150, {
      referencia_tipo: 'reserva',
      referencia_id: RESERVA_ID,
      sede_id: SEDE_ID,
      skipEarnCaps: true,
    });
    assert.equal(first.skipped, undefined);
    assert.equal(store.movimientos.length, 1);

    const second = await addPadcoins(store.supabase, USER_ID, 150, {
      referencia_tipo: 'reserva',
      referencia_id: RESERVA_ID,
      sede_id: SEDE_ID,
      skipEarnCaps: true,
    });
    assert.equal(second.skipped, true);
    assert.equal(second.reason, 'ya_acreditado');
    assert.equal(store.movimientos.length, 1);
  });

  it('ensurePadcoinsNotAlreadyApplied detecta movimiento previo', async () => {
    const store = buildSaldoStore(0);
    await addPadcoins(store.supabase, USER_ID, 100, {
      referencia_tipo: 'reserva',
      referencia_id: '55',
      skipEarnCaps: true,
    });

    const check = await ensurePadcoinsNotAlreadyApplied(store.supabase, {
      user_id: USER_ID,
      referencia_tipo: 'reserva',
      referencia_id: '55',
      tipo: 'earn',
    });
    assert.equal(check.alreadyApplied, true);
    assert.ok(check.movimiento?.id);
  });
});

describe('padcoinsIdempotency — campañas', () => {
  it('misma campaña no aplica dos veces a la misma reserva', async () => {
    const store = buildSaldoStore(0);
    const campaign = { id: 'camp-1', name: 'Doble', high_impact: false };

    const first = await recordCampaignApplication(store.supabase, {
      campaign,
      sedeId: SEDE_ID,
      userId: USER_ID,
      reservaId: RESERVA_ID,
      movimientoId: 'mov-1',
      basePadcoins: 100,
      finalPadcoins: 200,
      calculationDetail: { multiplier: 2 },
    });
    assert.ok(first.id);

    const second = await recordCampaignApplication(store.supabase, {
      campaign,
      sedeId: SEDE_ID,
      userId: USER_ID,
      reservaId: RESERVA_ID,
      movimientoId: 'mov-2',
      basePadcoins: 100,
      finalPadcoins: 200,
      calculationDetail: { multiplier: 2 },
    });
    assert.equal(second.duplicate, true);
    assert.equal(store.campaignApps.length, 1);
  });
});

describe('padcoinsIdempotency — canjes', () => {
  it('canje sin saldo falla', async () => {
    const store = buildSaldoStore(50);
    await assert.rejects(
      () => canjearPremioPadcoins(store.supabase, USER_ID, PREMIO_ID),
      /Saldo PadCoins insuficiente/,
    );
    assert.equal(store.canjes.length, 0);
  });

  it('canje con stock 0 falla', async () => {
    const store = buildSaldoStore(500, { premioStock: 0 });

    await assert.rejects(
      () => canjearPremioPadcoins(store.supabase, USER_ID, PREMIO_ID),
      /Stock del premio agotado|Premio no disponible para canje/,
    );
  });

  it('doble canje pendiente no duplica', async () => {
    const store = buildSaldoStore(500);

    const first = await canjearPremioPadcoins(store.supabase, USER_ID, PREMIO_ID);
    assert.equal(first.idempotent, undefined);
    assert.equal(store.canjes.length, 1);
    assert.equal(store.movimientos.length, 1);
    assert.equal(store.movimientos[0].referencia_tipo, PADCOINS_ORIGINS.CANJE_PREMIO);

    const second = await canjearPremioPadcoins(store.supabase, USER_ID, PREMIO_ID);
    assert.equal(second.idempotent, true);
    assert.equal(store.canjes.length, 1);
    assert.equal(store.movimientos.length, 1);
  });

  it('movimientos de canje quedan con metadata/source', async () => {
    const store = buildSaldoStore(500);
    await canjearPremioPadcoins(store.supabase, USER_ID, PREMIO_ID);

    const mov = store.movimientos[0];
    assert.equal(mov.referencia_tipo, PADCOINS_ORIGINS.CANJE_PREMIO);
    assert.ok(mov.referencia_id);
    assert.ok(mov.metadata?.source_type);
    assert.equal(mov.metadata.source_type, PADCOINS_ORIGINS.CANJE_PREMIO);
  });
});

describe('padcoinsIdempotency — penalización cancelación', () => {
  it('cancelación tardía idempotente no repite penalización', async () => {
    const store = buildSaldoStore(500);
    const reserva = {
      id: 55,
      user_id: USER_ID,
      sede_id: SEDE_ID,
      sede: 'Sede',
      estado: 'cancelada',
      fecha: '2026-07-10',
      hora: '18:00',
    };

    const first = await penalizarPadcoinsPorCancelacionTarde(store.supabase, 55, {
      reserva,
      horasAnticipacion: 6,
    });
    assert.equal(first.penalizado, true);

    const second = await penalizarPadcoinsPorCancelacionTarde(store.supabase, 55, {
      reserva,
      horasAnticipacion: 6,
    });
    assert.equal(second.penalizado, false);
    assert.equal(second.reason, 'ya_penalizada');
  });
});

describe('padcoinsIdempotency — acreditar reserva integración', () => {
  it('acreditar reserva completada es idempotente', async () => {
    const store = buildSaldoStore(0);

    const first = await acreditarPadcoinsPorReservaCompletada(store.supabase, RESERVA_ID, {
      skipEarnCaps: true,
      reservationConfig: {
        reserva_confirmada_fallback: 30,
        porcentaje_devolucion_reserva: 5,
        padcoins_por_usd_equivalente: 100,
        modo_calculo_reserva: 'porcentaje_valor_pagado',
      },
    });
    assert.equal(first.acreditado, true);

    const second = await acreditarPadcoinsPorReservaCompletada(store.supabase, RESERVA_ID, {
      skipEarnCaps: true,
      reservationConfig: {
        reserva_confirmada_fallback: 30,
        porcentaje_devolucion_reserva: 5,
        padcoins_por_usd_equivalente: 100,
        modo_calculo_reserva: 'porcentaje_valor_pagado',
      },
    });
    assert.equal(second.acreditado, false);
    assert.equal(second.reason, 'ya_acreditada');
  });
});

describe('padcoinsIdempotency — registerPadcoinsApplication helper', () => {
  it('registerPadcoinsApplication marca duplicate en 23505', async () => {
    let calls = 0;
    const result = await registerPadcoinsApplication(null, async () => {
      calls += 1;
      if (calls === 1) {
        const err = new Error('dup');
        err.code = '23505';
        err.message = 'padcoins_campaign_applications';
        throw err;
      }
      return { id: 'x' };
    });
    assert.equal(result.duplicate, true);
    assert.equal(result.applied, false);
  });
});
