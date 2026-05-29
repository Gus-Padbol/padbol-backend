export function parsePositiveIntReserva(value) {
  if (value == null || value === '') return null;
  const parsed = parseInt(value, 10);
  return Number.isNaN(parsed) ? null : parsed;
}

/** "HH:MM" o "HH:MM - HH:MM" → inicio HH:MM */
export function normalizeHoraInicioReserva(raw) {
  const h = String(raw ?? '').trim();
  if (!h) return '';
  if (h.includes(' - ')) return h.split(' - ')[0].trim().slice(0, 5);
  return h.slice(0, 5);
}

/** Inicio HH:MM + duración en minutos → fin HH:MM (default 90). */
export function computeHoraFinDesdeDuracion(horaInicio, duracionMinutos = 90) {
  const inicio = normalizeHoraInicioReserva(horaInicio);
  if (!inicio) return null;
  const dur = parsePositiveIntReserva(duracionMinutos) ?? 90;
  const [hh, mm] = inicio.split(':').map(Number);
  if (!Number.isFinite(hh) || !Number.isFinite(mm)) return null;
  const totalMinutes = hh * 60 + mm + dur;
  const endH = Math.floor(totalMinutes / 60) % 24;
  const endM = totalMinutes % 60;
  return `${String(endH).padStart(2, '0')}:${String(endM).padStart(2, '0')}`;
}

export function resolveHoraInicioYFinReserva({
  hora,
  hora_inicio,
  hora_fin,
  duracion_minutos,
}) {
  const inicio = normalizeHoraInicioReserva(hora_inicio ?? hora);
  const duracion = parsePositiveIntReserva(duracion_minutos) ?? 90;
  let fin = hora_fin != null && String(hora_fin).trim() !== ''
    ? String(hora_fin).trim().slice(0, 5)
    : null;
  if (!fin && inicio) {
    fin = computeHoraFinDesdeDuracion(inicio, duracion);
  }
  return {
    hora_inicio: inicio || null,
    hora_fin: fin,
    duracion_minutos: duracion,
  };
}

export function reservaLegacyHoraText(horaInicio, horaFin) {
  const hi = horaInicio ? String(horaInicio).trim().slice(0, 5) : '';
  const hf = horaFin ? String(horaFin).trim().slice(0, 5) : '';
  if (hi && hf) return `${hi} - ${hf}`;
  return hi || null;
}
