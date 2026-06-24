/**
 * Generación de turnos para reservas desde horario_apertura / horario_cierre de la sede.
 */

import { reservaHoraInicioFromRow } from '../utils/reservasColumns.js';

export const RESERVA_SLOT_STEP_MIN = 30;
export const RESERVA_DURACION_SLOT_DEFAULT_MIN = 90;
const MINUTOS_DIA = 24 * 60;
const DEFAULT_APERTURA = '10:00';
const DEFAULT_CIERRE = '23:00';
const PARTIDO_DURACION_DEFAULT_MIN = 90;

/** Columnas `sedes`: horario_apertura / horario_cierre. */
export function horarioAperturaCierreSede(sede) {
  return {
    horario_apertura: sede?.horario_apertura,
    horario_cierre: sede?.horario_cierre,
  };
}

export function horaAMinutos(hhmm) {
  const s = String(hhmm || '').trim();
  const m = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (!m) return null;
  const h = parseInt(m[1], 10);
  const mi = parseInt(m[2], 10);
  if (!Number.isFinite(h) || !Number.isFinite(mi) || h > 23 || mi > 59) return null;
  return h * 60 + mi;
}

export function minutosAHoraReserva(totalMin) {
  const t = ((Number(totalMin) % MINUTOS_DIA) + MINUTOS_DIA) % MINUTOS_DIA;
  const h = Math.floor(t / 60);
  const m = t % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

export function ventanasHorarioReserva(sede) {
  const { horario_apertura, horario_cierre } = horarioAperturaCierreSede(sede);
  const startMin = horaAMinutos(horario_apertura) ?? horaAMinutos(DEFAULT_APERTURA);
  let endMin = horaAMinutos(horario_cierre) ?? horaAMinutos(DEFAULT_CIERRE);
  if (startMin == null || endMin == null) {
    return [{ startMin: 10 * 60, endMin: 23 * 60, cruzaMedianoche: false }];
  }
  if (endMin <= startMin) endMin += MINUTOS_DIA;
  return [{ startMin, endMin, cruzaMedianoche: endMin > MINUTOS_DIA }];
}

function agregarIniciosEnVentana(out, ventana, duracionMin, stepMin) {
  const { startMin, endMin, cruzaMedianoche } = ventana;
  const pushRango = (from, to) => {
    for (let start = from; start + duracionMin <= to; start += stepMin) {
      out.add(start % MINUTOS_DIA);
    }
  };
  if (!cruzaMedianoche) {
    pushRango(startMin, endMin);
    return;
  }
  pushRango(startMin, MINUTOS_DIA);
  pushRango(0, endMin);
}

function duracionSlotReservaMin(duracionMin) {
  const dur = parseInt(String(duracionMin), 10);
  if (!Number.isFinite(dur) || dur < 15) return RESERVA_DURACION_SLOT_DEFAULT_MIN;
  return dur;
}

export function generarIniciosMinutosSlotReserva(sede, _fechaISO, duracionMin, stepMin = RESERVA_SLOT_STEP_MIN) {
  const dur = duracionSlotReservaMin(duracionMin);
  const ventanas = ventanasHorarioReserva(sede);
  const inicios = new Set();
  for (const v of ventanas) {
    agregarIniciosEnVentana(inicios, v, dur, stepMin);
  }
  return [...inicios].sort((a, b) => a - b);
}

function horaInicioMinutosFromHora(hora) {
  return horaAMinutos(String(hora ?? '').trim().slice(0, 5));
}

function reservaDuracionBloqueoMin(reserva) {
  const dur = parseInt(String(reserva?.duracion_minutos ?? ''), 10);
  if (Number.isFinite(dur) && dur >= 15) return dur;
  return RESERVA_DURACION_SLOT_DEFAULT_MIN;
}

function partidoDuracionBloqueoMin(partido) {
  const dur = parseInt(String(partido?.duracion_minutos ?? ''), 10);
  if (Number.isFinite(dur) && dur >= 15) return dur;
  return PARTIDO_DURACION_DEFAULT_MIN;
}

export function intervalosSeSolapan(inicioA, finA, inicioB, finB) {
  return inicioA < finB && finA > inicioB;
}

export function ocupacionIntervaloMinutosReserva(reserva) {
  const startMin = horaAMinutos(reservaHoraInicioFromRow(reserva));
  if (startMin == null) return null;
  return { startMin, endMin: startMin + reservaDuracionBloqueoMin(reserva) };
}

export function ocupacionIntervaloMinutosPartido(partido) {
  const startMin = horaInicioMinutosFromHora(partido?.hora);
  if (startMin == null) return null;
  return { startMin, endMin: startMin + partidoDuracionBloqueoMin(partido) };
}

export function candidatoSlotRangoMinutos(hora, duracionMinutos) {
  const startMin = horaInicioMinutosFromHora(hora);
  if (startMin == null) return null;
  const dur = duracionSlotReservaMin(duracionMinutos);
  return { startMin, endMin: startMin + dur };
}

export function reservaSolapaSlot(reserva, hora, duracionMinutos) {
  const ocupacion = ocupacionIntervaloMinutosReserva(reserva);
  const candidato = candidatoSlotRangoMinutos(hora, duracionMinutos);
  if (!ocupacion || !candidato) return false;
  return intervalosSeSolapan(
    ocupacion.startMin,
    ocupacion.endMin,
    candidato.startMin,
    candidato.endMin,
  );
}

export function partidoSolapaSlot(partido, hora, duracionMinutos) {
  const ocupacion = ocupacionIntervaloMinutosPartido(partido);
  const candidato = candidatoSlotRangoMinutos(hora, duracionMinutos);
  if (!ocupacion || !candidato) return false;
  return intervalosSeSolapan(
    ocupacion.startMin,
    ocupacion.endMin,
    candidato.startMin,
    candidato.endMin,
  );
}

/**
 * Cuenta canchas sin reserva/partido que solape [hora, hora + duracion).
 */
export function contarCanchasLibresParaSlot({
  hora,
  duracionMinutos,
  totalCourts,
  blockingReservas = [],
  blockingPartidos = [],
  parseReservaCourt = (reserva) => reserva?.cancha ?? reserva?.cancha_id,
  parsePartidoCourt = (partido) => partido?.cancha,
  isReservaBlocking = () => true,
  isPartidoBlocking = () => true,
}) {
  let libres = 0;
  for (let canchaNum = 1; canchaNum <= totalCourts; canchaNum += 1) {
    const blockedByPartido = (blockingPartidos ?? []).some(
      (partido) => isPartidoBlocking(partido)
        && Number(parsePartidoCourt(partido)) === canchaNum
        && partidoSolapaSlot(partido, hora, duracionMinutos),
    );
    if (blockedByPartido) continue;

    const blockedByReserva = (blockingReservas ?? []).some(
      (reserva) => isReservaBlocking(reserva)
        && Number(parseReservaCourt(reserva)) === canchaNum
        && reservaSolapaSlot(reserva, hora, duracionMinutos),
    );
    if (blockedByReserva) continue;

    libres += 1;
  }
  return libres;
}

function buildBlockedIntervals(blockingReservas, blockingPartidos) {
  const intervals = [];

  for (const reserva of blockingReservas ?? []) {
    const startMin = horaAMinutos(reservaHoraInicioFromRow(reserva));
    if (startMin == null) continue;
    const endMin = startMin + reservaDuracionBloqueoMin(reserva);
    intervals.push({ startMin, endMin });
  }

  for (const partido of blockingPartidos ?? []) {
    const startMin = horaInicioMinutosFromHora(partido?.hora);
    if (startMin == null) continue;
    const endMin = startMin + partidoDuracionBloqueoMin(partido);
    intervals.push({ startMin, endMin });
  }

  return intervals;
}

function mergeBlockedIntervals(intervals) {
  const sorted = [...intervals]
    .filter(({ startMin, endMin }) => Number.isFinite(startMin) && Number.isFinite(endMin) && endMin > startMin)
    .sort((a, b) => a.startMin - b.startMin || a.endMin - b.endMin);

  const merged = [];
  for (const interval of sorted) {
    const last = merged[merged.length - 1];
    if (!last || interval.startMin > last.endMin) {
      merged.push({ ...interval });
      continue;
    }
    last.endMin = Math.max(last.endMin, interval.endMin);
  }
  return merged;
}

function segmentosVentanaOperativa(ventana) {
  const { startMin, endMin, cruzaMedianoche } = ventana;
  if (!cruzaMedianoche) {
    return [{ from: startMin, to: endMin }];
  }
  return [
    { from: startMin, to: MINUTOS_DIA },
    { from: 0, to: endMin - MINUTOS_DIA },
  ];
}

function freeIntervalsInSegment(segmentFrom, segmentTo, blockedMerged) {
  const free = [];
  let cursor = segmentFrom;

  for (const { startMin, endMin } of blockedMerged) {
    if (endMin <= segmentFrom) continue;
    if (startMin >= segmentTo) break;

    const blockStart = Math.max(startMin, segmentFrom);
    const blockEnd = Math.min(endMin, segmentTo);
    if (blockEnd <= segmentFrom) continue;

    if (blockStart > cursor) {
      free.push([cursor, blockStart]);
    }
    cursor = Math.max(cursor, blockEnd);
  }

  if (cursor < segmentTo) {
    free.push([cursor, segmentTo]);
  }

  return free;
}

function iniciosEnIntervaloLibre(freeStart, freeEnd, duracionMin, stepMin) {
  const inicios = [];
  if (freeStart + duracionMin <= freeEnd) {
    inicios.push(freeStart % MINUTOS_DIA);
  }
  for (let t = freeStart + stepMin; t + duracionMin <= freeEnd; t += stepMin) {
    inicios.push(t % MINUTOS_DIA);
  }
  return inicios;
}

/**
 * Genera inicios de turno alineados a huecos libres entre reservas/partidos bloqueantes.
 */
export function generarIniciosSmartSlots(
  sede,
  _fecha,
  duracionMin,
  blockingReservas = [],
  blockingPartidos = [],
  stepMin = RESERVA_SLOT_STEP_MIN,
) {
  const dur = duracionSlotReservaMin(duracionMin);
  const ventanas = ventanasHorarioReserva(sede);
  const blockedMerged = mergeBlockedIntervals(
    buildBlockedIntervals(blockingReservas, blockingPartidos),
  );

  const inicios = new Set();
  for (const ventana of ventanas) {
    for (const { from, to } of segmentosVentanaOperativa(ventana)) {
      const freeIntervals = freeIntervalsInSegment(from, to, blockedMerged);
      for (const [freeStart, freeEnd] of freeIntervals) {
        for (const inicio of iniciosEnIntervaloLibre(freeStart, freeEnd, dur, stepMin)) {
          inicios.add(inicio);
        }
      }
    }
  }

  return [...inicios].sort((a, b) => a - b);
}

export function turnoCabeEnVentanasReserva(inicioMin, duracionMin, ventanas) {
  const start = Number(inicioMin);
  const dur = duracionSlotReservaMin(duracionMin);
  if (!Number.isFinite(start)) return false;
  const end = start + dur;
  return (ventanas || []).some(({ startMin, endMin, cruzaMedianoche }) => {
    if (!cruzaMedianoche) {
      return start >= startMin && end <= endMin;
    }
    if (start >= startMin) return end <= MINUTOS_DIA;
    return start < endMin && end <= endMin;
  });
}

export function generarSlotsHorarioReserva(sede, fechaISO, duracionMin, stepMin = RESERVA_SLOT_STEP_MIN) {
  const dur = duracionSlotReservaMin(duracionMin);
  const inicios = generarIniciosMinutosSlotReserva(sede, fechaISO, dur, stepMin);
  return inicios.map((startMin) => {
    const endMin = startMin + dur;
    const horaInicio = minutosAHoraReserva(startMin);
    const horaFin = minutosAHoraReserva(endMin);
    return {
      startMin,
      endMin,
      horaInicio,
      horaFin,
      horario: `${horaInicio} - ${horaFin}`,
      hora: horaInicio,
    };
  });
}
