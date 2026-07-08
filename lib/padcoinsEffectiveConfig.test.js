import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildEffectivePadcoinsConfig,
  buildGlobalPadcoinsConfigMap,
  getEffectivePadcoinsValueForSede,
  normalizePadcoinsSedeRuleOverrides,
  resolvePadcoinsConfigForSede,
  updatePadcoinsSedeRuleOverrides,
  validatePadcoinsSedeRuleOverridesForWrite,
} from '../src/padcoins/padcoinsEffectiveConfigService.js';
import {
  PADCOINS_GLOBAL_CONFIG_DEFAULTS,
  PADCOINS_GLOBAL_CONFIG_TEXT_DEFAULTS,
} from '../src/padcoins/padcoinsGlobalConfigService.js';
import {
  canReadPadcoinsSedeConfig,
  canWritePadcoinsSedeConfig,
} from '../src/padcoins/padcoinsSedeConfigService.js';

describe('normalizePadcoinsSedeRuleOverrides', () => {
  it('acepta enteros planos y descarta keys inválidas', () => {
    const result = normalizePadcoinsSedeRuleOverrides({
      limite_diario_jugador: 500,
      logro_desbloqueado: 750,
      foo_bar: 99,
      limite_mensual_jugador: 'abc',
    });

    assert.deepEqual(result, {
      limite_diario_jugador: 500,
      logro_desbloqueado: 750,
    });
  });

  it('acepta value_integer / value_text estructurados', () => {
    const result = normalizePadcoinsSedeRuleOverrides({
      cancelacion_tarde: { value_integer: -150 },
      modo_calculo_reserva: { value_text: 'porcentaje_valor_pagado' },
    });

    assert.deepEqual(result, {
      cancelacion_tarde: -150,
      modo_calculo_reserva: 'porcentaje_valor_pagado',
    });
  });

  it('null o no-objeto → {}', () => {
    assert.deepEqual(normalizePadcoinsSedeRuleOverrides(null), {});
    assert.deepEqual(normalizePadcoinsSedeRuleOverrides([]), {});
  });
});

describe('buildGlobalPadcoinsConfigMap', () => {
  it('mezcla int/text con defaults de código', () => {
    const global = buildGlobalPadcoinsConfigMap(
      { limite_diario_jugador: 800 },
      { modo_calculo_reserva: 'porcentaje_valor_pagado' },
    );

    assert.equal(global.limite_diario_jugador, 800);
    assert.equal(global.logro_desbloqueado, PADCOINS_GLOBAL_CONFIG_DEFAULTS.logro_desbloqueado);
    assert.equal(
      global.modo_calculo_reserva,
      PADCOINS_GLOBAL_CONFIG_TEXT_DEFAULTS.modo_calculo_reserva,
    );
  });
});

describe('buildEffectivePadcoinsConfig', () => {
  it('sin overrides hereda global', () => {
    const global = buildGlobalPadcoinsConfigMap({}, {});
    const effective = buildEffectivePadcoinsConfig(global, {});

    assert.deepEqual(effective, global);
    assert.equal(effective.limite_diario_jugador, PADCOINS_GLOBAL_CONFIG_DEFAULTS.limite_diario_jugador);
  });

  it('override pisa global solo en keys válidas', () => {
    const global = buildGlobalPadcoinsConfigMap({}, {});
    const effective = buildEffectivePadcoinsConfig(global, {
      limite_diario_jugador: 250,
      no_show: -500,
    });

    assert.equal(effective.limite_diario_jugador, 250);
    assert.equal(effective.no_show, -500);
    assert.equal(effective.limite_mensual_jugador, global.limite_mensual_jugador);
  });
});

describe('resolvePadcoinsConfigForSede', () => {
  function buildSupabase({ sedeOverrides = null, globalRows = [] } = {}) {
    return {
      from(table) {
        if (table === 'padcoins_global_config') {
          return {
            select() { return this; },
            eq() { return this; },
            order: async () => ({ data: globalRows, error: null }),
            maybeSingle: async () => ({ data: null, error: null }),
          };
        }

        if (table === 'padcoins_sede_config') {
          return {
            select() { return this; },
            eq() { return this; },
            maybeSingle: async () => ({
              data: sedeOverrides == null
                ? null
                : {
                  id: 'cfg-1',
                  sede_id: 1,
                  activo: true,
                  descripcion: 'Piloto',
                  fecha_inicio: null,
                  fecha_fin: null,
                  created_at: null,
                  updated_at: null,
                  updated_by: null,
                  rule_overrides: sedeOverrides,
                },
              error: null,
            }),
          };
        }

        if (table === 'sedes') {
          return {
            select() { return this; },
            eq() { return this; },
            maybeSingle: async () => ({ data: { id: 1, nombre: 'La Meca' }, error: null }),
          };
        }

        throw new Error(`tabla inesperada: ${table}`);
      },
    };
  }

  it('sede sin overrides hereda global', async () => {
    const result = await resolvePadcoinsConfigForSede(buildSupabase(), 1);

    assert.equal(result.sede_id, 1);
    assert.equal(result.sede.nombre, 'La Meca');
    assert.deepEqual(result.sede_overrides, {});
    assert.equal(result.effective.logro_desbloqueado, PADCOINS_GLOBAL_CONFIG_DEFAULTS.logro_desbloqueado);
    assert.equal(result.global.limite_mensual_jugador, PADCOINS_GLOBAL_CONFIG_DEFAULTS.limite_mensual_jugador);
  });

  it('sede con override pisa global', async () => {
    const result = await resolvePadcoinsConfigForSede(
      buildSupabase({ sedeOverrides: { logro_desbloqueado: 900, cancelacion_tarde: -200 } }),
      1,
    );

    assert.deepEqual(result.sede_overrides, {
      logro_desbloqueado: 900,
      cancelacion_tarde: -200,
    });
    assert.equal(result.effective.logro_desbloqueado, 900);
    assert.equal(result.effective.cancelacion_tarde, -200);
    assert.equal(result.global.logro_desbloqueado, PADCOINS_GLOBAL_CONFIG_DEFAULTS.logro_desbloqueado);
  });

  it('sede_id inválido → 400', async () => {
    await assert.rejects(
      () => resolvePadcoinsConfigForSede(buildSupabase(), 'x'),
      (err) => err.status === 400,
    );
  });
});

describe('getEffectivePadcoinsValueForSede', () => {
  function buildSupabase({ sedeOverrides = {} } = {}) {
    return {
      from(table) {
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
                descripcion: null,
                fecha_inicio: null,
                fecha_fin: null,
                rule_overrides: sedeOverrides,
                created_at: null,
                updated_at: null,
                updated_by: null,
              },
              error: null,
            }),
          };
        }
        if (table === 'sedes') {
          return {
            select() { return this; },
            eq() { return this; },
            maybeSingle: async () => ({ data: { id: 1, nombre: 'La Meca' }, error: null }),
          };
        }
        throw new Error(table);
      },
    };
  }

  it('sin sedeId usa fallback global/default', async () => {
    const value = await getEffectivePadcoinsValueForSede(
      buildSupabase(),
      null,
      'limite_diario_jugador',
    );
    assert.equal(value, PADCOINS_GLOBAL_CONFIG_DEFAULTS.limite_diario_jugador);
  });

  it('con override de sede devuelve effective', async () => {
    const value = await getEffectivePadcoinsValueForSede(
      buildSupabase({ sedeOverrides: { limite_diario_jugador: 500 } }),
      1,
      'limite_diario_jugador',
    );
    assert.equal(value, 500);
  });

  it('sin override hereda global', async () => {
    const value = await getEffectivePadcoinsValueForSede(
      buildSupabase({ sedeOverrides: {} }),
      1,
      'cancelacion_tarde',
    );
    assert.equal(value, PADCOINS_GLOBAL_CONFIG_DEFAULTS.cancelacion_tarde);
  });

  it('si resolver falla conserva fallback global', async () => {
    const flaky = {
      from(table) {
        if (table === 'padcoins_global_config') {
          return {
            select() { return this; },
            eq() { return this; },
            order: async () => ({ data: [], error: null }),
            maybeSingle: async () => ({ data: null, error: null }),
          };
        }
        return {
          select() { return this; },
          eq() { return this; },
          maybeSingle: async () => ({ data: null, error: { message: 'db down', code: 'XX000' } }),
        };
      },
    };
    const value = await getEffectivePadcoinsValueForSede(flaky, 1, 'no_show');
    assert.equal(value, PADCOINS_GLOBAL_CONFIG_DEFAULTS.no_show);
  });
});

describe('canReadPadcoinsSedeConfig — permisos', () => {
  it('super_admin puede cualquier sede', () => {
    assert.equal(canReadPadcoinsSedeConfig({ rol: 'super_admin' }, 99), true);
  });

  it('admin_club solo su sede', () => {
    assert.equal(canReadPadcoinsSedeConfig({ rol: 'admin_club', sede_id: 2 }, 2), true);
    assert.equal(canReadPadcoinsSedeConfig({ rol: 'admin_club', sede_id: 2 }, 3), false);
  });

  it('admin_club sin sede_id → false', () => {
    assert.equal(canReadPadcoinsSedeConfig({ rol: 'admin_club', sede_id: null }, 1), false);
  });

  it('otros roles → false', () => {
    assert.equal(canReadPadcoinsSedeConfig({ rol: 'admin_nacional' }, 1), false);
  });
});

describe('canWritePadcoinsSedeConfig — permisos escritura', () => {
  it('super_admin puede editar cualquier sede', () => {
    assert.equal(canWritePadcoinsSedeConfig({ rol: 'super_admin' }, 1), true);
    assert.equal(canWritePadcoinsSedeConfig({ rol: 'super_admin' }, 99), true);
  });

  it('admin_club edita solo su sede', () => {
    assert.equal(canWritePadcoinsSedeConfig({ rol: 'admin_club', sede_id: 2 }, 2), true);
    assert.equal(canWritePadcoinsSedeConfig({ rol: 'admin_club', sede_id: 2 }, 3), false);
  });

  it('admin_club sin sede_id no edita', () => {
    assert.equal(canWritePadcoinsSedeConfig({ rol: 'admin_club', sede_id: null }, 1), false);
  });
});

describe('validatePadcoinsSedeRuleOverridesForWrite', () => {
  it('acepta enteros y limpia con {}', () => {
    assert.deepEqual(
      validatePadcoinsSedeRuleOverridesForWrite({
        limite_diario_jugador: 500,
        cancelacion_tarde: -50,
      }),
      { limite_diario_jugador: 500, cancelacion_tarde: -50 },
    );
    assert.deepEqual(validatePadcoinsSedeRuleOverridesForWrite({}), {});
  });

  it('rechaza key inexistente', () => {
    assert.throws(
      () => validatePadcoinsSedeRuleOverridesForWrite({ foo_bar: 1 }),
      (err) => err.status === 400 && err.message.includes('foo_bar'),
    );
  });

  it('rechaza null, arrays y objetos anidados', () => {
    assert.throws(
      () => validatePadcoinsSedeRuleOverridesForWrite({ limite_diario_jugador: null }),
      /null no permitido/,
    );
    assert.throws(
      () => validatePadcoinsSedeRuleOverridesForWrite({ limite_diario_jugador: [500] }),
      /array/,
    );
    assert.throws(
      () => validatePadcoinsSedeRuleOverridesForWrite({ limite_diario_jugador: { value_integer: 500 } }),
      /objeto anidado/,
    );
  });

  it('text key requiere string no vacío', () => {
    assert.equal(
      validatePadcoinsSedeRuleOverridesForWrite({ modo_calculo_reserva: 'porcentaje_valor_pagado' }).modo_calculo_reserva,
      'porcentaje_valor_pagado',
    );
    assert.throws(
      () => validatePadcoinsSedeRuleOverridesForWrite({ modo_calculo_reserva: 123 }),
      /debe ser texto/,
    );
  });
});

describe('updatePadcoinsSedeRuleOverrides', () => {
  let storedOverrides = { limite_diario_jugador: 300 };

  function buildWriteSupabase() {
    return {
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
                descripcion: 'Piloto',
                fecha_inicio: null,
                fecha_fin: null,
                created_at: null,
                updated_at: null,
                updated_by: null,
                rule_overrides: storedOverrides,
              },
              error: null,
            }),
            upsert(payload) {
              storedOverrides = payload.rule_overrides;
              const row = {
                id: 'cfg-1',
                sede_id: payload.sede_id,
                activo: payload.activo,
                descripcion: payload.descripcion,
                fecha_inicio: payload.fecha_inicio,
                fecha_fin: payload.fecha_fin,
                rule_overrides: payload.rule_overrides,
                created_at: null,
                updated_at: payload.updated_at,
                updated_by: payload.updated_by,
              };
              return {
                select() { return this; },
                single: async () => ({ data: row, error: null }),
              };
            },
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

        throw new Error(`tabla inesperada: ${table}`);
      },
    };
  }

  it('guarda overrides y effective los refleja', async () => {
    storedOverrides = {};
    const supabase = buildWriteSupabase();

    await updatePadcoinsSedeRuleOverrides(supabase, {
      sede_id: 1,
      rule_overrides: { limite_diario_jugador: 500, cancelacion_tarde: -50 },
      updated_by: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    });

    const resolved = await resolvePadcoinsConfigForSede(supabase, 1);

    assert.deepEqual(resolved.sede_overrides, {
      limite_diario_jugador: 500,
      cancelacion_tarde: -50,
    });
    assert.equal(resolved.effective.limite_diario_jugador, 500);
    assert.equal(resolved.effective.cancelacion_tarde, -50);
    assert.equal(
      resolved.global.limite_diario_jugador,
      PADCOINS_GLOBAL_CONFIG_DEFAULTS.limite_diario_jugador,
    );
  });

  it('{} limpia overrides y effective vuelve a global', async () => {
    storedOverrides = { limite_diario_jugador: 500 };
    const supabase = buildWriteSupabase();

    await updatePadcoinsSedeRuleOverrides(supabase, {
      sede_id: 1,
      rule_overrides: {},
    });

    const resolved = await resolvePadcoinsConfigForSede(supabase, 1);

    assert.deepEqual(resolved.sede_overrides, {});
    assert.equal(
      resolved.effective.limite_diario_jugador,
      PADCOINS_GLOBAL_CONFIG_DEFAULTS.limite_diario_jugador,
    );
  });

  it('preserva activo y fechas al guardar overrides', async () => {
    let upsertPayload = null;
    const supabase = {
      from(table) {
        if (table === 'padcoins_sede_config') {
          return {
            select() { return this; },
            eq() { return this; },
            maybeSingle: async () => ({
              data: {
                id: 'cfg-1',
                sede_id: 2,
                activo: true,
                descripcion: 'Sede 2',
                fecha_inicio: '2026-01-01T00:00:00.000Z',
                fecha_fin: null,
                rule_overrides: {},
                created_at: null,
                updated_at: null,
                updated_by: null,
              },
              error: null,
            }),
            upsert(payload) {
              upsertPayload = payload;
              return {
                select() { return this; },
                single: async () => ({ data: { ...payload, id: 'cfg-1' }, error: null }),
              };
            },
          };
        }
        throw new Error(table);
      },
    };

    await updatePadcoinsSedeRuleOverrides(supabase, {
      sede_id: 2,
      rule_overrides: { no_show: -400 },
    });

    assert.equal(upsertPayload.activo, true);
    assert.equal(upsertPayload.descripcion, 'Sede 2');
    assert.equal(upsertPayload.fecha_inicio, '2026-01-01T00:00:00.000Z');
    assert.deepEqual(upsertPayload.rule_overrides, { no_show: -400 });
  });
});
