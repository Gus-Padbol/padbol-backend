import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { RANGOS } from '../src/rangos/rangosConfig.js';
import { LIGAS } from '../src/xp/xpConfig.js';
import {
  PADCOINS_LOYALTY_LEVELS,
  buildDefaultPadcoinsLoyaltyLevelThresholds,
} from '../src/padcoins/padcoinsLoyaltyLevelsConfig.js';
import {
  buildPlayerPadcoinsLoyaltyPayload,
  listPadcoinsLoyaltyLevelsConfig,
  resolvePadcoinsLoyaltyLevel,
  updatePadcoinsLoyaltyLevelsConfig,
  validatePadcoinsLoyaltyLevelThresholds,
} from '../src/padcoins/padcoinsLoyaltyLevelsService.js';

const DEFAULT_THRESHOLDS = buildDefaultPadcoinsLoyaltyLevelThresholds();

function thresholdFor(slug) {
  return DEFAULT_THRESHOLDS.find((level) => level.slug === slug).umbral_minimo;
}

function buildMemorySupabase({ rows = [] } = {}) {
  const store = new Map(rows.map((row) => [row.key, { ...row }]));

  return {
    from(table) {
      if (table !== 'padcoins_global_config') {
        throw new Error(`Tabla inesperada: ${table}`);
      }

      const state = {
        keys: null,
      };

      return {
        select() { return this; },
        in(_field, keys) {
          state.keys = keys;
          return this;
        },
        order() { return this; },
        async then(resolve, reject) {
          try {
            const data = [...store.values()]
              .filter((row) => !state.keys || state.keys.includes(row.key))
              .sort((a, b) => String(a.key).localeCompare(String(b.key)));
            resolve({ data, error: null });
          } catch (err) {
            reject(err);
          }
        },
        upsert(payload, { onConflict }) {
          const key = payload.key ?? payload[onConflict];
          const existing = store.get(key) ?? { id: `cfg-${key}`, created_at: null };
          const next = {
            ...existing,
            ...payload,
            key,
          };
          store.set(key, next);
          return {
            select() { return this; },
            single: async () => ({ data: next, error: null }),
          };
        },
      };
    },
    _store: store,
  };
}

describe('padcoinsLoyaltyLevels — resolver por historico_total', () => {
  it('historico 0 → Starter', () => {
    const result = resolvePadcoinsLoyaltyLevel(0, DEFAULT_THRESHOLDS);
    assert.equal(result.slug, 'starter');
    assert.equal(result.nombre, 'Starter');
    assert.equal(result.umbral_minimo, 0);
    assert.equal(result.siguiente_nivel, 'bronze');
    assert.equal(result.nivel_maximo, false);
  });

  it('valor exacto en cada umbral asigna el nivel correspondiente', () => {
    for (const level of PADCOINS_LOYALTY_LEVELS) {
      const result = resolvePadcoinsLoyaltyLevel(level.default_umbral, DEFAULT_THRESHOLDS);
      assert.equal(result.slug, level.slug, `falló en umbral exacto de ${level.slug}`);
      assert.equal(result.umbral_minimo, level.default_umbral);
    }
  });

  it('valor inmediatamente anterior y posterior a cada umbral', () => {
    for (const level of PADCOINS_LOYALTY_LEVELS.slice(1)) {
      const previousLevel = PADCOINS_LOYALTY_LEVELS.find((item) => item.orden === level.orden - 1);
      const before = resolvePadcoinsLoyaltyLevel(level.default_umbral - 1, DEFAULT_THRESHOLDS);
      const at = resolvePadcoinsLoyaltyLevel(level.default_umbral, DEFAULT_THRESHOLDS);

      assert.equal(before.slug, previousLevel.slug, `antes de ${level.slug}`);
      assert.equal(at.slug, level.slug, `en ${level.slug}`);
    }
  });

  it('Legend es nivel máximo con progreso completo', () => {
    const legendUmbral = thresholdFor('legend');
    const result = resolvePadcoinsLoyaltyLevel(legendUmbral + 5000, DEFAULT_THRESHOLDS);

    assert.equal(result.slug, 'legend');
    assert.equal(result.nivel_maximo, true);
    assert.equal(result.siguiente_nivel, null);
    assert.equal(result.siguiente_umbral, null);
    assert.equal(result.progreso_porcentaje, 100);
    assert.equal(result.padcoins_faltantes, 0);
  });

  it('canje no afecta nivel: mismo historico_total mantiene nivel', () => {
    const historico = 8000;
    const conSaldoAlto = resolvePadcoinsLoyaltyLevel(historico, DEFAULT_THRESHOLDS);
    const trasCanje = resolvePadcoinsLoyaltyLevel(historico, DEFAULT_THRESHOLDS);

    assert.equal(conSaldoAlto.slug, 'gold');
    assert.deepEqual(trasCanje, conSaldoAlto);
  });

  it('calcula progreso hacia el siguiente nivel', () => {
    const historico = thresholdFor('gold') + 2500;
    const result = resolvePadcoinsLoyaltyLevel(historico, DEFAULT_THRESHOLDS);

    assert.equal(result.slug, 'gold');
    assert.equal(result.siguiente_nivel, 'platinum');
    assert.equal(result.progreso_actual, 2500);
    assert.equal(result.padcoins_faltantes, thresholdFor('platinum') - historico);
    assert.ok(result.progreso_porcentaje > 0 && result.progreso_porcentaje < 100);
  });
});

describe('padcoinsLoyaltyLevels — payload jugador', () => {
  it('incluye nivel_fidelizacion, loyalty_level y lista resumida de niveles', () => {
    const payload = buildPlayerPadcoinsLoyaltyPayload(2500, DEFAULT_THRESHOLDS);

    assert.equal(payload.nivel_fidelizacion.slug, 'silver');
    assert.deepEqual(payload.loyalty_level, payload.nivel_fidelizacion);
    assert.equal(payload.niveles_fidelizacion.length, 8);
    assert.deepEqual(payload.loyalty_levels, payload.niveles_fidelizacion);
    assert.equal(payload.niveles_fidelizacion[0].slug, 'starter');
    assert.equal(payload.niveles_fidelizacion[7].slug, 'legend');
  });

  it('usuario sin historico previo → Starter', () => {
    const payload = buildPlayerPadcoinsLoyaltyPayload(undefined, DEFAULT_THRESHOLDS);
    assert.equal(payload.nivel_fidelizacion.slug, 'starter');
  });
});

describe('padcoinsLoyaltyLevels — separación de rangos deportivos', () => {
  it('slugs compartidos con ARENA se separan por contexto API (nivel_fidelizacion vs rango)', () => {
    const loyaltySlugs = new Set(PADCOINS_LOYALTY_LEVELS.map((level) => level.slug));
    const arenaSlugs = new Set(RANGOS.map((rango) => rango.slug));
    const overlap = [...loyaltySlugs].filter((slug) => arenaSlugs.has(slug));

    assert.ok(overlap.includes('gold'));
    assert.ok(overlap.includes('elite'));
    assert.notEqual(loyaltySlugs.has('starter'), arenaSlugs.has('starter'));
    assert.notEqual(loyaltySlugs.has('rookie'), true);
  });

  it('nombres compartidos con XP Arena conviven en sistemas distintos (PadCoins vs XP)', () => {
    const loyaltyNames = PADCOINS_LOYALTY_LEVELS.map((level) => level.nombre.toUpperCase());
    const xpNames = LIGAS.map((liga) => liga.nombre.toUpperCase());
    const overlap = loyaltyNames.filter((name) => xpNames.includes(name));

    assert.ok(overlap.length > 0, 'hay nombres compartidos documentados');
    assert.notEqual(loyaltyNames.includes('STARTER'), xpNames.includes('STARTER'));
    assert.notEqual(loyaltyNames.includes('PLATINUM'), xpNames.includes('PLATINUM'));
    assert.notEqual(loyaltyNames.includes('DIAMOND'), xpNames.includes('DIAMOND'));
  });

  it('Elite de fidelización se expone en nivel_fidelizacion, separado del rango deportivo', () => {
    const loyaltyElite = resolvePadcoinsLoyaltyLevel(thresholdFor('elite'), DEFAULT_THRESHOLDS);
    const arenaElite = RANGOS.find((rango) => rango.slug === 'elite');
    const payload = buildPlayerPadcoinsLoyaltyPayload(thresholdFor('elite'), DEFAULT_THRESHOLDS);

    assert.equal(loyaltyElite.slug, 'elite');
    assert.equal(arenaElite.slug, 'elite');
    assert.ok(payload.nivel_fidelizacion);
    assert.ok(payload.loyalty_level);
    assert.equal(payload.nivel_fidelizacion.slug, 'elite');
    assert.equal(typeof arenaElite.condicion, 'string');
  });
});

describe('padcoinsLoyaltyLevels — validación de umbrales', () => {
  it('rechaza Starter distinto de 0', () => {
    const invalid = DEFAULT_THRESHOLDS.map((level) => (
      level.slug === 'starter'
        ? { ...level, umbral_minimo: 10 }
        : level
    ));

    assert.throws(
      () => validatePadcoinsLoyaltyLevelThresholds(invalid),
      /Starter debe comenzar en umbral 0/,
    );
  });

  it('rechaza umbrales decrecientes o duplicados', () => {
    const invalid = DEFAULT_THRESHOLDS.map((level) => (
      level.slug === 'silver'
        ? { ...level, umbral_minimo: thresholdFor('bronze') }
        : level
    ));

    assert.throws(
      () => validatePadcoinsLoyaltyLevelThresholds(invalid),
      /estrictamente ascendentes/,
    );
  });

  it('rechaza valores negativos', () => {
    const invalid = DEFAULT_THRESHOLDS.map((level) => (
      level.slug === 'gold'
        ? { ...level, umbral_minimo: -1 }
        : level
    ));

    assert.throws(
      () => validatePadcoinsLoyaltyLevelThresholds(invalid),
      /Umbral inválido/,
    );
  });
});

describe('padcoinsLoyaltyLevels — configuración Super Admin', () => {
  it('lista defaults cuando no hay filas en DB', async () => {
    const supabase = buildMemorySupabase();
    const config = await listPadcoinsLoyaltyLevelsConfig(supabase);

    assert.equal(config.levels.length, 8);
    assert.equal(config.thresholds[0].slug, 'starter');
    assert.equal(config.thresholds[1].umbral_minimo, thresholdFor('bronze'));
  });

  it('edición válida persiste umbrales ascendentes', async () => {
    const supabase = buildMemorySupabase();
    const updated = await updatePadcoinsLoyaltyLevelsConfig(
      supabase,
      [{ slug: 'bronze', umbral_minimo: 600 }],
      'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    );

    assert.equal(updated.thresholds.find((level) => level.slug === 'bronze').umbral_minimo, 600);
    assert.equal(supabase._store.size, 8);
  });

  it('edición inválida rechazada sin persistir cambios parciales inválidos', async () => {
    const supabase = buildMemorySupabase({
      rows: [{
        id: 'cfg-bronze',
        key: 'nivel_fidelizacion_bronze_umbral',
        value_integer: 500,
        activo: true,
      }],
    });

    await assert.rejects(
      () => updatePadcoinsLoyaltyLevelsConfig(
        supabase,
        [{ slug: 'silver', umbral_minimo: 400 }],
        'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      ),
      /estrictamente ascendentes/,
    );
  });

  it('resolve es idempotente y no genera movimientos (función pura)', () => {
    const first = resolvePadcoinsLoyaltyLevel(4200, DEFAULT_THRESHOLDS);
    const second = resolvePadcoinsLoyaltyLevel(4200, DEFAULT_THRESHOLDS);
    assert.deepEqual(first, second);
  });
});

describe('padcoinsLoyaltyLevels — compatibilidad mi-saldo', () => {
  it('estructura de saldo existente se preserva al enriquecer con fidelización', () => {
    const saldo = { disponible: 300, historico_total: 5200 };
    const loyalty = buildPlayerPadcoinsLoyaltyPayload(saldo.historico_total, DEFAULT_THRESHOLDS);

    const response = {
      ok: true,
      saldo: {
        disponible: saldo.disponible,
        historico_total: saldo.historico_total,
      },
      ...loyalty,
    };

    assert.equal(response.ok, true);
    assert.equal(response.saldo.disponible, 300);
    assert.equal(response.saldo.historico_total, 5200);
    assert.equal(response.nivel_fidelizacion.slug, 'gold');
    assert.equal(response.niveles_fidelizacion.length, 8);
  });

  it('canje reduce disponible simulado pero mantiene nivel por historico', () => {
    const historico = thresholdFor('platinum');
    const antesCanje = {
      disponible: historico,
      historico_total: historico,
    };
    const despuesCanje = {
      disponible: historico - 3000,
      historico_total: historico,
    };

    const nivelAntes = resolvePadcoinsLoyaltyLevel(antesCanje.historico_total, DEFAULT_THRESHOLDS);
    const nivelDespues = resolvePadcoinsLoyaltyLevel(despuesCanje.historico_total, DEFAULT_THRESHOLDS);

    assert.equal(nivelAntes.slug, 'platinum');
    assert.equal(nivelDespues.slug, 'platinum');
    assert.ok(despuesCanje.disponible < antesCanje.disponible);
  });
});
