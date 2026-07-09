import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  PADCOINS_EARNING_SOURCE_STATUSES,
  PADCOINS_EARNING_SOURCES_CATALOG,
} from '../src/padcoins/padcoinsEarningSourcesConfig.js';
import {
  buildPadcoinsEarningSourcesAdminResponse,
  buildEarningMovementOptions,
  buildSourceMetadata,
  calculatePadcoinsForSource,
  canReadPadcoinsEarningSources,
  canSourceBeAwarded,
  filterSourcesForAdminRole,
  getPadcoinsEarningSourceByKey,
  getPadcoinsEarningSources,
} from '../src/padcoins/padcoinsEarningSourcesService.js';
import { buildPadcoinsSourceKey } from '../src/padcoins/padcoinsIdempotencyService.js';
import { PADCOINS_GLOBAL_CONVERSION_RATE, PADCOINS_MIN_LOYALTY_PERCENT } from '../src/padcoins/padcoinsLoyaltyPolicyService.js';
import { validateSetupForSede } from '../src/setup/padbolMatchSetupService.js';

const USER_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

describe('padcoinsEarningSources — catálogo', () => {
  it('catálogo incluye reserva_jugada activa', () => {
    const source = getPadcoinsEarningSourceByKey('reserva_jugada');
    assert.ok(source);
    assert.equal(source.status, PADCOINS_EARNING_SOURCE_STATUSES.ACTIVE);
    assert.equal(source.default_enabled, true);
    assert.equal(source.legacy_referencia_tipo, 'reserva');
  });

  it('catálogo incluye fuentes futuras y planificadas', () => {
    const sources = getPadcoinsEarningSources();
    assert.ok(sources.length >= 15);

    const future = sources.filter((s) => s.status === PADCOINS_EARNING_SOURCE_STATUSES.FUTURE);
    const planned = sources.filter((s) => s.status === PADCOINS_EARNING_SOURCE_STATUSES.PLANNED);
    assert.ok(future.length >= 3);
    assert.ok(planned.length >= 3);

    const torneo = getPadcoinsEarningSourceByKey('campeon_torneo');
    assert.equal(torneo.status, PADCOINS_EARNING_SOURCE_STATUSES.FUTURE);
  });

  it('todas las fuentes del config tienen key y category', () => {
    for (const source of PADCOINS_EARNING_SOURCES_CATALOG) {
      assert.ok(source.key);
      assert.ok(source.category);
      assert.ok(source.label);
      assert.ok(source.calculation_type);
      assert.ok(source.status);
    }
  });
});

describe('padcoinsEarningSources — cálculo y seguridad', () => {
  it('calculate reserva_jugada respeta 5% mínimo y conversión 100:1', () => {
    const result = calculatePadcoinsForSource({
      sourceKey: 'reserva_jugada',
      userId: USER_ID,
      sedeId: 1,
      sourceId: '99',
      context: {
        reserva: {
          precio: 30,
          monto_pagado: 30,
          moneda: 'USD',
          pago_estado: 'pagado',
        },
        reservationConfig: {
          porcentaje_devolucion_reserva: 5,
          padcoins_por_usd_equivalente: 100,
          modo_calculo_reserva: 'porcentaje_valor_pagado',
          reserva_confirmada_fallback: 30,
        },
      },
    });

    assert.equal(result.ok, true);
    assert.equal(result.padcoins, 150);
    assert.equal(result.metadata.conversion_rate, PADCOINS_GLOBAL_CONVERSION_RATE);
    assert.equal(result.calculation_detail.minimum_loyalty_percentage, PADCOINS_MIN_LOYALTY_PERCENT);
    assert.equal(result.calculation_detail.loyalty_percentage, 5);
  });

  it('fuentes futuras no son awardable y no devuelven padcoins', () => {
    const result = calculatePadcoinsForSource({
      sourceKey: 'compra_eshop',
      userId: USER_ID,
      sedeId: 1,
      sourceId: 'order-1',
      context: { order_total: 100 },
    });

    assert.equal(result.ok, false);
    assert.equal(result.awardable, false);
    assert.equal(result.status, PADCOINS_EARNING_SOURCE_STATUSES.FUTURE);
    assert.equal(result.padcoins, null);
  });

  it('fuentes planificadas no acreditan directamente', () => {
    const award = canSourceBeAwarded('creador_partido');
    assert.equal(award.awardable, false);
    assert.equal(award.reason, 'source_planned');

    const calc = calculatePadcoinsForSource({
      sourceKey: 'creador_partido',
      userId: USER_ID,
      sedeId: 1,
      sourceId: 'partido-1',
    });
    assert.equal(calc.ok, false);
    assert.equal(calc.awardable, false);
  });

  it('metadata incluye source_key, source_type, source_id y action', () => {
    const metadata = buildSourceMetadata({
      sourceKey: 'reserva_jugada',
      userId: USER_ID,
      sedeId: 1,
      sourceId: '42',
      legacyReferenciaTipo: 'reserva',
    });

    assert.equal(metadata.earning_source_key, 'reserva_jugada');
    assert.equal(metadata.source_type, 'reserva');
    assert.equal(metadata.source_id, '42');
    assert.equal(metadata.action, 'earn');
    assert.ok(metadata.source_key);

    const expectedKey = buildPadcoinsSourceKey({
      userId: USER_ID,
      sourceType: 'reserva_jugada',
      sourceId: '42',
      action: 'earn',
    });
    assert.equal(metadata.source_key, expectedKey);
  });

  it('buildEarningMovementOptions mantiene referencia legacy reserva', () => {
    const options = buildEarningMovementOptions({
      sourceKey: 'reserva_jugada',
      userId: USER_ID,
      sedeId: 1,
      sourceId: '77',
    });

    assert.equal(options.referencia_tipo, 'reserva');
    assert.equal(options.referencia_id, '77');
    assert.equal(options.earning_source_key, 'reserva_jugada');
    assert.ok(options.metadata?.source_key);
  });
});

describe('padcoinsEarningSources — admin endpoint payload', () => {
  it('Super Admin ve todo el catálogo', () => {
    const payload = buildPadcoinsEarningSourcesAdminResponse({ rol: 'super_admin' });
    assert.equal(payload.ok, true);
    assert.ok(payload.categories.length > 0);
    assert.ok(payload.sources.length >= 15);
    assert.ok(payload.summary.active_count >= 2);
    assert.ok(payload.summary.planned_count >= 3);
    assert.ok(payload.summary.future_count >= 3);
    assert.ok(payload.message.includes('distintas acciones'));
  });

  it('Admin Club no ve fuentes de scope platform', () => {
    const all = getPadcoinsEarningSources();
    const clubVisible = filterSourcesForAdminRole(all, { rol: 'admin_club', sede_id: 1 });
    const platformSources = all.filter((s) => s.admin_scope === 'platform');

    assert.ok(platformSources.length >= 2);
    for (const platformSource of platformSources) {
      assert.ok(!clubVisible.some((s) => s.key === platformSource.key));
    }

    const payload = buildPadcoinsEarningSourcesAdminResponse(
      { rol: 'admin_club', sede_id: 1 },
      { sedeId: 1 },
    );
    assert.ok(payload.sources.every((s) => s.admin_scope === 'sede'));
  });

  it('Admin Nacional no tiene permiso de lectura', () => {
    assert.equal(canReadPadcoinsEarningSources({ rol: 'admin_nacional', sede_id: 1 }), false);
    assert.equal(canReadPadcoinsEarningSources({ rol: 'admin_club', sede_id: 1 }), true);
    assert.equal(canReadPadcoinsEarningSources({ rol: 'super_admin' }), true);
  });
});

describe('padcoinsEarningSources — setup integration', () => {
  function buildValidateStore() {
    return {
      from(table) {
        if (table === 'sedes') {
          return {
            select() { return this; },
            eq() { return this; },
            maybeSingle: async () => ({
              data: {
                id: 1,
                nombre: 'Sede Test',
                ciudad: 'La Plata',
                horario_apertura: '10:00',
                horario_cierre: '23:00',
                precio_90min: 3000,
                metodo_pago: 'mercadopago',
                mp_access_token: 'tok',
              },
              error: null,
            }),
          };
        }
        if (table === 'padcoins_sede_config') {
          return {
            select() { return this; },
            eq() { return this; },
            maybeSingle: async () => ({
              data: { id: 'cfg-1', sede_id: 1, activo: true, rule_overrides: { porcentaje_devolucion_reserva: 5 } },
              error: null,
            }),
          };
        }
        if (table === 'padcoins_global_config') {
          return {
            select() { return this; },
            eq() { return this; },
            order: async () => ({ data: [], error: null }),
          };
        }
        if (table === 'premios_canjeables') {
          return {
            select() { return this; },
            eq() { return this; },
            order() { return this; },
            then(resolve) {
              resolve({ data: [{ id: 'p1', sede_id: 1, nombre: 'Beneficio', activo: true, costo_padcoins: 200 }], error: null });
            },
          };
        }
        if (table === 'canchas') {
          return {
            select() { return this; },
            eq() { return this; },
            then(resolve) {
              resolve({ data: [{ id: 1, sede_id: 1, nombre: 'Cancha 1', estado: 'activa' }], error: null });
            },
          };
        }
        if (table === 'franjas_precio') {
          return {
            select() { return this; },
            eq() { return this; },
            then(resolve) {
              resolve({ data: [], error: null });
            },
          };
        }
        if (table === 'user_roles') {
          return {
            select(_c, opts) { this._head = opts?.head; return this; },
            eq() { return this; },
            then(resolve) {
              resolve({ count: 1, data: null, error: null });
            },
          };
        }
        if (table === 'padbol_match_setup_status') {
          return {
            select() { return this; },
            eq() { return this; },
            maybeSingle: async () => ({ data: null, error: null }),
            upsert(payload) {
              return {
                select() { return this; },
                single: async () => ({ data: { id: 'setup-1', ...payload }, error: null }),
              };
            },
          };
        }
        throw new Error(`tabla inesperada: ${table}`);
      },
    };
  }

  it('validate setup incluye fuentes activas y planificadas en sección PadCoins', async () => {
    const validation = await validateSetupForSede(buildValidateStore(), 1);
    const padcoins = validation.sections.find((s) => s.key === 'padcoins');

    assert.ok(padcoins);
    assert.ok(padcoins.earning_sources_message);
    assert.ok(Array.isArray(padcoins.earning_sources_active));
    assert.ok(padcoins.earning_sources_active.some((s) => s.key === 'reserva_jugada'));
    assert.ok(Array.isArray(padcoins.earning_sources_planned));
    assert.ok(Array.isArray(padcoins.earning_sources_future));
    assert.ok(padcoins.earning_sources_summary.active_count >= 2);
  });
});
