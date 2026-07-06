const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
};

export const PADCOINS_GLOBAL_CONFIG_KEYS = Object.freeze(
  Object.keys(PADCOINS_GLOBAL_CONFIG_DEFAULTS),
);

const DEFAULT_DESCRIPTIONS = {
  partido_jugado: 'PadCoins por partido jugado',
  partido_ganado: 'PadCoins extra por partido ganado',
  logro_desbloqueado: 'PadCoins por logro desbloqueado',
  inscripcion_torneo: 'PadCoins por inscripción a torneo',
  reserva_confirmada: 'PadCoins por reserva confirmada/jugada',
  cancelacion_tarde: 'Penalización por cancelación tardía',
  no_show: 'Penalización por no presentarse',
  limite_diario_jugador: 'Tope diario de PadCoins ganados por jugador',
  limite_mensual_jugador: 'Tope mensual de PadCoins ganados por jugador',
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

function buildDefaultConfigList() {
  return PADCOINS_GLOBAL_CONFIG_KEYS.map((key) => ({
    id: null,
    key,
    value_integer: PADCOINS_GLOBAL_CONFIG_DEFAULTS[key],
    value_text: null,
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

export async function getPadcoinsValue(supabaseAdmin, key, fallback) {
  const normalizedKey = String(key ?? '').trim();
  const defaultFallback = PADCOINS_GLOBAL_CONFIG_DEFAULTS[normalizedKey];
  const resolvedFallback = fallback ?? defaultFallback ?? null;

  if (!normalizedKey || !ALLOWED_KEYS_SET.has(normalizedKey)) {
    return resolvedFallback;
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
