import {
  PADCOINS_LOYALTY_LEVELS,
  buildDefaultPadcoinsLoyaltyLevelThresholds,
  isPadcoinsLoyaltyLevelSlug,
  padcoinsLoyaltyLevelConfigKey,
} from './padcoinsLoyaltyLevelsConfig.js';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isMissingTable(error) {
  const message = String(error?.message ?? '').toLowerCase();
  return (
    error?.code === '42P01'
    || error?.code === 'PGRST205'
    || message.includes('does not exist')
    || message.includes('could not find the table')
  );
}

function buildHttpError(message, status = 400) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function parseNonNegativeInteger(raw, fieldName) {
  const parsed = Number.parseInt(String(raw), 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw buildHttpError(`${fieldName} debe ser un entero >= 0`);
  }
  return parsed;
}

function mergeThresholdOverrides(baseThresholds, overridesBySlug) {
  return baseThresholds.map((level) => {
    if (!Object.prototype.hasOwnProperty.call(overridesBySlug, level.slug)) {
      return { ...level };
    }
    return {
      ...level,
      umbral_minimo: overridesBySlug[level.slug],
    };
  });
}

export function validatePadcoinsLoyaltyLevelThresholds(thresholds) {
  if (!Array.isArray(thresholds) || thresholds.length !== PADCOINS_LOYALTY_LEVELS.length) {
    throw buildHttpError('Debe definir los 8 niveles de fidelización PadCoins');
  }

  const starter = thresholds.find((level) => level.slug === 'starter');
  if (!starter || starter.umbral_minimo !== 0) {
    throw buildHttpError('El nivel Starter debe comenzar en umbral 0');
  }

  const sorted = [...thresholds].sort((a, b) => a.orden - b.orden);
  let previous = -1;

  for (const level of sorted) {
    if (!isPadcoinsLoyaltyLevelSlug(level.slug)) {
      throw buildHttpError(`Nivel de fidelización inválido: ${level.slug ?? 'desconocido'}`);
    }
    if (!Number.isInteger(level.umbral_minimo) || level.umbral_minimo < 0) {
      throw buildHttpError(`Umbral inválido para ${level.slug}`);
    }
    if (level.umbral_minimo <= previous) {
      throw buildHttpError(
        `Los umbrales deben ser estrictamente ascendentes sin duplicados (${level.slug}: ${level.umbral_minimo})`,
      );
    }
    previous = level.umbral_minimo;
  }

  return sorted;
}

export function resolvePadcoinsLoyaltyLevel(historicoTotal, thresholds = buildDefaultPadcoinsLoyaltyLevelThresholds()) {
  const historico = Math.max(0, Number(historicoTotal) || 0);
  const levels = validatePadcoinsLoyaltyLevelThresholds(thresholds);

  let currentIndex = 0;
  for (let index = 0; index < levels.length; index += 1) {
    if (historico >= levels[index].umbral_minimo) {
      currentIndex = index;
    }
  }

  const current = levels[currentIndex];
  const isMax = currentIndex === levels.length - 1;
  const next = isMax ? null : levels[currentIndex + 1];

  const progreso_actual = historico - current.umbral_minimo;
  let progreso_porcentaje = 100;
  let padcoins_faltantes = 0;
  let siguiente_nivel = null;
  let siguiente_umbral = null;

  if (!isMax && next) {
    const range = next.umbral_minimo - current.umbral_minimo;
    progreso_porcentaje = range > 0
      ? Math.min(100, Math.floor((progreso_actual / range) * 100))
      : 0;
    padcoins_faltantes = Math.max(0, next.umbral_minimo - historico);
    siguiente_nivel = next.slug;
    siguiente_umbral = next.umbral_minimo;
  }

  return {
    nivel_actual: current.orden,
    nombre: current.nombre,
    slug: current.slug,
    umbral_minimo: current.umbral_minimo,
    siguiente_nivel,
    siguiente_umbral,
    progreso_actual,
    progreso_porcentaje,
    padcoins_faltantes,
    nivel_maximo: isMax,
  };
}

export function buildPadcoinsLoyaltyLevelsSummary(thresholds = buildDefaultPadcoinsLoyaltyLevelThresholds()) {
  const levels = validatePadcoinsLoyaltyLevelThresholds(thresholds);
  return levels.map((level) => ({
    slug: level.slug,
    nombre: level.nombre,
    orden: level.orden,
    umbral_minimo: level.umbral_minimo,
  }));
}

export function buildPlayerPadcoinsLoyaltyPayload(historicoTotal, thresholds) {
  const nivel_fidelizacion = resolvePadcoinsLoyaltyLevel(historicoTotal, thresholds);
  const niveles_fidelizacion = buildPadcoinsLoyaltyLevelsSummary(thresholds);

  return {
    nivel_fidelizacion,
    loyalty_level: nivel_fidelizacion,
    niveles_fidelizacion,
    loyalty_levels: niveles_fidelizacion,
  };
}

function normalizeConfigRow(row) {
  const slug = String(row.key ?? '').replace(/^nivel_fidelizacion_/, '').replace(/_umbral$/, '');
  const levelDef = PADCOINS_LOYALTY_LEVELS.find((item) => item.slug === slug);

  return {
    id: row.id ?? null,
    slug,
    nombre: levelDef?.nombre ?? slug,
    orden: levelDef?.orden ?? null,
    key: row.key,
    umbral_minimo: row.value_integer != null ? Number(row.value_integer) : levelDef?.default_umbral ?? null,
    descripcion: row.descripcion ?? null,
    activo: row.activo !== false,
    created_at: row.created_at ?? null,
    updated_at: row.updated_at ?? null,
    updated_by: row.updated_by ?? null,
  };
}

function buildDefaultConfigList() {
  return PADCOINS_LOYALTY_LEVELS.map((level) => normalizeConfigRow({
    id: null,
    key: padcoinsLoyaltyLevelConfigKey(level.slug),
    value_integer: level.default_umbral,
    descripcion: `Umbral mínimo de PadCoins históricos para nivel ${level.nombre}`,
    activo: true,
    created_at: null,
    updated_at: null,
    updated_by: null,
  }));
}

function thresholdsFromConfigRows(rows) {
  const overridesBySlug = {};
  for (const row of rows) {
    if (row.activo === false) continue;
    if (row.umbral_minimo == null || !Number.isInteger(row.umbral_minimo)) continue;
    overridesBySlug[row.slug] = row.umbral_minimo;
  }
  return validatePadcoinsLoyaltyLevelThresholds(
    mergeThresholdOverrides(buildDefaultPadcoinsLoyaltyLevelThresholds(), overridesBySlug),
  );
}

export async function listPadcoinsLoyaltyLevelsConfig(supabaseAdmin) {
  const keys = PADCOINS_LOYALTY_LEVELS.map((level) => padcoinsLoyaltyLevelConfigKey(level.slug));

  const { data, error } = await supabaseAdmin
    .from('padcoins_global_config')
    .select('id, key, value_integer, value_text, descripcion, activo, created_at, updated_at, updated_by')
    .in('key', keys)
    .order('key', { ascending: true });

  if (error) {
    if (isMissingTable(error)) {
      return {
        levels: buildDefaultConfigList(),
        thresholds: buildDefaultPadcoinsLoyaltyLevelThresholds(),
      };
    }
    throw error;
  }

  const byKey = new Map((data ?? []).map((row) => [row.key, normalizeConfigRow(row)]));
  const levels = PADCOINS_LOYALTY_LEVELS.map((level) => {
    const key = padcoinsLoyaltyLevelConfigKey(level.slug);
    if (byKey.has(key)) return byKey.get(key);
    return buildDefaultConfigList().find((item) => item.slug === level.slug);
  });

  return {
    levels,
    thresholds: thresholdsFromConfigRows(levels),
  };
}

export async function getPadcoinsLoyaltyLevelThresholds(supabaseAdmin) {
  const { thresholds } = await listPadcoinsLoyaltyLevelsConfig(supabaseAdmin);
  return thresholds;
}

function validateUpdateItem(rawItem) {
  if (!rawItem || typeof rawItem !== 'object') {
    throw buildHttpError('Cada update debe ser un objeto');
  }

  const slug = String(rawItem.slug ?? rawItem.key ?? '').trim().toLowerCase();
  if (!isPadcoinsLoyaltyLevelSlug(slug)) {
    throw buildHttpError(`slug de nivel de fidelización inválido: ${rawItem.slug ?? rawItem.key ?? ''}`);
  }

  const umbralField = rawItem.umbral_minimo ?? rawItem.value_integer;
  const umbral_minimo = parseNonNegativeInteger(umbralField, 'umbral_minimo');

  return { slug, umbral_minimo };
}

export async function updatePadcoinsLoyaltyLevelsConfig(supabaseAdmin, updates, updatedBy) {
  if (!Array.isArray(updates) || updates.length === 0) {
    throw buildHttpError('updates debe ser un array no vacío');
  }

  if (updatedBy != null && !UUID_REGEX.test(String(updatedBy))) {
    throw buildHttpError('updatedBy inválido');
  }

  const seenSlugs = new Set();
  const normalizedUpdates = updates.map((item) => {
    const parsed = validateUpdateItem(item);
    if (seenSlugs.has(parsed.slug)) {
      throw buildHttpError(`slug duplicado en updates: ${parsed.slug}`);
    }
    seenSlugs.add(parsed.slug);
    return parsed;
  });

  const current = await listPadcoinsLoyaltyLevelsConfig(supabaseAdmin);
  const overridesBySlug = Object.fromEntries(
    current.thresholds.map((level) => [level.slug, level.umbral_minimo]),
  );

  for (const item of normalizedUpdates) {
    overridesBySlug[item.slug] = item.umbral_minimo;
  }

  const nextThresholds = validatePadcoinsLoyaltyLevelThresholds(
    mergeThresholdOverrides(buildDefaultPadcoinsLoyaltyLevelThresholds(), overridesBySlug),
  );

  const now = new Date().toISOString();
  const results = [];

  for (const level of nextThresholds) {
    const payload = {
      key: padcoinsLoyaltyLevelConfigKey(level.slug),
      value_integer: level.umbral_minimo,
      value_text: null,
      descripcion: `Umbral mínimo de PadCoins históricos para nivel ${level.nombre}`,
      activo: true,
      updated_at: now,
      updated_by: updatedBy ?? null,
    };

    const { data, error } = await supabaseAdmin
      .from('padcoins_global_config')
      .upsert(payload, { onConflict: 'key' })
      .select('id, key, value_integer, value_text, descripcion, activo, created_at, updated_at, updated_by')
      .single();

    if (error) {
      if (isMissingTable(error)) {
        throw buildHttpError(
          'Tabla padcoins_global_config no existe. Ejecutá la migración SQL primero.',
          503,
        );
      }
      throw error;
    }

    results.push(normalizeConfigRow(data));
  }

  return {
    levels: results,
    thresholds: nextThresholds,
  };
}
