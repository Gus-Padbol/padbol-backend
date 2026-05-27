/**
 * Generación de turnos para reservas: franjas_horarias si existen; si no, horario_apertura / horario_cierre.
 */

const DIAS_SEMANA_FRANJA = ['dom', 'lun', 'mar', 'mie', 'jue', 'vie', 'sab'];
export const RESERVA_SLOT_STEP_MIN = 30;
const MINUTOS_DIA = 24 * 60;
const DEFAULT_APERTURA = '10:00';
const DEFAULT_CIERRE = '23:00';

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

function franjaAplicaAFecha(f, fechaISO) {
  const tipo = String(f?.tipo || '').trim();
  if (tipo === 'fecha_especial') {
    return Boolean(fechaISO) && String(f?.fecha || '').slice(0, 10) === String(fechaISO || '').slice(0, 10);
  }
  const dias = Array.isArray(f?.dias) ? f.dias.map((d) => String(d).trim()) : [];
  if (!fechaISO || dias.length === 0) return true;
  const s = String(fechaISO || '').trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return true;
  const d = new Date(`${s}T12:00:00`);
  if (Number.isNaN(d.getTime())) return true;
  const dia = DIAS_SEMANA_FRANJA[d.getDay()] || null;
  return dia ? dias.includes(dia) : true;
}

export function sedeUsaFranjasHorarias(sede) {
  const franjas = sede?.franjas_horarias;
  if (!Array.isArray(franjas) || franjas.length === 0) return false;
  return franjas.some((f) => {
    const i = horaAMinutos(f?.hora_inicio);
    const fi = horaAMinutos(f?.hora_fin);
    const p = Number(f?.precio);
    return i != null && fi != null && Number.isFinite(p) && p >= 0;
  });
}

function ventanaDesdeFranja(f) {
  const startMin = horaAMinutos(f?.hora_inicio);
  const endMin = horaAMinutos(f?.hora_fin);
  if (startMin == null || endMin == null) return null;
  return { startMin, endMin, cruzaMedianoche: endMin <= startMin };
}

export function ventanasHorarioReserva(sede, fechaISO) {
  if (sedeUsaFranjasHorarias(sede)) {
    const franjas = sede.franjas_horarias;
    const ordenadas = [
      ...franjas.filter((f) => String(f?.tipo || '') === 'fecha_especial'),
      ...franjas.filter((f) => String(f?.tipo || '') !== 'fecha_especial'),
    ];
    const ventanas = [];
    for (const f of ordenadas) {
      if (!franjaAplicaAFecha(f, fechaISO)) continue;
      const v = ventanaDesdeFranja(f);
      if (v) ventanas.push(v);
    }
    if (ventanas.length) return ventanas;
  }

  const startMin = horaAMinutos(sede?.horario_apertura) ?? horaAMinutos(DEFAULT_APERTURA);
  let endMin = horaAMinutos(sede?.horario_cierre) ?? horaAMinutos(DEFAULT_CIERRE);
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

export function generarIniciosMinutosSlotReserva(sede, fechaISO, duracionMin, stepMin = RESERVA_SLOT_STEP_MIN) {
  const dur = parseInt(String(duracionMin), 10);
  if (!Number.isFinite(dur) || dur < 15) return [];
  const ventanas = ventanasHorarioReserva(sede, fechaISO);
  const inicios = new Set();
  for (const v of ventanas) {
    agregarIniciosEnVentana(inicios, v, dur, stepMin);
  }
  return [...inicios].sort((a, b) => a - b);
}

export function turnoCabeEnVentanasReserva(inicioMin, duracionMin, ventanas) {
  const start = Number(inicioMin);
  const dur = Number(duracionMin);
  if (!Number.isFinite(start) || !Number.isFinite(dur)) return false;
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
  const dur = parseInt(String(duracionMin), 10);
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
