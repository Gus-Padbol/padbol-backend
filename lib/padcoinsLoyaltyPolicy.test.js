import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  BENEFIT_MAX_ESTIMATED_RESERVATIONS,
  BENEFIT_REACHABILITY,
  PADCOINS_GLOBAL_CONVERSION_RATE,
  PADCOINS_MIN_LOYALTY_PERCENT,
  buildCalculatorExamples,
  calculateBenefitLoyaltyMetrics,
  classifyBenefitReachability,
  enforcePadcoinsSedeRuleOverridesPolicy,
  evaluateBenefitReservationMetrics,
  evaluateLoyaltyPolicyForSede,
  isValidLoyaltyPercentageForActivePadcoins,
} from '../src/padcoins/padcoinsLoyaltyPolicyService.js';
import { updatePadcoinsSedeRuleOverrides } from '../src/padcoins/padcoinsEffectiveConfigService.js';
import { validateSetupForSede } from '../src/setup/padbolMatchSetupService.js';
import { PADBOL_MATCH_SETUP_STEPS } from '../src/setup/padbolMatchSetupConfig.js';

describe('padcoinsLoyaltyPolicy — porcentaje mínimo', () => {
  it('rechaza porcentaje menor a 5 cuando PadCoins está activo', () => {
    assert.throws(
      () => enforcePadcoinsSedeRuleOverridesPolicy(
        { porcentaje_devolucion_reserva: 4 },
        { padcoinsActive: true },
      ),
      /mínimo de fidelización.*5%/,
    );
  });

  it('permite porcentaje 5', () => {
    const result = enforcePadcoinsSedeRuleOverridesPolicy(
      { porcentaje_devolucion_reserva: 5 },
      { padcoinsActive: true },
    );
    assert.equal(result.porcentaje_devolucion_reserva, 5);
    assert.equal(isValidLoyaltyPercentageForActivePadcoins(5), true);
  });

  it('permite porcentaje mayor a 5', () => {
    const result = enforcePadcoinsSedeRuleOverridesPolicy(
      { porcentaje_devolucion_reserva: 8 },
      { padcoinsActive: true },
    );
    assert.equal(result.porcentaje_devolucion_reserva, 8);
    assert.equal(isValidLoyaltyPercentageForActivePadcoins(8), true);
  });
});

describe('padcoinsLoyaltyPolicy — conversión global', () => {
  it('calculadora usa conversión 100 a 1', () => {
    const metrics = calculateBenefitLoyaltyMetrics({
      valor_referencia_beneficio: 2,
      precio_turno: 30,
      porcentaje_fidelizacion: 5,
    });

    assert.equal(metrics.conversion_rate, 100);
    assert.equal(metrics.padcoins_necesarios, 200);
    assert.equal(metrics.padcoins_por_reserva, 150);
    assert.equal(metrics.reservas_aproximadas, 2);
  });

  it('calculadora usa 5% mínimo si no se informa porcentaje', () => {
    const metrics = calculateBenefitLoyaltyMetrics({
      valor_referencia_beneficio: 5,
      precio_turno: 30,
    });

    assert.equal(metrics.loyalty_percentage, PADCOINS_MIN_LOYALTY_PERCENT);
    assert.equal(metrics.padcoins_por_reserva, 150);
    assert.equal(metrics.reservas_aproximadas, 4);
  });

  it('no permite override de conversión por sede al escribir', () => {
    assert.throws(
      () => enforcePadcoinsSedeRuleOverridesPolicy(
        { padcoins_por_usd_equivalente: 80 },
        { padcoinsActive: true },
      ),
      /conversión global de PadCoins/,
    );
  });

  it('updatePadcoinsSedeRuleOverrides rechaza override de conversión', async () => {
    const supabase = {
      from(table) {
        if (table === 'padcoins_sede_config') {
          return {
            select() { return this; },
            eq() { return this; },
            maybeSingle: async () => ({
              data: {
                id: 'cfg-1',
                sede_id: 1,
                activo: true,
                descripcion: null,
                fecha_inicio: null,
                fecha_fin: null,
                rule_overrides: {},
              },
              error: null,
            }),
          };
        }
        throw new Error(table);
      },
    };

    await assert.rejects(
      () => updatePadcoinsSedeRuleOverrides(supabase, {
        sede_id: 1,
        rule_overrides: { padcoins_por_usd_equivalente: 90 },
      }),
      /conversión global de PadCoins/,
    );
  });
});

describe('padcoinsLoyaltyPolicy — calculadora y alertas', () => {
  it('classifyBenefitReachability aplica zonas de producto', () => {
    assert.equal(classifyBenefitReachability(1), BENEFIT_REACHABILITY.MUY_FACIL);
    assert.equal(classifyBenefitReachability(2), BENEFIT_REACHABILITY.BUENA);
    assert.equal(classifyBenefitReachability(8), BENEFIT_REACHABILITY.BUENA);
    assert.equal(classifyBenefitReachability(9), BENEFIT_REACHABILITY.ASPIRACIONAL);
    assert.equal(classifyBenefitReachability(20), BENEFIT_REACHABILITY.ASPIRACIONAL);
    assert.equal(classifyBenefitReachability(21), BENEFIT_REACHABILITY.DEMASIADO_LEJANO);
  });

  it('buildCalculatorExamples incluye reachability y balón aspiracional', () => {
    const examples = buildCalculatorExamples({ turn_price: 30, loyalty_percentage: 5 });

    assert.equal(examples.length, 3);
    assert.equal(examples[0].benefit, 'Bebida post partido');
    assert.equal(examples[0].required_padcoins, 200);
    assert.equal(examples[0].padcoins_per_reservation, 150);
    assert.equal(examples[0].estimated_reservations, 2);
    assert.equal(examples[0].reachability, BENEFIT_REACHABILITY.BUENA);
    assert.equal(examples[1].required_padcoins, 500);
    assert.equal(examples[1].estimated_reservations, 4);
    assert.equal(examples[1].reachability, BENEFIT_REACHABILITY.BUENA);
    assert.equal(examples[2].benefit, 'Balón Padbol');
    assert.equal(examples[2].required_padcoins, 2500);
    assert.equal(examples[2].estimated_reservations, 17);
    assert.equal(examples[2].reachability, BENEFIT_REACHABILITY.ASPIRACIONAL);
  });

  it('beneficio alcanzable queda en buena zona', () => {
    const evalResult = evaluateBenefitReservationMetrics(
      {
        id: 'p-ok',
        nombre: 'Bebida post partido',
        valor_referencia_interno: 2,
        costo_padcoins: 200,
      },
      { turn_price: 30, loyalty_percentage: 5 },
    );

    assert.equal(evalResult.reachability, BENEFIT_REACHABILITY.BUENA);
    assert.equal(evalResult.metrics.reservas_aproximadas, 2);
    const codes = evalResult.warnings.map((w) => w.code);
    assert.ok(!codes.includes('reservas_aproximadas_altas'));
  });

  it('beneficio aspiracional queda como aspiracional sin bloquear', () => {
    const evalResult = evaluateBenefitReservationMetrics(
      {
        id: 'p-asp',
        nombre: 'Balón Padbol',
        valor_referencia_interno: 25,
        costo_padcoins: 2500,
      },
      { turn_price: 30, loyalty_percentage: 5 },
    );

    assert.equal(evalResult.reachability, BENEFIT_REACHABILITY.ASPIRACIONAL);
    assert.equal(evalResult.metrics.reservas_aproximadas, 17);
    const codes = evalResult.warnings.map((w) => w.code);
    assert.ok(!codes.includes('reservas_aproximadas_altas'));
  });

  it('beneficio demasiado lejano genera warning', () => {
    const evalResult = evaluateBenefitReservationMetrics(
      {
        id: 'p-high',
        nombre: 'Premio premium',
        valor_referencia_interno: 50,
        costo_padcoins: 5000,
      },
      { turn_price: 30, loyalty_percentage: 5 },
    );

    assert.equal(evalResult.reachability, BENEFIT_REACHABILITY.DEMASIADO_LEJANO);
    assert.ok(evalResult.metrics.reservas_aproximadas > BENEFIT_MAX_ESTIMATED_RESERVATIONS);
    const codes = evalResult.warnings.map((w) => w.code);
    assert.ok(codes.includes('reservas_aproximadas_altas'));
  });

  it('evaluateLoyaltyPolicyForSede marca porcentaje bajo y override conversión', () => {
    const policy = evaluateLoyaltyPolicyForSede({
      effective_loyalty_percentage: 3,
      padcoins_active: true,
      sede_overrides: { padcoins_por_usd_equivalente: 80 },
      turn_price: 30,
    });

    assert.equal(policy.minimum_loyalty_percentage, PADCOINS_MIN_LOYALTY_PERCENT);
    assert.equal(policy.conversion_rate, PADCOINS_GLOBAL_CONVERSION_RATE);
    assert.equal(policy.current_loyalty_percentage, 3);
    assert.ok(policy.warnings.some((w) => w.code === 'porcentaje_fidelizacion_bajo_minimo'));
    assert.ok(policy.warnings.some((w) => w.code === 'override_conversion_sede'));
    assert.ok(policy.next_actions.length >= 2);
  });
});

describe('padcoinsLoyaltyPolicy — validate setup payload', () => {
  function buildValidateStore(overrides = {}) {
    const {
      padcoinsConfig = {
        id: 'cfg-1',
        sede_id: 1,
        activo: true,
        rule_overrides: { porcentaje_devolucion_reserva: 5 },
      },
      premios = [{ id: 'p1', sede_id: 1, nombre: 'Beneficio', activo: true, costo_padcoins: 200 }],
    } = overrides;

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
            maybeSingle: async () => ({ data: padcoinsConfig, error: null }),
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
              resolve({ data: premios, error: null });
            },
          };
        }

        if (table === 'canchas') {
          return {
            select() { return this; },
            eq() { return this; },
            then(resolve) {
              resolve({
                data: [{ id: 1, sede_id: 1, nombre: 'Cancha 1', estado: 'activa' }],
                error: null,
              });
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
            select(_c, opts) {
              this._countOnly = opts?.head === true;
              return this;
            },
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

  it('validate devuelve minimum_loyalty_percentage y conversion_rate en secciones', async () => {
    const validation = await validateSetupForSede(buildValidateStore(), 1);
    const padcoins = validation.sections.find((s) => s.key === 'padcoins');
    const beneficios = validation.sections.find((s) => s.key === 'beneficios');

    assert.ok(padcoins);
    assert.equal(padcoins.minimum_loyalty_percentage, 5);
    assert.equal(padcoins.conversion_rate, 100);
    assert.equal(padcoins.current_loyalty_percentage, 5);
    assert.ok(Array.isArray(padcoins.calculator_examples));
    assert.ok(padcoins.calculator_examples.length > 0);

    assert.ok(beneficios);
    assert.equal(beneficios.minimum_loyalty_percentage, 5);
    assert.equal(beneficios.conversion_rate, 100);
    assert.ok(validation.checklist.some((c) => c.key === PADBOL_MATCH_SETUP_STEPS.PADCOINS_DEFAULT_5_CONFIGURADO));
  });
});
