import {
  PADCOINS_GLOBAL_CONFIG_DEFAULTS,
  PADCOINS_GLOBAL_CONFIG_KEYS,
  PADCOINS_GLOBAL_CONFIG_TEXT_DEFAULTS,
  getPadcoinsGlobalConfigMap,
  getPadcoinsGlobalConfigTextMap,
  getPadcoinsReservationConfig,
  getPadcoinsValue,
} from './padcoinsGlobalConfigService.js';
import { getPadcoinsSedeConfig } from './padcoinsSedeConfigService.js';
import { enforcePadcoinsSedeRuleOverridesPolicy } from './padcoinsLoyaltyPolicyService.js';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SEDE_CONFIG_SELECT = [
  'id',
  'sede_id',
  'activo',
  'descripcion',
  'fecha_inicio',
  'fecha_fin',
  'rule_overrides',
  'created_at',
  'updated_at',
  'updated_by',
].join(', ');

function isMissingTable(error) {
  const message = String(error?.message ?? '').toLowerCase();
  return (
    error?.code === '42P01'
    || error?.code === 'PGRST205'
    || message.includes('padcoins_sede_config')
    || message.includes('does not exist')
    || message.includes('could not find the table')
  );
}

const INTEGER_KEYS_SET = new Set(
  PADCOINS_GLOBAL_CONFIG_KEYS.filter(
    (key) => !Object.prototype.hasOwnProperty.call(PADCOINS_GLOBAL_CONFIG_TEXT_DEFAULTS, key),
  ),
);

const TEXT_KEYS_SET = new Set(Object.keys(PADCOINS_GLOBAL_CONFIG_TEXT_DEFAULTS));

const ALLOWED_KEYS_SET = new Set(PADCOINS_GLOBAL_CONFIG_KEYS);

function buildHttpError(message, status = 400) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function isPlainObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Validación estricta para PUT rule_overrides.
 * - Rechaza keys desconocidas (400).
 * - null → 400 (omitir la key para borrar override en reemplazo total).
 * - Sin arrays ni objetos anidados como valor.
 */
export function validatePadcoinsSedeRuleOverridesForWrite(raw) {
  if (!isPlainObject(raw)) {
    throw buildHttpError('rule_overrides debe ser un objeto');
  }

  const unknownKeys = Object.keys(raw).filter((key) => !ALLOWED_KEYS_SET.has(key));
  if (unknownKeys.length > 0) {
    throw buildHttpError(`keys no permitidas: ${unknownKeys.join(', ')}`);
  }

  const validated = {};

  for (const [key, rawValue] of Object.entries(raw)) {
    if (rawValue === null) {
      throw buildHttpError(`null no permitido en ${key}; omití la key para heredar global`);
    }

    if (Array.isArray(rawValue)) {
      throw buildHttpError(`${key} no puede ser un array`);
    }

    if (isPlainObject(rawValue)) {
      throw buildHttpError(`${key} no puede ser un objeto anidado`);
    }

    if (TEXT_KEYS_SET.has(key)) {
      if (typeof rawValue !== 'string') {
        throw buildHttpError(`${key} debe ser texto`);
      }
      const text = rawValue.trim();
      if (!text) {
        throw buildHttpError(`${key} no puede estar vacío`);
      }
      validated[key] = text;
      continue;
    }

    if (typeof rawValue === 'number' && Number.isInteger(rawValue)) {
      validated[key] = rawValue;
      continue;
    }

    const parsed = parseOptionalInteger(rawValue);
    if (parsed == null) {
      throw buildHttpError(`${key} debe ser un entero`);
    }
    validated[key] = parsed;
  }

  return validated;
}

function parseOptionalInteger(raw) {
  if (raw == null) return null;
  const parsed = Number.parseInt(String(raw), 10);
  return Number.isInteger(parsed) ? parsed : null;
}

function parseOverrideEntry(key, rawValue) {
  if (rawValue == null) return null;

  if (typeof rawValue === 'object' && !Array.isArray(rawValue)) {
    if (TEXT_KEYS_SET.has(key)) {
      const text = rawValue.value_text != null ? String(rawValue.value_text).trim() : '';
      return text || null;
    }
    return parseOptionalInteger(rawValue.value_integer);
  }

  if (TEXT_KEYS_SET.has(key)) {
    const text = String(rawValue).trim();
    return text || null;
  }

  if (typeof rawValue === 'number' && Number.isInteger(rawValue)) {
    return rawValue;
  }

  return parseOptionalInteger(rawValue);
}

/**
 * Normaliza rule_overrides de DB/API: solo keys permitidas con valores válidos.
 */
export function normalizePadcoinsSedeRuleOverrides(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {};
  }

  const normalized = {};

  for (const key of PADCOINS_GLOBAL_CONFIG_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(raw, key)) continue;
    const parsed = parseOverrideEntry(key, raw[key]);
    if (parsed == null) continue;
    normalized[key] = parsed;
  }

  return normalized;
}

/**
 * Construye mapa global unificado (enteros + text) con fallbacks de código.
 */
export function buildGlobalPadcoinsConfigMap(intMap = {}, textMap = {}) {
  const global = {};

  for (const key of PADCOINS_GLOBAL_CONFIG_KEYS) {
    if (TEXT_KEYS_SET.has(key)) {
      global[key] = textMap[key] ?? PADCOINS_GLOBAL_CONFIG_TEXT_DEFAULTS[key] ?? null;
      continue;
    }
    global[key] = intMap[key] ?? PADCOINS_GLOBAL_CONFIG_DEFAULTS[key] ?? null;
  }

  return global;
}

/**
 * Resuelve configuración efectiva: global + overrides sede.
 * effective[key] = sede_overrides[key] si existe; si no, global[key].
 */
export function buildEffectivePadcoinsConfig(global, sedeOverrides = {}) {
  const effective = { ...global };

  for (const [key, value] of Object.entries(sedeOverrides)) {
    if (!PADCOINS_GLOBAL_CONFIG_KEYS.includes(key)) continue;
    if (value == null) continue;
    effective[key] = value;
  }

  return effective;
}

export async function resolvePadcoinsConfigForSede(supabaseAdmin, sedeId, options = {}) {
  const sid = Number.parseInt(String(sedeId ?? '').trim(), 10);
  if (!Number.isFinite(sid) || sid <= 0) {
    const err = new Error('sede_id inválido');
    err.status = 400;
    throw err;
  }

  const [intMap, textMap, sedeConfig, sedeRow] = await Promise.all([
    getPadcoinsGlobalConfigMap(supabaseAdmin),
    getPadcoinsGlobalConfigTextMap(supabaseAdmin),
    getPadcoinsSedeConfig(supabaseAdmin, sid, options),
    supabaseAdmin
      .from('sedes')
      .select('id, nombre')
      .eq('id', sid)
      .maybeSingle()
      .then(({ data }) => data ?? null)
      .catch(() => null),
  ]);

  const global = buildGlobalPadcoinsConfigMap(intMap, textMap);
  const sede_overrides = normalizePadcoinsSedeRuleOverrides(sedeConfig.rule_overrides);
  const effective = buildEffectivePadcoinsConfig(global, sede_overrides);

  return {
    sede_id: sid,
    sede: {
      sede_id: sid,
      nombre: sedeRow?.nombre ?? null,
      activo: sedeConfig.activo === true,
      participa: sedeConfig.participa === true,
      descripcion: sedeConfig.descripcion ?? null,
      fecha_inicio: sedeConfig.fecha_inicio ?? null,
      fecha_fin: sedeConfig.fecha_fin ?? null,
    },
    global,
    sede_overrides,
    effective,
    keys: [...PADCOINS_GLOBAL_CONFIG_KEYS],
  };
}

/**
 * Lectura puntual de una key efectiva para sede.
 * Sin sedeId válido o si el resolver falla → getPadcoinsValue (global).
 */
export async function getEffectivePadcoinsValueForSede(supabaseAdmin, sedeId, key, fallback) {
  const normalizedKey = String(key ?? '').trim();

  if (!normalizedKey || !PADCOINS_GLOBAL_CONFIG_KEYS.includes(normalizedKey)) {
    return fallback ?? null;
  }

  const sid = Number.parseInt(String(sedeId ?? '').trim(), 10);
  if (!Number.isFinite(sid) || sid <= 0) {
    return getPadcoinsValue(supabaseAdmin, normalizedKey, fallback);
  }

  try {
    const resolved = await resolvePadcoinsConfigForSede(supabaseAdmin, sid);
    const value = resolved.effective[normalizedKey];
    if (value != null) return value;
    return getPadcoinsValue(supabaseAdmin, normalizedKey, fallback);
  } catch {
    try {
      return await getPadcoinsValue(supabaseAdmin, normalizedKey, fallback);
    } catch {
      return fallback
        ?? PADCOINS_GLOBAL_CONFIG_DEFAULTS[normalizedKey]
        ?? PADCOINS_GLOBAL_CONFIG_TEXT_DEFAULTS[normalizedKey]
        ?? null;
    }
  }
}

/**
 * Config de acreditación por reserva para una sede (effective → global fallback).
 */
export async function getPadcoinsReservationConfigForSede(supabaseAdmin, sedeId) {
  const globalConfig = await getPadcoinsReservationConfig(supabaseAdmin);
  const sid = Number.parseInt(String(sedeId ?? '').trim(), 10);

  if (!Number.isFinite(sid) || sid <= 0) {
    return globalConfig;
  }

  try {
    const [
      porcentaje_devolucion_reserva,
      padcoins_por_usd_equivalente,
      modo_calculo_reserva,
      reserva_confirmada_fallback,
    ] = await Promise.all([
      getEffectivePadcoinsValueForSede(
        supabaseAdmin,
        sid,
        'porcentaje_devolucion_reserva',
        globalConfig.porcentaje_devolucion_reserva,
      ),
      getEffectivePadcoinsValueForSede(
        supabaseAdmin,
        sid,
        'padcoins_por_usd_equivalente',
        globalConfig.padcoins_por_usd_equivalente,
      ),
      getEffectivePadcoinsValueForSede(
        supabaseAdmin,
        sid,
        'modo_calculo_reserva',
        globalConfig.modo_calculo_reserva,
      ),
      getEffectivePadcoinsValueForSede(
        supabaseAdmin,
        sid,
        'reserva_confirmada',
        globalConfig.reserva_confirmada_fallback,
      ),
    ]);

    return {
      porcentaje_devolucion_reserva,
      padcoins_por_usd_equivalente,
      modo_calculo_reserva,
      reserva_confirmada_fallback,
    };
  } catch {
    return globalConfig;
  }
}

/**
 * Reemplaza rule_overrides de la sede (objeto completo). Preserva participación y fechas.
 */
export async function updatePadcoinsSedeRuleOverrides(supabaseAdmin, {
  sede_id,
  rule_overrides,
  updated_by,
} = {}) {
  const sid = Number.parseInt(String(sede_id ?? '').trim(), 10);
  if (!Number.isFinite(sid) || sid <= 0) {
    throw buildHttpError('sede_id inválido');
  }

  if (updated_by != null && !UUID_REGEX.test(String(updated_by))) {
    throw buildHttpError('updated_by inválido');
  }

  const validated = validatePadcoinsSedeRuleOverridesForWrite(rule_overrides);
  const existing = await getPadcoinsSedeConfig(supabaseAdmin, sid);

  enforcePadcoinsSedeRuleOverridesPolicy(validated, {
    padcoinsActive: existing.activo === true,
  });

  const payload = {
    sede_id: sid,
    activo: existing.activo,
    descripcion: existing.descripcion,
    fecha_inicio: existing.fecha_inicio,
    fecha_fin: existing.fecha_fin,
    rule_overrides: validated,
    updated_at: new Date().toISOString(),
    updated_by: updated_by ?? null,
  };

  const { data, error } = await supabaseAdmin
    .from('padcoins_sede_config')
    .upsert(payload, { onConflict: 'sede_id' })
    .select(SEDE_CONFIG_SELECT)
    .single();

  if (error) {
    if (isMissingTable(error)) {
      throw buildHttpError(
        'Tabla padcoins_sede_config no existe. Ejecutá la migración SQL primero.',
        503,
      );
    }
    throw error;
  }

  const rule_overrides_saved = normalizePadcoinsSedeRuleOverrides(data?.rule_overrides);

  return {
    sede_id: sid,
    rule_overrides: rule_overrides_saved,
  };
}

export { INTEGER_KEYS_SET, TEXT_KEYS_SET, ALLOWED_KEYS_SET };
