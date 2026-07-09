import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildBeneficiosSectionPayload,
  buildBenefitsSetupRecommendations,
  detectBenefitLoyaltyProfile,
  evaluateBenefitsList,
  getSuggestedInitialBenefits,
} from '../src/setup/padbolMatchSetupBenefitsService.js';
import { validateSetupForSede } from '../src/setup/padbolMatchSetupService.js';
import { PADBOL_MATCH_READINESS_LEVELS } from '../src/setup/padbolMatchSetupPhase2Config.js';
import { PADBOL_MATCH_SETUP_STEPS } from '../src/setup/padbolMatchSetupConfig.js';

function premioValido(overrides = {}) {
  return {
    id: 'premio-1',
    sede_id: 1,
    nombre: 'Descuento en próximo turno',
    descripcion: 'Beneficio para tu siguiente reserva en la sede.',
    costo_padcoins: 400,
    stock_total: 30,
    stock_disponible: 25,
    condiciones: 'Válido una vez por mes.',
    activo: true,
    ...overrides,
  };
}

describe('padbolMatchSetupBenefits — sugerencias', () => {
  it('getSuggestedInitialBenefits devuelve lista con campos requeridos', () => {
    const suggestions = getSuggestedInitialBenefits();
    assert.ok(suggestions.length >= 5);

    for (const item of suggestions) {
      assert.ok(item.name);
      assert.ok(item.category);
      assert.ok(item.why);
      assert.ok(item.suggested_padcoins_range?.min != null);
      assert.ok(item.suggested_padcoins_range?.max != null);
      assert.ok(item.loyalty_goal);
    }
  });
});

describe('padbolMatchSetupBenefits — evaluación', () => {
  it('sede sin beneficios → none + recomendaciones completas', () => {
    const result = buildBenefitsSetupRecommendations([]);
    assert.equal(result.has_benefits, false);
    assert.equal(result.loyalty_quality, 'none');
    assert.equal(result.count, 0);
    assert.ok(result.recommendations.length >= 5);
  });

  it('beneficio válido de fidelización → good', () => {
    const context = { turn_price: 30, loyalty_percentage: 5 };
    const result = evaluateBenefitsList([premioValido()], context);
    assert.equal(result.loyalty_quality, 'good');
    assert.equal(result.warnings.length, 0);
    assert.equal(result.strong_count, 1);
  });

  it('beneficio sin nombre/costo/stock genera warnings', () => {
    const result = evaluateBenefitsList([
      {
        id: 'p-bad',
        nombre: '  ',
        costo_padcoins: 0,
        stock_disponible: 0,
        stock_total: 0,
        descripcion: 'Producto tienda venta',
      },
    ]);

    const codes = result.warnings.map((w) => w.code);
    assert.ok(codes.includes('nombre_poco_claro'));
    assert.ok(codes.includes('costo_padcoins_invalido'));
    assert.ok(codes.includes('sin_stock_disponible'));
    assert.ok(codes.includes('bajo_impacto_fidelizacion'));
  });

  it('beneficios pobres generan recomendaciones faltantes', () => {
    const result = buildBenefitsSetupRecommendations([
      {
        id: 'p1',
        nombre: 'Producto de tienda',
        descripcion: 'Articulo de venta sin vinculo',
        costo_padcoins: 1800,
      },
    ]);

    assert.equal(result.loyalty_quality, 'poor');
    assert.ok(result.warnings.length > 0);
    assert.ok(result.recommendations.length > 0);
  });

  it('detectBenefitLoyaltyProfile identifica turno y bebida', () => {
    assert.equal(
      detectBenefitLoyaltyProfile({ nombre: 'Descuento proximo turno' }).category,
      'turno_fidelizacion',
    );
    assert.equal(
      detectBenefitLoyaltyProfile({ nombre: 'Bebida post partido' }).category,
      'consumo_post_partido',
    );
  });

  it('beneficio con muchas reservas estimadas genera warning de fidelización', () => {
    const result = evaluateBenefitsList([
      premioValido({
        nombre: 'Premio premium',
        valor_referencia_interno: 50,
        costo_padcoins: 5000,
      }),
    ], { turn_price: 30, loyalty_percentage: 5 });

    const codes = result.warnings.map((w) => w.code);
    assert.ok(codes.includes('reservas_aproximadas_altas'));
    assert.equal(result.items[0].reachability, 'demasiado_lejano');
  });

  it('todos aspiracionales alerta faltan beneficios alcanzables', () => {
    const context = { turn_price: 30, loyalty_percentage: 5 };
    const result = evaluateBenefitsList([
      premioValido({
        nombre: 'Balón Padbol',
        valor_referencia_interno: 25,
        costo_padcoins: 2500,
      }),
      premioValido({
        id: 'premio-2',
        nombre: 'Torneo premium',
        valor_referencia_interno: 20,
        costo_padcoins: 2000,
      }),
    ], context);

    const codes = result.warnings.map((w) => w.code);
    assert.ok(codes.includes('faltan_beneficios_alcanzables'));
  });

  it('solo productos sueltos recomienda beneficios de retorno', () => {
    const result = evaluateBenefitsList([
      {
        id: 'p1',
        nombre: 'Producto de tienda',
        descripcion: 'Articulo de venta sin vinculo',
        costo_padcoins: 300,
      },
      {
        id: 'p2',
        nombre: 'Articulo retail',
        descripcion: 'Compra en tienda',
        costo_padcoins: 400,
      },
    ], { turn_price: 30, loyalty_percentage: 5 });

    const codes = result.warnings.map((w) => w.code);
    assert.ok(codes.includes('faltan_beneficios_retorno'));
  });
});

describe('padbolMatchSetupBenefits — section payload', () => {
  it('buildBeneficiosSectionPayload missing sin beneficios', () => {
    const payload = buildBeneficiosSectionPayload({
      meta: {
        benefits_evaluation: buildBenefitsSetupRecommendations([]),
      },
    });

    assert.equal(payload.status, 'missing');
    assert.ok(payload.recommendations.length > 0);
    assert.equal(payload.loyalty_quality, 'none');
  });

  it('buildBeneficiosSectionPayload ok con beneficio fuerte', () => {
    const context = { turn_price: 30, loyalty_percentage: 5 };
    const payload = buildBeneficiosSectionPayload({
      meta: {
        benefits_evaluation: evaluateBenefitsList([premioValido()], context),
      },
    });

    assert.equal(payload.status, 'ok');
    assert.equal(payload.warnings.length, 0);
  });

  it('buildBeneficiosSectionPayload partial con warnings', () => {
    const payload = buildBeneficiosSectionPayload({
      meta: {
        benefits_evaluation: evaluateBenefitsList([
          premioValido({ costo_padcoins: 1500 }),
        ]),
      },
    });

    assert.equal(payload.status, 'partial');
    assert.ok(payload.warnings.length > 0);
  });
});

describe('padbolMatchSetupBenefits — integración validate', () => {
  function buildStore(premios = []) {
    const premioRows = [...premios];

    return {
      supabase: {
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
                  precio_90min: 15000,
                  metodo_pago: 'mercadopago',
                  mp_access_token: 'tok',
                },
                error: null,
              }),
            };
          }

          if (table === 'premios_canjeables') {
            const query = { sedeFilter: null };
            return {
              select() { return this; },
              eq(col, val) {
                if (col === 'sede_id') query.sedeFilter = Number(val);
                return this;
              },
              order() { return this; },
              then(resolve) {
                let rows = premioRows;
                if (query.sedeFilter != null) {
                  rows = rows.filter((r) => Number(r.sede_id) === query.sedeFilter);
                }
                resolve({ data: rows, error: null });
              },
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
                  rule_overrides: { porcentaje_devolucion_reserva: 5 },
                },
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
      },
    };
  }

  it('validate incluye recommendations en sección Beneficios sin premios', async () => {
    const store = buildStore([]);
    const validation = await validateSetupForSede(store.supabase, 1);
    const beneficios = validation.sections.find((s) => s.key === 'beneficios');

    assert.ok(beneficios);
    assert.equal(beneficios.status, 'missing');
    assert.ok(Array.isArray(beneficios.recommendations));
    assert.ok(beneficios.recommendations.length > 0);
    assert.ok(validation.missing.includes(PADBOL_MATCH_SETUP_STEPS.BENEFICIOS_INICIALES_CONFIGURADOS));
    assert.equal(validation.checklist.length, 6);
  });

  it('validate con beneficio válido mantiene readiness sin degradar por warnings vacíos', async () => {
    const store = buildStore([premioValido()]);
    const validation = await validateSetupForSede(store.supabase, 1);
    const beneficios = validation.sections.find((s) => s.key === 'beneficios');

    assert.equal(beneficios.status, 'ok');
    assert.equal(beneficios.warnings.length, 0);
    assert.equal(validation.readiness_level, PADBOL_MATCH_READINESS_LEVELS.READY);
  });

  it('warnings no degradan readiness_level a incomplete', async () => {
    const store = buildStore([
      premioValido({ costo_padcoins: 1500 }),
    ]);
    const validation = await validateSetupForSede(store.supabase, 1);
    const beneficios = validation.sections.find((s) => s.key === 'beneficios');

    assert.equal(beneficios.status, 'partial');
    assert.ok(beneficios.warnings.length > 0);
    assert.equal(validation.readiness_level, PADBOL_MATCH_READINESS_LEVELS.READY);
  });
});
