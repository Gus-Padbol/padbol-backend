import { generarIniciosMinutosSlotReserva } from '../lib/reservaSlotsHorarios.js';
import { reservaHoraInicioFromRow } from '../utils/reservasColumns.js';

const SURGE_WINDOW_MIN = 8 * 60;
const TZ_AR = 'America/Argentina/Buenos_Aires';

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

function parseTimeToMinutes(time) {
  const [hours, minutes] = String(time ?? '').slice(0, 5).split(':').map(Number);
  if (Number.isNaN(hours) || Number.isNaN(minutes)) return null;
  return hours * 60 + minutes;
}

function roundToNearest100(value) {
  const n = Number(value) || 0;
  return Math.round(n / 100) * 100;
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

async function fetchConfirmedReservasHoy(supabaseAdmin, sede) {
  const today = getTodayArgentinaDate();
  const selectCols = 'id, hora, hora_inicio, fecha, estado, sede_id, sede, created_at';
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

/**
 * Calcula precio Surge según ocupación de canchas en las próximas 8 horas (hoy).
 * @returns {{ precio: number|null, ocupacion_porcentaje: number, surge_activo: boolean }}
 */
export async function calculateSurgePrice(supabaseAdmin, sedeId, duracionMin) {
  const sid = parseInt(String(sedeId), 10);
  if (!Number.isFinite(sid) || sid <= 0) {
    throw Object.assign(new Error('sedeId inválido'), { status: 400 });
  }

  const duracion = parseInt(String(duracionMin), 10);
  if (!Number.isFinite(duracion) || duracion < 15) {
    throw Object.assign(new Error('duracion inválida'), { status: 400 });
  }

  const { data: sede, error } = await supabaseAdmin
    .from('sedes')
    .select(
      'id, nombre, surge_activo, surge_precio_minimo, surge_precio_maximo, cantidad_canchas, duracion_reserva_minutos, horario_apertura, horario_cierre',
    )
    .eq('id', sid)
    .maybeSingle();

  if (error) throw error;
  if (!sede) throw Object.assign(new Error('Sede no encontrada'), { status: 404 });

  const surgeActivo = sede.surge_activo === true;
  if (!surgeActivo) {
    return { precio: null, ocupacion_porcentaje: 0, surge_activo: false };
  }

  const minimo = Number(sede.surge_precio_minimo) || 0;
  const maximo = Number(sede.surge_precio_maximo) || 0;
  if (minimo <= 0 || maximo <= 0 || maximo < minimo) {
    return { precio: null, ocupacion_porcentaje: 0, surge_activo: false };
  }

  const nowAR = getNowArgentina();
  const windowStartMin = nowAR.getHours() * 60 + nowAR.getMinutes();
  const windowEndMin = windowStartMin + SURGE_WINDOW_MIN;

  const reservas = await fetchConfirmedReservasHoy(supabaseAdmin, sede);
  const activeCount = countReservasEnVentana(reservas, windowStartMin, windowEndMin);
  const maxSlots = maxSlotsEnVentana(sede, duracion, windowStartMin, windowEndMin);
  const ocupacionPct = Math.min(100, Math.round((activeCount / maxSlots) * 100));
  const precio = precioDesdeOcupacion(ocupacionPct, minimo, maximo);

  return {
    precio,
    ocupacion_porcentaje: ocupacionPct,
    surge_activo: true,
  };
}
