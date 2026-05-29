import {
  normalizeHoraInicioReserva,
  computeHoraFinDesdeDuracion,
  parsePositiveIntReserva,
  reservaLegacyHoraText,
} from './reservasTime.js';

/** SQL: hora_inicio con fallback desde hora legacy ("HH:MM" o "HH:MM - HH:MM"). */
export function sqlReservaHoraInicio(alias = '') {
  const p = alias ? `${alias}.` : '';
  return `COALESCE(NULLIF(TRIM(${p}hora_inicio), ''), NULLIF(TRIM(SPLIT_PART(${p}hora, ' - ', 1)), ''))`;
}

/** SQL: hora_fin con fallback desde segunda parte de hora legacy. */
export function sqlReservaHoraFin(alias = '') {
  const p = alias ? `${alias}.` : '';
  return `COALESCE(NULLIF(TRIM(${p}hora_fin), ''), NULLIF(TRIM(SPLIT_PART(${p}hora, ' - ', 2)), ''))`;
}

/** SQL: filtro sede por sede_id y/o nombre (params: sedeId, sedeNombre). */
export function sqlReservaSedeMatch(alias = '', sedeIdParam = '$1', sedeNombreParam = '$2') {
  const p = alias ? `${alias}.` : '';
  return `((${sedeIdParam}::int IS NOT NULL AND ${p}sede_id = ${sedeIdParam}) OR lower(trim(COALESCE(${p}sede, ''))) = lower(trim(${sedeNombreParam})))`;
}

export function reservaHoraInicioFromRow(row) {
  if (row?.hora_inicio != null && String(row.hora_inicio).trim() !== '') {
    return String(row.hora_inicio).trim().slice(0, 5);
  }
  return normalizeHoraInicioReserva(row?.hora);
}

export function reservaHoraFinFromRow(row, duracionFallback = 90) {
  if (row?.hora_fin != null && String(row.hora_fin).trim() !== '') {
    return String(row.hora_fin).trim().slice(0, 5);
  }
  const inicio = reservaHoraInicioFromRow(row);
  const legacyParts = String(row?.hora ?? '').split(' - ').map((s) => s.trim());
  if (legacyParts[1]) return legacyParts[1].slice(0, 5);
  if (inicio) {
    const dur = parsePositiveIntReserva(row?.duracion_minutos) ?? duracionFallback;
    return computeHoraFinDesdeDuracion(inicio, dur);
  }
  return null;
}

export { reservaLegacyHoraText };

export function reservaMatchesSede(row, { sedeId, sedeNombre }) {
  if (sedeId != null && row?.sede_id != null && Number(row.sede_id) === Number(sedeId)) {
    return true;
  }
  const nombre = String(sedeNombre ?? '').trim().toLowerCase();
  const rowSede = String(row?.sede ?? '').trim().toLowerCase();
  return Boolean(nombre && rowSede && rowSede === nombre);
}
