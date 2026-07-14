const DEFAULT_TZ = 'America/Argentina/Buenos_Aires';

export const VALID_SURGE_DEPORTES = new Set(['padbol', 'padel', 'pickleball', 'tenis']);

/** MEJ-07: custom usa precio específico o base de sede; nunca se remapea a padbol. */
export const DEPORTE_CUSTOM_PRICING = 'custom';

export const PRICE_SOURCES = {
  FRANJA_PRECIO: 'franjas_precio',
  SEDES_DURACIONES_DEPORTE: 'sedes_duraciones_deporte',
  SEDES_DURACIONES_BASE: 'sedes_duraciones_base',
  LEGACY_SEDE: 'legacy_sede',
  NONE: 'none',
};

const PRECIO_COL = {
  60: 'precio_60min',
  90: 'precio_90min',
  120: 'precio_120min',
};

const FRANJA_PRECIO_COL = {
  60: 'precio_60min',
  90: 'precio_90min',
  120: 'precio_120min',
};

export function normalizeSurgeDeporte(value) {
  const key = String(value ?? 'padbol').trim().toLowerCase();
  if (key === DEPORTE_CUSTOM_PRICING) return DEPORTE_CUSTOM_PRICING;
  if (!VALID_SURGE_DEPORTES.has(key)) {
    throw Object.assign(new Error('deporte inválido'), { status: 400 });
  }
  return key;
}

export function normalizeDeporteNullable(value) {
  if (value == null || String(value).trim() === '') return null;
  return normalizeSurgeDeporte(value);
}

export function parsePrecioInt(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  const n = Number(String(raw).replace(/\./g, '').replace(',', '.'));
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n);
}

export function resolveLegacySedePrice(sede, duracionMin) {
  const d = parseInt(String(duracionMin), 10);
  const col = PRECIO_COL[d];
  if (col) {
    const fromCol = parsePrecioInt(sede?.[col]);
    if (fromCol != null) {
      return { precio: fromCol, legacyField: col };
    }
  }
  if (d === 90) {
    const legacy = parsePrecioInt(sede?.precio_turno);
    if (legacy != null) {
      return { precio: legacy, legacyField: 'precio_turno' };
    }
    const ppr = parsePrecioInt(sede?.precio_por_reserva);
    if (ppr != null) {
      return { precio: ppr, legacyField: 'precio_por_reserva' };
    }
  }
  return { precio: 0, legacyField: null };
}

function isMissingColumnError(error, column) {
  const msg = String(error?.message || '').toLowerCase();
  const col = String(column || '').toLowerCase();
  return msg.includes(col) && (msg.includes('column') || msg.includes('does not exist'));
}

function buildBaseResult({
  precio,
  source,
  sedeId,
  deporte,
  duracionMinutos,
  franjaId = null,
  legacyField = null,
  sedesDuracionesId = null,
}) {
  return {
    precio: Number(precio) || 0,
    source,
    deporte,
    duracion_minutos: duracionMinutos,
    sede_id: sedeId,
    franja_id: franjaId,
    legacyField,
    sedes_duraciones_id: sedesDuracionesId,
  };
}

async function fetchSedeIfNeeded(supabaseAdmin, sedeId, sede) {
  if (sede?.id != null) return sede;
  const { data, error } = await supabaseAdmin
    .from('sedes')
    .select(
      'id, nombre, timezone, precio_60min, precio_90min, precio_120min, precio_turno, precio_por_reserva',
    )
    .eq('id', sedeId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function resolveFranjaPrecio(supabaseAdmin, {
  sedeId,
  deporte,
  duracionMinutos,
  slotInicio,
  timezone,
}) {
  if (!slotInicio) return null;

  const tz = String(timezone || DEFAULT_TZ).trim() || DEFAULT_TZ;
  const slotDate = new Date(String(slotInicio).trim());
  if (!Number.isFinite(slotDate.getTime())) return null;

  const diaSemana = slotDate.toLocaleDateString('es-AR', { timeZone: tz, weekday: 'short' });
  const diasMap = { dom: 0, lun: 1, mar: 2, mié: 3, jue: 4, vie: 5, sáb: 6 };
  const diaNum = diasMap[diaSemana.toLowerCase().slice(0, 3)];
  const horaLocal = slotDate.toLocaleTimeString('es-AR', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });

  const { data: franjas, error } = await supabaseAdmin
    .from('franjas_precio')
    .select('id, hora_inicio, hora_fin, precio_60min, precio_90min, precio_120min, dia_semana')
    .eq('sede_id', sedeId)
    .eq('deporte', deporte)
    .eq('activo', true)
    .or(`dia_semana.eq.${diaNum},dia_semana.is.null`);

  if (error) throw error;
  if (!franjas?.length) return null;

  const matching = franjas
    .filter((f) => horaLocal >= f.hora_inicio.slice(0, 5) && horaLocal < f.hora_fin.slice(0, 5))
    .sort((a, b) => (a.dia_semana === null ? 1 : -1));

  if (!matching.length) return null;

  const franja = matching[0];
  const col = FRANJA_PRECIO_COL[duracionMinutos];
  if (!col) return null;

  const precioFranja = parsePrecioInt(franja[col]);
  if (precioFranja == null || precioFranja <= 0) return null;

  return {
    precio: precioFranja,
    franja_id: franja.id ?? null,
  };
}

async function fetchSedesDuracionesRows(supabaseAdmin, sedeId, duracionMinutos, { activeOnly = true } = {}) {
  const selectWithDeporte = 'id, sede_id, duracion_minutos, precio, activo, deporte';
  const selectBase = 'id, sede_id, duracion_minutos, precio, activo';

  let query = supabaseAdmin
    .from('sedes_duraciones')
    .select(selectWithDeporte)
    .eq('sede_id', sedeId)
    .eq('duracion_minutos', duracionMinutos);

  if (activeOnly) {
    query = query.eq('activo', true);
  }

  const { data, error } = await query;
  if (!error) return data ?? [];

  if (isMissingColumnError(error, 'deporte')) {
    let fallbackQuery = supabaseAdmin
      .from('sedes_duraciones')
      .select(selectBase)
      .eq('sede_id', sedeId)
      .eq('duracion_minutos', duracionMinutos);
    if (activeOnly) {
      fallbackQuery = fallbackQuery.eq('activo', true);
    }
    const { data: data2, error: error2 } = await fallbackQuery;
    if (error2) throw error2;
    return (data2 ?? []).map((row) => ({ ...row, deporte: null }));
  }

  throw error;
}

function pickSedesDuracionRow(rows, deporte) {
  const sportRow = rows.find((row) => {
    const dep = row.deporte != null ? String(row.deporte).trim().toLowerCase() : null;
    return dep && dep === deporte;
  });
  if (sportRow) return { row: sportRow, source: PRICE_SOURCES.SEDES_DURACIONES_DEPORTE };

  const baseRow = rows.find((row) => row.deporte == null || String(row.deporte).trim() === '');
  if (baseRow) return { row: baseRow, source: PRICE_SOURCES.SEDES_DURACIONES_BASE };

  return null;
}

/**
 * Resuelve precio base de reserva (sin Surge).
 * Prioridad: franjas_precio → sedes_duraciones(deporte) → sedes_duraciones(base) → legacy sedes.
 */
export async function resolveReservaBasePrice(supabaseAdmin, {
  sedeId,
  sede = null,
  deporte = 'padbol',
  duracionMinutos,
  slotInicio = null,
  timezone = null,
  skipFranjas = false,
} = {}) {
  const sid = parseInt(String(sedeId), 10);
  if (!Number.isFinite(sid) || sid <= 0) {
    throw Object.assign(new Error('sedeId inválido'), { status: 400 });
  }

  const duracion = parseInt(String(duracionMinutos), 10);
  if (!Number.isFinite(duracion) || duracion < 15) {
    throw Object.assign(new Error('duracion inválida'), { status: 400 });
  }

  const dep = normalizeSurgeDeporte(deporte);
  const sedeRow = await fetchSedeIfNeeded(supabaseAdmin, sid, sede);
  if (!sedeRow) {
    throw Object.assign(new Error('Sede no encontrada'), { status: 404 });
  }

  const tz = String(timezone ?? sedeRow.timezone ?? DEFAULT_TZ).trim() || DEFAULT_TZ;

  if (!skipFranjas && slotInicio) {
    try {
      const franja = await resolveFranjaPrecio(supabaseAdmin, {
        sedeId: sid,
        deporte: dep,
        duracionMinutos: duracion,
        slotInicio,
        timezone: tz,
      });
      if (franja) {
        return buildBaseResult({
          precio: franja.precio,
          source: PRICE_SOURCES.FRANJA_PRECIO,
          sedeId: sid,
          deporte: dep,
          duracionMinutos: duracion,
          franjaId: franja.franja_id,
        });
      }
    } catch (franjaErr) {
      console.warn('⚠️ resolveReservaBasePrice franjas_precio:', franjaErr.message);
    }
  }

  const duracionRows = await fetchSedesDuracionesRows(supabaseAdmin, sid, duracion, { activeOnly: true });
  const picked = pickSedesDuracionRow(duracionRows, dep);
  if (picked) {
    const precio = parsePrecioInt(picked.row.precio);
    if (precio != null && precio > 0) {
      return buildBaseResult({
        precio,
        source: picked.source,
        sedeId: sid,
        deporte: dep,
        duracionMinutos: duracion,
        sedesDuracionesId: picked.row.id ?? null,
      });
    }
  }

  const legacy = resolveLegacySedePrice(sedeRow, duracion);
  if (legacy.precio > 0) {
    return buildBaseResult({
      precio: legacy.precio,
      source: PRICE_SOURCES.LEGACY_SEDE,
      sedeId: sid,
      deporte: dep,
      duracionMinutos: duracion,
      legacyField: legacy.legacyField,
    });
  }

  return buildBaseResult({
    precio: 0,
    source: PRICE_SOURCES.NONE,
    sedeId: sid,
    deporte: dep,
    duracionMinutos: duracion,
  });
}
