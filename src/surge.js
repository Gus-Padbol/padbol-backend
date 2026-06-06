import { generarIniciosMinutosSlotReserva } from '../lib/reservaSlotsHorarios.js';
import { reservaHoraInicioFromRow } from '../utils/reservasColumns.js';

const SURGE_WINDOW_MIN = 8 * 60;
const TZ_AR = 'America/Argentina/Buenos_Aires';
const VALID_SURGE_DEPORTES = new Set(['padbol', 'padel', 'pickleball', 'tenis']);

const PRECIO_COL = {
  60: 'precio_60min',
  90: 'precio_90min',
  120: 'precio_120min',
};

function getNowArgentina() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: TZ_AR }));
}

export function getTodayArgentinaDate() {
  const nowAR = getNowArgentina();
  const year = nowAR.getFullYear();
  const month = String(nowAR.getMonth() + 1).padStart(2, '0');
  const day = String(nowAR.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function normalizeSurgeDeporte(value) {
  const key = String(value ?? 'padbol').trim().toLowerCase();
  if (!VALID_SURGE_DEPORTES.has(key)) {
    throw Object.assign(new Error('deporte inválido'), { status: 400 });
  }
  return key;
}

function parseTimeToMinutes(time) {
  const [hours, minutes] = String(time ?? '').slice(0, 5).split(':').map(Number);
  if (Number.isNaN(hours) || Number.isNaN(minutes)) return null;
  return hours * 60 + minutes;
}

function roundToNearest100(value) {
  const n = Number(value) || 0;
  return Math.round(n / 100) * 100;
}

function parsePrecioInt(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  const n = Number(String(raw).replace(/\./g, '').replace(',', '.'));
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n);
}

function precioFijoSedeParaDuracion(sede, duracionMin) {
  const d = parseInt(String(duracionMin), 10);
  const col = PRECIO_COL[d];
  if (col) {
    const fromCol = parsePrecioInt(sede?.[col]);
    if (fromCol != null) return fromCol;
  }
  if (d === 90) {
    const legacy = parsePrecioInt(sede?.precio_turno);
    if (legacy != null) return legacy;
    const ppr = parsePrecioInt(sede?.precio_por_reserva);
    if (ppr != null) return ppr;
  }
  return 0;
}

function precioDesdeOcupacion(ocupacionPct, minimo, maximo) {
  const min = Number(minimo) || 0;
  const max = Number(maximo) || 0;
  const span = Math.max(0, max - min);
  const occ = Math.max(0, Math.min(100, Number(ocupacionPct) || 0));

  let raw = min;
  if (occ <= 30) {
    raw = min;
  } else if (occ <= 60) {
    raw = min + span * 0.35;
  } else if (occ <= 85) {
    raw = min + span * 0.7;
  } else {
    raw = max;
  }
  return roundToNearest100(raw);
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

function reservaMatchesDeporteCanchas(row, canchas) {
  if (!canchas.length) return false;
  const cid = row?.cancha_id != null ? parseInt(String(row.cancha_id), 10) : null;
  if (Number.isFinite(cid)) {
    if (canchas.some((c) => Number(c.id) === cid)) return true;
  }
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

async function fetchConfirmedReservasHoy(supabaseAdmin, sede) {
  const today = getTodayArgentinaDate();
  const selectCols = 'id, hora, hora_inicio, fecha, estado, sede_id, sede, created_at, cancha, cancha_id';
  const queries = [];

  if (sede?.id != null) {
    queries.push(
      supabaseAdmin
        .from('reservas')
        .select(selectCols)
        .eq('fecha', today)
        .eq('estado', 'confirmada')
        .eq('sede_id', sede.id),
    );
  }
  if (sede?.nombre) {
    queries.push(
      supabaseAdmin
        .from('reservas')
        .select(selectCols)
        .eq('fecha', today)
        .eq('estado', 'confirmada')
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

function countReservasEnVentana(reservas, windowStartMin, windowEndMin) {
  let count = 0;
  for (const row of reservas) {
    const inicio = parseTimeToMinutes(reservaHoraInicioFromRow(row));
    if (inicio == null) continue;
    if (inicio >= windowStartMin && inicio < windowEndMin) count += 1;
  }
  return count;
}

function maxSlotsEnVentana(sede, duracionMin, windowStartMin, windowEndMin) {
  const today = getTodayArgentinaDate();
  const canchas = Math.max(1, parseInt(String(sede?.cantidad_canchas ?? 1), 10) || 1);
  const inicios = generarIniciosMinutosSlotReserva(sede, today, duracionMin, 30);
  const slotsInWindow = inicios.filter((m) => m >= windowStartMin && m < windowEndMin).length;
  return Math.max(1, slotsInWindow * canchas);
}

function fixedPriceResult(sede, duracionMin) {
  return {
    precio: precioFijoSedeParaDuracion(sede, duracionMin),
    ocupacion_porcentaje: 0,
    surge_activo: false,
  };
}

/**
 * Calcula precio Surge según ocupación de canchas por deporte en las próximas 8 horas (hoy).
 * @returns {{ precio: number, ocupacion_porcentaje: number, surge_activo: boolean }}
 */
export async function calculateSurgePrice(supabaseAdmin, sedeId, deporte, duracionMin) {
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
      'id, nombre, surge_activo, cantidad_canchas, duracion_reserva_minutos, horario_apertura, horario_cierre, precio_60min, precio_90min, precio_120min, precio_turno, precio_por_reserva',
    )
    .eq('id', sid)
    .maybeSingle();

  if (error) throw error;
  if (!sede) throw Object.assign(new Error('Sede no encontrada'), { status: 404 });

  if (sede.surge_activo !== true) {
    return fixedPriceResult(sede, duracion);
  }

  const { data: config, error: cfgErr } = await supabaseAdmin
    .from('surge_config')
    .select('precio_minimo, precio_maximo, activo')
    .eq('sede_id', sid)
    .eq('deporte', dep)
    .maybeSingle();

  if (cfgErr) throw cfgErr;
  if (!config || config.activo !== true) {
    return fixedPriceResult(sede, duracion);
  }

  const minimo = Number(config.precio_minimo) || 0;
  const maximo = Number(config.precio_maximo) || 0;
  if (minimo <= 0 || maximo <= 0 || maximo < minimo) {
    return fixedPriceResult(sede, duracion);
  }

  const nowAR = getNowArgentina();
  const windowStartMin = nowAR.getHours() * 60 + nowAR.getMinutes();
  const windowEndMin = windowStartMin + SURGE_WINDOW_MIN;

  const canchasDeporte = await fetchCanchasForDeporte(supabaseAdmin, sid, dep);
  const reservasAll = await fetchConfirmedReservasHoy(supabaseAdmin, sede);
  const reservasDeporte = canchasDeporte.length
    ? reservasAll.filter((r) => reservaMatchesDeporteCanchas(r, canchasDeporte))
    : reservasAll;

  const activeCount = countReservasEnVentana(reservasDeporte, windowStartMin, windowEndMin);
  const maxSlots = maxSlotsEnVentana(sede, duracion, windowStartMin, windowEndMin);
  const ocupacionPct = Math.min(100, Math.round((activeCount / maxSlots) * 100));
  const precio = precioDesdeOcupacion(ocupacionPct, minimo, maximo);

  return {
    precio,
    ocupacion_porcentaje: ocupacionPct,
    surge_activo: true,
  };
}
