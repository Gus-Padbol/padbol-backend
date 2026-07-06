const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * PadCoins: moneda de fidelización. No es dinero para el jugador.
 * padcoins_por_usd_equivalente es equivalencia promocional interna (Super Admin).
 * Cada sede define premios y costos propios en premios_canjeables.
 */
export const PADCOINS_RESERVATION_CALC_MODE = {
  PERCENTAGE_PAID: 'porcentaje_valor_pagado',
};

export const PADCOINS_GLOBAL_CONFIG_DEFAULTS = {
  partido_jugado: 50,
  partido_ganado: 20,
  logro_desbloqueado: 500,
  inscripcion_torneo: 100,
  reserva_confirmada: 30,
  cancelacion_tarde: -100,
  no_show: -300,
  limite_diario_jugador: 1000,
  limite_mensual_jugador: 10000,
  porcentaje_devolucion_reserva: 5,
  padcoins_por_usd_equivalente: 100,
};

/** Keys con value_text (modos, flags futuros). */
export const PADCOINS_GLOBAL_CONFIG_TEXT_DEFAULTS = {
  modo_calculo_reserva: PADCOINS_RESERVATION_CALC_MODE.PERCENTAGE_PAID,
};

export const PADCOINS_GLOBAL_CONFIG_KEYS = Object.freeze([
  'partido_jugado',
  'partido_ganado',
  'logro_desbloqueado',
  'inscripcion_torneo',
  'reserva_confirmada',
  'cancelacion_tarde',
  'no_show',
  'limite_diario_jugador',
  'limite_mensual_jugador',
  'porcentaje_devolucion_reserva',
  'padcoins_por_usd_equivalente',
  'modo_calculo_reserva',
]);

const DEFAULT_DESCRIPTIONS = {
  partido_jugado: 'Bonus/fallback fijo por partido jugado (futuro; no reemplaza cálculo proporcional en reservas pagas)',
  partido_ganado: 'PadCoins extra por partido ganado',
  logro_desbloqueado: 'PadCoins por logro desbloqueado',
  inscripcion_torneo: 'PadCoins por inscripción a torneo',
  reserva_confirmada: 'Fallback fijo si no hay valor pagado o moneda sin conversión a USD equivalente',
  cancelacion_tarde: 'Penalización por cancelación tardía',
  no_show: 'Penalización por no presentarse',
  limite_diario_jugador: 'Tope diario de PadCoins ganados por jugador',
  limite_mensual_jugador: 'Tope mensual de PadCoins ganados por jugador',
  porcentaje_devolucion_reserva: 'Porcentaje global de devolución PadCoins sobre valor pagado (ej. 5 = 5%)',
  padcoins_por_usd_equivalente: 'Equivalencia promocional interna: PadCoins por 1 USD equivalente (no mostrar al jugador)',
  modo_calculo_reserva: 'Modo de acreditación por reserva: porcentaje_valor_pagado | futuros modos',
};

const ALLOWED_KEYS_SET = new Set(PADCOINS_GLOBAL_CONFIG_KEYS);

function isMissingTable(error) {
  const message = String(error?.message ?? '').toLowerCase();
  return (
    error?.code === '42P01'
    || error?.code === 'PGRST205'
    || message.includes('does not exist')
    || message.includes('could not find the table')
  );
}

function defaultValueIntegerForKey(key) {
  return Object.prototype.hasOwnProperty.call(PADCOINS_GLOBAL_CONFIG_DEFAULTS, key)
    ? PADCOINS_GLOBAL_CONFIG_DEFAULTS[key]
    : null;
}

function defaultValueTextForKey(key) {
  return Object.prototype.hasOwnProperty.call(PADCOINS_GLOBAL_CONFIG_TEXT_DEFAULTS, key)
    ? PADCOINS_GLOBAL_CONFIG_TEXT_DEFAULTS[key]
    : null;
}

function buildDefaultConfigList() {
  return PADCOINS_GLOBAL_CONFIG_KEYS.map((key) => ({
    id: null,
    key,
    value_integer: defaultValueIntegerForKey(key),
    value_text: defaultValueTextForKey(key),
    descripcion: DEFAULT_DESCRIPTIONS[key] ?? null,
    activo: true,
    created_at: null,
    updated_at: null,
    updated_by: null,
  }));
}

function normalizeConfigRow(row) {
  return {
    id: row.id ?? null,
    key: String(row.key),
    value_integer: row.value_integer != null ? Number(row.value_integer) : null,
    value_text: row.value_text ?? null,
    descripcion: row.descripcion ?? null,
    activo: row.activo !== false,
    created_at: row.created_at ?? null,
    updated_at: row.updated_at ?? null,
    updated_by: row.updated_by ?? null,
  };
}

function assertAllowedKey(key) {
  const normalized = String(key ?? '').trim();
  if (!normalized) {
    const err = new Error('key obligatoria');
    err.status = 400;
    throw err;
  }
  if (!ALLOWED_KEYS_SET.has(normalized)) {
    const err = new Error(`key no permitida: ${normalized}`);
    err.status = 400;
    throw err;
  }
  return normalized;
}

function parseOptionalInteger(raw, fieldName) {
  if (raw == null) return null;
  const parsed = Number.parseInt(String(raw), 10);
  if (!Number.isInteger(parsed)) {
    const err = new Error(`${fieldName} debe ser un entero o null`);
    err.status = 400;
    throw err;
  }
  return parsed;
}

function parseOptionalBoolean(raw, fallback = true) {
  if (raw == null) return fallback;
  if (typeof raw === 'boolean') return raw;
  const err = new Error('activo debe ser boolean');
  err.status = 400;
  throw err;
}

function validateUpdateItem(rawItem) {
  if (!rawItem || typeof rawItem !== 'object') {
    const err = new Error('Cada update debe ser un objeto');
    err.status = 400;
    throw err;
  }

  const key = assertAllowedKey(rawItem.key);
  const value_integer = parseOptionalInteger(rawItem.value_integer, 'value_integer');
  const value_text = rawItem.value_text != null ? String(rawItem.value_text) : null;
  const descripcion = rawItem.descripcion != null ? String(rawItem.descripcion).trim() : null;
  const activo = parseOptionalBoolean(rawItem.activo, true);

  return {
    key,
    value_integer,
    value_text,
    descripcion: descripcion || DEFAULT_DESCRIPTIONS[key] || null,
    activo,
  };
}

function resolveIntegerFromRows(rows, key) {
  const row = rows.find((item) => item.key === key);
  if (row?.activo === false) return defaultValueIntegerForKey(key);
  if (row?.value_integer != null && Number.isInteger(Number(row.value_integer))) {
    return Number(row.value_integer);
  }
  return defaultValueIntegerForKey(key);
}

function resolveTextFromRows(rows, key) {
  const row = rows.find((item) => item.key === key);
  if (row?.activo === false) return defaultValueTextForKey(key);
  if (row?.value_text != null && String(row.value_text).trim()) {
    return String(row.value_text).trim();
  }
  return defaultValueTextForKey(key);
}

/**
 * Calcula PadCoins por monto pagado (equivalencia promocional interna; no es dinero para el jugador).
 *
 * padcoins = round(paidAmountUsdEquivalent × porcentaje / 100 × padcoins_por_usd_equivalente)
 *
 * - USD: usa paidAmount como equivalente directo.
 * - Otras monedas: no inventa tipo de cambio; devuelve applied=false (usar reserva_confirmada fallback).
 */
export function calculatePadcoinsForPaidAmount({
  paidAmount,
  currency,
  configMap = {},
  configTextMap = {},
  fallbackPercentage = PADCOINS_GLOBAL_CONFIG_DEFAULTS.porcentaje_devolucion_reserva,
  fallbackPadcoinsPerUsd = PADCOINS_GLOBAL_CONFIG_DEFAULTS.padcoins_por_usd_equivalente,
  fallbackMode = PADCOINS_GLOBAL_CONFIG_TEXT_DEFAULTS.modo_calculo_reserva,
}) {
  const mode = configTextMap.modo_calculo_reserva ?? fallbackMode;

  if (mode !== PADCOINS_RESERVATION_CALC_MODE.PERCENTAGE_PAID) {
    return {
      padcoins: null,
      applied: false,
      reason: `modo_calculo_reserva no soportado: ${mode}`,
      modo_calculo_reserva: mode,
    };
  }

  const amount = Number(paidAmount);
  if (!Number.isFinite(amount) || amount <= 0) {
    return {
      padcoins: 0,
      applied: false,
      reason: 'paidAmount inválido o cero',
      modo_calculo_reserva: mode,
    };
  }

  const normalizedCurrency = String(currency ?? '').trim().toUpperCase();
  let paidAmountUsdEquivalent = null;

  if (normalizedCurrency === 'USD') {
    paidAmountUsdEquivalent = amount;
  } else {
    return {
      padcoins: null,
      applied: false,
      reason: `Sin conversión a USD equivalente para moneda ${normalizedCurrency || 'desconocida'}. No se inventa tipo de cambio; usar reserva_confirmada como fallback si aplica.`,
      currency: normalizedCurrency || null,
      modo_calculo_reserva: mode,
    };
  }

  const porcentaje = Number(
    configMap.porcentaje_devolucion_reserva ?? fallbackPercentage,
  );
  const padcoinsPorUsd = Number(
    configMap.padcoins_por_usd_equivalente ?? fallbackPadcoinsPerUsd,
  );

  if (!Number.isFinite(porcentaje) || porcentaje < 0) {
    return {
      padcoins: null,
      applied: false,
      reason: 'porcentaje_devolucion_reserva inválido',
      modo_calculo_reserva: mode,
    };
  }

  if (!Number.isFinite(padcoinsPorUsd) || padcoinsPorUsd <= 0) {
    return {
      padcoins: null,
      applied: false,
      reason: 'padcoins_por_usd_equivalente inválido',
      modo_calculo_reserva: mode,
    };
  }

  const padcoins = Math.round(
    paidAmountUsdEquivalent * (porcentaje / 100) * padcoinsPorUsd,
  );

  return {
    padcoins,
    applied: true,
    paidAmountUsdEquivalent,
    porcentaje,
    padcoins_por_usd_equivalente: padcoinsPorUsd,
    modo_calculo_reserva: mode,
    currency: normalizedCurrency,
  };
}

export async function listPadcoinsGlobalConfig(supabaseAdmin) {
  const { data, error } = await supabaseAdmin
    .from('padcoins_global_config')
    .select('id, key, value_integer, value_text, descripcion, activo, created_at, updated_at, updated_by')
    .order('key', { ascending: true });

  if (error) {
    if (isMissingTable(error)) return buildDefaultConfigList();
    throw error;
  }

  if (!data?.length) return buildDefaultConfigList();

  const byKey = new Map(data.map((row) => [row.key, normalizeConfigRow(row)]));

  return PADCOINS_GLOBAL_CONFIG_KEYS.map((key) => {
    if (byKey.has(key)) return byKey.get(key);
    return normalizeConfigRow(buildDefaultConfigList().find((row) => row.key === key));
  });
}

export async function getPadcoinsGlobalConfigMap(supabaseAdmin) {
  const rows = await listPadcoinsGlobalConfig(supabaseAdmin);
  const map = { ...PADCOINS_GLOBAL_CONFIG_DEFAULTS };

  for (const row of rows) {
    if (row.activo === false) continue;
    if (row.value_integer != null && Number.isInteger(row.value_integer)) {
      map[row.key] = row.value_integer;
    }
  }

  return map;
}

export async function getPadcoinsGlobalConfigTextMap(supabaseAdmin) {
  const rows = await listPadcoinsGlobalConfig(supabaseAdmin);
  const map = { ...PADCOINS_GLOBAL_CONFIG_TEXT_DEFAULTS };

  for (const row of rows) {
    if (row.activo === false) continue;
    if (row.value_text != null && String(row.value_text).trim()) {
      map[row.key] = String(row.value_text).trim();
    }
  }

  return map;
}

/**
 * Config de reservas pagas: porcentaje, conversión promocional y modo.
 * reserva_confirmada queda como fallback documentado, no regla principal con valor pagado.
 */
export async function getPadcoinsReservationConfig(supabaseAdmin) {
  const rows = await listPadcoinsGlobalConfig(supabaseAdmin);

  return {
    porcentaje_devolucion_reserva: resolveIntegerFromRows(rows, 'porcentaje_devolucion_reserva'),
    padcoins_por_usd_equivalente: resolveIntegerFromRows(rows, 'padcoins_por_usd_equivalente'),
    modo_calculo_reserva: resolveTextFromRows(rows, 'modo_calculo_reserva'),
    reserva_confirmada_fallback: resolveIntegerFromRows(rows, 'reserva_confirmada'),
  };
}

export async function getPadcoinsValue(supabaseAdmin, key, fallback) {
  const normalizedKey = String(key ?? '').trim();
  const defaultFallback = PADCOINS_GLOBAL_CONFIG_DEFAULTS[normalizedKey];
  const resolvedFallback = fallback ?? defaultFallback ?? null;

  if (!normalizedKey || !ALLOWED_KEYS_SET.has(normalizedKey)) {
    return resolvedFallback;
  }

  if (Object.prototype.hasOwnProperty.call(PADCOINS_GLOBAL_CONFIG_TEXT_DEFAULTS, normalizedKey)) {
    const textMap = await getPadcoinsGlobalConfigTextMap(supabaseAdmin);
    return textMap[normalizedKey] ?? resolvedFallback;
  }

  try {
    const { data, error } = await supabaseAdmin
      .from('padcoins_global_config')
      .select('key, value_integer, activo')
      .eq('key', normalizedKey)
      .maybeSingle();

    if (error) {
      if (isMissingTable(error)) return resolvedFallback;
      throw error;
    }

    if (!data || data.activo === false || data.value_integer == null) {
      return resolvedFallback;
    }

    const parsed = Number(data.value_integer);
    return Number.isInteger(parsed) ? parsed : resolvedFallback;
  } catch (err) {
    if (isMissingTable(err)) return resolvedFallback;
    throw err;
  }
}

export async function updatePadcoinsGlobalConfig(supabaseAdmin, updates, updatedBy) {
  if (!Array.isArray(updates) || updates.length === 0) {
    const err = new Error('updates debe ser un array no vacío');
    err.status = 400;
    throw err;
  }

  if (updatedBy != null && !UUID_REGEX.test(String(updatedBy))) {
    const err = new Error('updatedBy inválido');
    err.status = 400;
    throw err;
  }

  const seenKeys = new Set();
  const normalizedUpdates = updates.map((item) => {
    const parsed = validateUpdateItem(item);
    if (seenKeys.has(parsed.key)) {
      const err = new Error(`key duplicada en updates: ${parsed.key}`);
      err.status = 400;
      throw err;
    }
    seenKeys.add(parsed.key);
    return parsed;
  });

  const now = new Date().toISOString();
  const results = [];

  for (const item of normalizedUpdates) {
    const payload = {
      key: item.key,
      value_integer: item.value_integer,
      value_text: item.value_text,
      descripcion: item.descripcion,
      activo: item.activo,
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
        const err = new Error('Tabla padcoins_global_config no existe. Ejecutá la migración SQL primero.');
        err.status = 503;
        throw err;
      }
      throw error;
    }

    results.push(normalizeConfigRow(data));
  }

  return results;
}
