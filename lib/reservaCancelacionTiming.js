import { DateTime } from 'luxon';
import { reservaHoraInicioFromRow } from '../utils/reservasColumns.js';

/** Compare absolute instants; formatting Buenos Aires time must not shift `now`. */
export function horasAnticipacionReserva(reserva, { nowMs = Date.now(), timezone = 'America/Argentina/Buenos_Aires' } = {}) {
  const fecha = String(reserva?.fecha ?? '').slice(0, 10);
  const hora = reservaHoraInicioFromRow(reserva);
  const slot = DateTime.fromISO(`${fecha}T${hora}`, { zone: timezone || 'America/Argentina/Buenos_Aires' });
  if (!slot.isValid || !Number.isFinite(nowMs)) throw Object.assign(new Error('Fecha u horario de reserva inválidos'), { status: 400 });
  return (slot.toMillis() - nowMs) / 3600000;
}
