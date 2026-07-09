import { reservaHoraInicioFromRow } from '../utils/reservasColumns.js';
import {
  PRICE_SOURCES,
  normalizeSurgeDeporte,
  resolveReservaBasePrice,
} from './pricing/resolveReservaBasePrice.js';

export { normalizeSurgeDeporte } from './pricing/resolveReservaBasePrice.js';

const DEFAULT_TZ = 'America/Argentina/Buenos_Aires';
const SURGE_WINDOW_MS = 8 * 60 * 60 * 1000;

export function getTodayArgentinaDate() {
  return formatDateInTimezone(new Date(), DEFAULT_TZ);
}

function roundToNearest100(value) {
  const n = Number(value) || 0;
  return Math.round(n / 100) * 100;
}

/**
 * Precio base fijo (sin Surge) — delega en resolveReservaBasePrice.
 */
export async function precioFijoSedeParaDuracion(supabaseAdmin, sede, duracionMin, options = {}) {
  const result = await resolveReservaBasePrice(supabaseAdmin, {
    sedeId: sede?.id,
    sede,
    duracionMinutos: duracionMin,
    deporte: options.deporte ?? 'padbol',
    slotInicio: options.slot_inicio ?? null,
    timezone: options.timezone,
    skipFranjas: options.skipFranjas === true,
  });
  return result.precio;
}

function formatDateInTimezone(date, tz) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function getLocalPartsInTimezone(date, tz) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    weekday: 'short',
    hour12: false,
  }).formatToParts(date);

  const get = (type) => parts.find((p) => p.type === type)?.value ?? '';
  const hour = Number(get('hour')) % 24;
  const weekdayMap = { Sun: 7, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    hour,
    minute: Number(get('minute')),
    second: Number(get('second')),
    isoWeekday: weekdayMap[get('weekday')] ?? 1,
  };
}

function localDateTimeToUtcMs(year, month, day, hour, minute, tz) {
  const guessUtc = Date.UTC(year, month - 1, day, hour, minute, 0);
  const local = getLocalPartsInTimezone(new Date(guessUtc), tz);
  const asUtc = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, 0);
  const offsetMs = asUtc - guessUtc;
  return guessUtc - offsetMs;
}

function reservaStartMs(row, tz) {
  const fecha = String(row?.fecha ?? '').trim();
  const hora = reservaHoraInicioFromRow(row);
  if (!fecha || !hora) return null;
  const [y, m, d] = fecha.split('-').map(Number);
  const [hh, mm] = hora.split(':').map(Number);
  if (!Number.isFinite(y) || !Number.isFinite(hh)) return null;
  return localDateTimeToUtcMs(y, m, d, hh, mm || 0, tz);
}

function mergeReservasById(rows) {
  const map = new Map();
  for (const row of rows ?? []) {
    if (row?.id != null) map.set(row.id, row);
  }
  return [...map.values()];
}

async function fetchCanchasForDeporte(supabaseAdmin, sedeId, deporte) {
  const tables = ['canchas', 'cancha'];
  const normalized = normalizeSurgeDeporte(deporte);

  for (const table of tables) {
    try {
      const { data, error } = await supabaseAdmin
        .from(table)
        .select('id, deporte, sport, tipo_deporte, nombre, numero, name')
        .eq('sede_id', sedeId);

      if (error) throw error;
      if (!data?.length) continue;

      const matches = data.filter((row) => {
        const dep = String(row.deporte ?? row.sport ?? row.tipo_deporte ?? 'padbol').trim().toLowerCase();
        return dep === normalized;
      });
      if (matches.length) return matches;
    } catch {
      // try next table name
    }
  }
  return [];
}

function reservaMatchesDeporte(row, deporte, canchas) {
  const rowDeporte = row?.deporte != null ? String(row.deporte).trim().toLowerCase() : null;
  if (rowDeporte) return rowDeporte === deporte;

  if (!canchas.length) return true;
  const cid = row?.cancha_id != null ? parseInt(String(row.cancha_id), 10) : null;
  if (Number.isFinite(cid) && canchas.some((c) => Number(c.id) === cid)) return true;

  const canchaText = String(row?.cancha ?? '').trim().toLowerCase();
  if (!canchaText) return false;
  return canchas.some((c) => {
    const nombre = String(c.nombre ?? c.name ?? '').trim().toLowerCase();
    const numero = c.numero != null ? String(c.numero).trim().toLowerCase() : '';
    return (nombre && canchaText === nombre)
      || (numero && canchaText === numero)
      || (numero && canchaText === `cancha ${numero}`);
  });
}

async function fetchReservasForSede(supabaseAdmin, sede) {
  const selectCols = 'id, fecha, hora, hora_inicio, estado, sede_id, sede, deporte, created_at, cancha, cancha_id';
  const queries = [];

  if (sede?.id != null) {
    queries.push(
      supabaseAdmin
        .from('reservas')
        .select(selectCols)
        .eq('sede_id', sede.id),
    );
  }
  if (sede?.nombre) {
    queries.push(
      supabaseAdmin
        .from('reservas')
        .select(selectCols)
        .eq('sede', sede.nombre),
    );
  }

  if (!queries.length) return [];

  const results = await Promise.all(queries);
  for (const r of results) {
    if (r.error) throw r.error;
  }
  return mergeReservasById(results.flatMap((r) => r.data ?? []));
}

function filterReservasByDeporte(rows, deporte, canchas) {
  return rows.filter((row) => reservaMatchesDeporte(row, deporte, canchas));
}

function countReservasInStartWindow(rows, nowMs, windowEndMs, tz) {
  let count = 0;
  for (const row of rows) {
    if (String(row?.estado ?? '').toLowerCase() !== 'confirmada') continue;
    const startMs = reservaStartMs(row, tz);
    if (startMs == null) continue;
    if (startMs >= nowMs && startMs <= windowEndMs) count += 1;
  }
  return count;
}

function countReservasCreatedBetween(rows, startMs, endMs, deporte, canchas) {
  let count = 0;
  for (const row of filterReservasByDeporte(rows, deporte, canchas)) {
    const createdMs = row?.created_at ? new Date(row.created_at).getTime() : NaN;
    if (!Number.isFinite(createdMs)) continue;
    if (createdMs >= startMs && createdMs < endMs) count += 1;
  }
  return count;
}

function velocityMultiplier(ratio) {
  if (ratio > 2.5) return 1.3;
  if (ratio > 1.5) return 1.15;
  if (ratio > 1.0) return 1.05;
  return 1.0;
}

function timeMultiplier(isoWeekday, hour) {
  const isWeekend = isoWeekday === 6 || isoWeekday === 7;
  if (hour >= 18 && hour <= 23) return 1.1;
  if (isWeekend && hour >= 10 && hour <= 23) return 1.1;
  if (!isWeekend && isoWeekday >= 1 && isoWeekday <= 5 && hour < 12) return 0.9;
  return 1.0;
}

function precioFromCombined(combined, minimo, maximo) {
  const min = Number(minimo) || 0;
  const max = Number(maximo) || 0;
  const span = Math.max(0, max - min);
  const c = Math.max(0, Number(combined) || 0);

  if (c < 0.30) return min;
  if (c < 0.60) return min + span * 0.35;
  if (c < 0.85) return min + span * 0.70;
  return max;
}

function computeSurgePriceRangeFromPct(precioBase, descuentoMaxPct, aumentoMaxPct) {
  const base = Number(precioBase) || 0;
  const descPct = Number(descuentoMaxPct);
  const aumPct = Number(aumentoMaxPct);
  if (base <= 0 || !Number.isFinite(descPct) || !Number.isFinite(aumPct)) return null;
  if (descPct < 0 || descPct > 100 || aumPct < 0) return null;

  const minimo = Math.round(base * (1 - descPct / 100));
  const maximo = Math.round(base * (1 + aumPct / 100));
  if (maximo < minimo) return null;
  return { minimo, maximo };
}

function parseSlotInicio(raw, tz) {
  if (raw == null || String(raw).trim() === '') return null;
  const ms = new Date(String(raw).trim()).getTime();
  if (!Number.isFinite(ms)) {
    throw Object.assign(new Error('slot_inicio inválido'), { status: 400 });
  }
  return { ms, local: getLocalPartsInTimezone(new Date(ms), tz) };
}

/**
 * Padbol Surge v2 — precio dinámico por ocupación, velocidad, horario y last-minute.
 * @param {object} supabaseAdmin
 * @param {number|string} sedeId
 * @param {string} deporte
 * @param {number|string} duracionMin
 * @param {{ slot_inicio?: string|null }} [options]
 */
export async function calculateSurgePrice(supabaseAdmin, sedeId, deporte, duracionMin, options = {}) {
  const sid = parseInt(String(sedeId), 10);
  if (!Number.isFinite(sid) || sid <= 0) {
    throw Object.assign(new Error('sedeId inválido'), { status: 400 });
  }

  const dep = normalizeSurgeDeporte(deporte);

  const duracion = parseInt(String(duracionMin), 10);
  if (!Number.isFinite(duracion) || duracion < 15) {
    throw Object.assign(new Error('duracion inválida'), { status: 400 });
  }

  const { data: sede, error } = await supabaseAdmin
    .from('sedes')
    .select(
      'id, nombre, cantidad_canchas, timezone, precio_60min, precio_90min, precio_120min, precio_turno, precio_por_reserva',
    )
    .eq('id', sid)
    .maybeSingle();

  if (error) throw error;
  if (!sede) throw Object.assign(new Error('Sede no encontrada'), { status: 404 });

  const tz = String(sede.timezone || DEFAULT_TZ).trim() || DEFAULT_TZ;

  const baseResolved = await resolveReservaBasePrice(supabaseAdmin, {
    sedeId: sid,
    sede,
    deporte: dep,
    duracionMinutos: duracion,
    slotInicio: options.slot_inicio ?? null,
    timezone: tz,
  });

  if (!baseResolved.precio || baseResolved.precio <= 0) {
    throw Object.assign(
      new Error(`No hay precio configurado para ${duracion} min (${dep}) en la sede ${sid}`),
      { status: 400, code: 'PRECIO_NO_CONFIGURADO', baseResolved },
    );
  }

  const precioBase = baseResolved.precio;

  if (baseResolved.source === PRICE_SOURCES.FRANJA_PRECIO) {
    return {
      precio: precioBase,
      precio_base: precioBase,
      surge_activo: false,
      franja_activa: true,
      precio_metadata: baseResolved,
    };
  }

  const { data: config, error: cfgErr } = await supabaseAdmin
    .from('surge_config')
    .select('descuento_max_pct, aumento_max_pct, activo')
    .eq('sede_id', sid)
    .eq('deporte', dep)
    .maybeSingle();

  if (cfgErr) throw cfgErr;
  if (!config || config.activo !== true) {
    return { precio: precioBase, precio_base: precioBase, surge_activo: false, precio_metadata: baseResolved };
  }

  const priceRange = computeSurgePriceRangeFromPct(
    precioBase,
    config.descuento_max_pct,
    config.aumento_max_pct,
  );
  if (!priceRange) {
    return { precio: precioBase, precio_base: precioBase, surge_activo: false, precio_metadata: baseResolved };
  }

  const { minimo, maximo } = priceRange;

  const nowMs = Date.now();
  const windowEndMs = nowMs + SURGE_WINDOW_MS;
  const canchas = await fetchCanchasForDeporte(supabaseAdmin, sid, dep);
  const reservasAll = await fetchReservasForSede(supabaseAdmin, sede);
  const reservasDeporte = filterReservasByDeporte(reservasAll, dep, canchas);

  const reservasCount = countReservasInStartWindow(reservasDeporte, nowMs, windowEndMs, tz);
  const cantidadCanchas = Math.max(1, parseInt(String(sede.cantidad_canchas ?? 1), 10) || 1);
  const maxSlots = Math.max(1, cantidadCanchas * (480 / duracion));
  const baseOcupacion = Math.min(1, reservasCount / maxSlots);

  const recentStartMs = nowMs - 60 * 60 * 1000;
  const recentCount = countReservasCreatedBetween(reservasAll, recentStartMs, nowMs, dep, canchas);

  const weeklyCounts = [];
  for (let week = 1; week <= 4; week += 1) {
    const histStartMs = recentStartMs - week * 7 * 24 * 60 * 60 * 1000;
    const histEndMs = nowMs - week * 7 * 24 * 60 * 60 * 1000;
    weeklyCounts.push(countReservasCreatedBetween(reservasAll, histStartMs, histEndMs, dep, canchas));
  }
  const historicalAvg = weeklyCounts.reduce((sum, n) => sum + n, 0) / weeklyCounts.length;
  const velocityRatio = recentCount / Math.max(historicalAvg, 1);
  const velocityMult = velocityMultiplier(velocityRatio);

  const nowLocal = getLocalPartsInTimezone(new Date(nowMs), tz);
  const timeMult = timeMultiplier(nowLocal.isoWeekday, nowLocal.hour);

  let lastMinute = false;
  let lmMultiplier = 1.0;
  const slot = parseSlotInicio(options.slot_inicio, tz);
  if (slot && slot.ms - nowMs < 2 * 60 * 60 * 1000 && baseOcupacion < 0.40) {
    lastMinute = true;
    lmMultiplier = 0.85;
  }

  const combined = baseOcupacion * velocityMult * timeMult;
  let precio = precioFromCombined(combined, minimo, maximo) * lmMultiplier;
  precio = roundToNearest100(precio);

  try {
    await supabaseAdmin.from('surge_historial').insert({
      sede_id: sid,
      deporte: dep,
      ocupacion_porcentaje: Math.round(baseOcupacion * 100),
      precio_calculado: precio,
      precio_base: precioBase,
      multiplicador: Number(combined.toFixed(4)),
    });
  } catch (histErr) {
    console.warn('⚠️ surge_historial insert:', histErr.message);
  }

  return {
    precio,
    precio_base: precioBase,
    ocupacion_porcentaje: Math.round(baseOcupacion * 100),
    velocity_ratio: Number(velocityRatio.toFixed(4)),
    multiplicador: Number(combined.toFixed(4)),
    surge_activo: true,
    last_minute_discount: lastMinute,
    precio_metadata: baseResolved,
  };
}
