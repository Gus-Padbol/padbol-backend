const PREMIO_SELECT = [
  'id',
  'sede_id',
  'nombre',
  'descripcion',
  'costo_padcoins',
  'stock_total',
  'stock_disponible',
  'activo',
  'fecha_inicio',
  'fecha_fin',
  'condiciones',
  'created_at',
  'updated_at',
].join(', ');

const ALLOWED_PAYLOAD_KEYS = new Set([
  'sede_id',
  'nombre',
  'descripcion',
  'costo_padcoins',
  'stock_total',
  'stock_disponible',
  'activo',
  'fecha_inicio',
  'fecha_fin',
  'condiciones',
]);

function parseSedeId(raw) {
  const sid = Number.parseInt(String(raw ?? '').trim(), 10);
  return Number.isFinite(sid) && sid > 0 ? sid : null;
}

function parseOptionalInteger(raw) {
  if (raw == null || raw === '') return null;
  const parsed = Number.parseInt(String(raw), 10);
  if (!Number.isInteger(parsed)) return undefined;
  return parsed;
}

function parseOptionalBoolean(raw) {
  if (raw == null || raw === '') return undefined;
  if (typeof raw === 'boolean') return raw;
  const normalized = String(raw).trim().toLowerCase();
  if (normalized === 'true' || normalized === '1') return true;
  if (normalized === 'false' || normalized === '0') return false;
  return undefined;
}

function parseOptionalDate(raw) {
  if (raw == null || raw === '') return null;
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return undefined;
  return date.toISOString();
}

function pickAllowedPayload(source = {}) {
  const out = {};
  for (const key of ALLOWED_PAYLOAD_KEYS) {
    if (Object.prototype.hasOwnProperty.call(source, key)) {
      out[key] = source[key];
    }
  }
  return out;
}

function isMissingTable(error) {
  const message = String(error?.message ?? '').toLowerCase();
  return (
    error?.code === '42P01'
    || error?.code === 'PGRST205'
    || message.includes('premios_canjeables')
    || message.includes('does not exist')
    || message.includes('could not find the table')
  );
}

function buildHttpError(message, status = 400) {
  const err = new Error(message);
  err.status = status;
  return err;
}

export function isPremioCanjeablePublico(row, nowMs = Date.now()) {
  if (!row?.activo) return false;

  if (row.fecha_inicio) {
    const inicio = new Date(row.fecha_inicio).getTime();
    if (!Number.isNaN(inicio) && inicio > nowMs) return false;
  }

  if (row.fecha_fin) {
    const fin = new Date(row.fecha_fin).getTime();
    if (!Number.isNaN(fin) && fin < nowMs) return false;
  }

  if (row.stock_disponible != null && Number(row.stock_disponible) <= 0) {
    return false;
  }

  return true;
}

export function mapPremioCanjeablePublico(row) {
  return {
    id: row.id,
    sede_id: row.sede_id,
    nombre: row.nombre,
    descripcion: row.descripcion ?? null,
    costo_padcoins: row.costo_padcoins,
    stock_disponible: row.stock_disponible ?? null,
    fecha_inicio: row.fecha_inicio ?? null,
    fecha_fin: row.fecha_fin ?? null,
    condiciones: row.condiciones ?? null,
  };
}

export function validatePremioCanjeablePayload(payload, { partial = false } = {}) {
  const normalized = pickAllowedPayload(payload);
  const result = {};

  if (!partial || Object.prototype.hasOwnProperty.call(normalized, 'sede_id')) {
    const sedeId = parseSedeId(normalized.sede_id);
    if (!sedeId) {
      throw buildHttpError('sede_id es requerido');
    }
    result.sede_id = sedeId;
  }

  if (!partial || Object.prototype.hasOwnProperty.call(normalized, 'nombre')) {
    const nombre = String(normalized.nombre ?? '').trim();
    if (!nombre) {
      throw buildHttpError('nombre es requerido');
    }
    result.nombre = nombre.slice(0, 255);
  }

  if (Object.prototype.hasOwnProperty.call(normalized, 'descripcion')) {
    const descripcion = normalized.descripcion == null
      ? null
      : String(normalized.descripcion).trim();
    result.descripcion = descripcion ? descripcion.slice(0, 4000) : null;
  }

  if (!partial || Object.prototype.hasOwnProperty.call(normalized, 'costo_padcoins')) {
    const costo = parseOptionalInteger(normalized.costo_padcoins);
    if (costo == null || costo <= 0) {
      throw buildHttpError('costo_padcoins debe ser mayor a cero');
    }
    result.costo_padcoins = costo;
  }

  if (Object.prototype.hasOwnProperty.call(normalized, 'stock_total')) {
    const stockTotal = parseOptionalInteger(normalized.stock_total);
    if (stockTotal === undefined) {
      throw buildHttpError('stock_total inválido');
    }
    if (stockTotal != null && stockTotal < 0) {
      throw buildHttpError('stock_total no puede ser negativo');
    }
    result.stock_total = stockTotal;
  }

  if (Object.prototype.hasOwnProperty.call(normalized, 'stock_disponible')) {
    const stockDisponible = parseOptionalInteger(normalized.stock_disponible);
    if (stockDisponible === undefined) {
      throw buildHttpError('stock_disponible inválido');
    }
    if (stockDisponible != null && stockDisponible < 0) {
      throw buildHttpError('stock_disponible no puede ser negativo');
    }
    result.stock_disponible = stockDisponible;
  }

  if (Object.prototype.hasOwnProperty.call(normalized, 'activo')) {
    const activo = parseOptionalBoolean(normalized.activo);
    if (activo === undefined) {
      throw buildHttpError('activo inválido');
    }
    result.activo = activo;
  }

  if (Object.prototype.hasOwnProperty.call(normalized, 'fecha_inicio')) {
    const fechaInicio = parseOptionalDate(normalized.fecha_inicio);
    if (fechaInicio === undefined) {
      throw buildHttpError('fecha_inicio inválida');
    }
    result.fecha_inicio = fechaInicio;
  }

  if (Object.prototype.hasOwnProperty.call(normalized, 'fecha_fin')) {
    const fechaFin = parseOptionalDate(normalized.fecha_fin);
    if (fechaFin === undefined) {
      throw buildHttpError('fecha_fin inválida');
    }
    result.fecha_fin = fechaFin;
  }

  if (Object.prototype.hasOwnProperty.call(normalized, 'condiciones')) {
    const condiciones = normalized.condiciones == null
      ? null
      : String(normalized.condiciones).trim();
    result.condiciones = condiciones ? condiciones.slice(0, 4000) : null;
  }

  const stockTotal = Object.prototype.hasOwnProperty.call(result, 'stock_total')
    ? result.stock_total
    : undefined;
  const stockDisponible = Object.prototype.hasOwnProperty.call(result, 'stock_disponible')
    ? result.stock_disponible
    : undefined;

  if (stockTotal != null && stockDisponible != null && stockDisponible > stockTotal) {
    throw buildHttpError('stock_disponible no puede ser mayor a stock_total');
  }

  return result;
}

function assertStockRelation(stockTotal, stockDisponible) {
  if (stockTotal != null && stockDisponible != null && stockDisponible > stockTotal) {
    throw buildHttpError('stock_disponible no puede ser mayor a stock_total');
  }
}

export async function listPremiosCanjeables(supabaseAdmin, options = {}) {
  const sedeId = options.sede_id != null ? parseSedeId(options.sede_id) : null;
  if (options.sede_id != null && !sedeId) {
    throw buildHttpError('sede_id inválido');
  }

  let query = supabaseAdmin
    .from('premios_canjeables')
    .select(PREMIO_SELECT)
    .order('created_at', { ascending: false });

  if (sedeId) {
    query = query.eq('sede_id', sedeId);
  }

  if (options.activo != null) {
    query = query.eq('activo', Boolean(options.activo));
  }

  const { data, error } = await query;
  if (error) {
    if (isMissingTable(error)) return [];
    throw error;
  }

  return data ?? [];
}

export async function listPremiosCanjeablesPublicos(supabaseAdmin, options = {}) {
  const sedeId = parseSedeId(options.sede_id);
  if (!sedeId) {
    throw buildHttpError('sede_id es requerido');
  }

  const { data, error } = await supabaseAdmin
    .from('premios_canjeables')
    .select(PREMIO_SELECT)
    .eq('sede_id', sedeId)
    .eq('activo', true)
    .order('nombre', { ascending: true });

  if (error) {
    if (isMissingTable(error)) return [];
    throw error;
  }

  return (data ?? [])
    .filter((row) => isPremioCanjeablePublico(row))
    .map((row) => mapPremioCanjeablePublico(row));
}

export async function getPremioCanjeableById(supabaseAdmin, premioId) {
  const id = String(premioId ?? '').trim();
  if (!id) {
    throw buildHttpError('id de premio inválido');
  }

  const { data, error } = await supabaseAdmin
    .from('premios_canjeables')
    .select(PREMIO_SELECT)
    .eq('id', id)
    .maybeSingle();

  if (error) {
    if (isMissingTable(error)) return null;
    throw error;
  }

  return data ?? null;
}

export async function createPremioCanjeable(supabaseAdmin, payload) {
  const validated = validatePremioCanjeablePayload(payload, { partial: false });

  if (validated.stock_total != null && validated.stock_disponible == null) {
    validated.stock_disponible = validated.stock_total;
  }

  if (validated.activo == null) {
    validated.activo = true;
  }

  assertStockRelation(validated.stock_total, validated.stock_disponible);

  const insertRow = {
    ...validated,
    updated_at: new Date().toISOString(),
  };

  const { data, error } = await supabaseAdmin
    .from('premios_canjeables')
    .insert(insertRow)
    .select(PREMIO_SELECT)
    .single();

  if (error) throw error;
  return data;
}

export async function updatePremioCanjeable(supabaseAdmin, premioId, payload) {
  const existing = await getPremioCanjeableById(supabaseAdmin, premioId);
  if (!existing) {
    throw buildHttpError('Premio no encontrado', 404);
  }

  const validated = validatePremioCanjeablePayload(payload, { partial: true });
  if (!Object.keys(validated).length) {
    throw buildHttpError('No hay campos válidos para actualizar');
  }

  const nextStockTotal = Object.prototype.hasOwnProperty.call(validated, 'stock_total')
    ? validated.stock_total
    : existing.stock_total;
  const nextStockDisponible = Object.prototype.hasOwnProperty.call(validated, 'stock_disponible')
    ? validated.stock_disponible
    : existing.stock_disponible;

  assertStockRelation(nextStockTotal, nextStockDisponible);

  const updateRow = {
    ...validated,
    updated_at: new Date().toISOString(),
  };

  const { data, error } = await supabaseAdmin
    .from('premios_canjeables')
    .update(updateRow)
    .eq('id', existing.id)
    .select(PREMIO_SELECT)
    .single();

  if (error) throw error;
  return data;
}

export async function deactivatePremioCanjeable(supabaseAdmin, premioId) {
  const existing = await getPremioCanjeableById(supabaseAdmin, premioId);
  if (!existing) {
    throw buildHttpError('Premio no encontrado', 404);
  }

  const { data, error } = await supabaseAdmin
    .from('premios_canjeables')
    .update({
      activo: false,
      updated_at: new Date().toISOString(),
    })
    .eq('id', existing.id)
    .select(PREMIO_SELECT)
    .single();

  if (error) throw error;
  return data;
}
