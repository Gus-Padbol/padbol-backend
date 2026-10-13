import { DateTime } from 'luxon';
import { ensureReservaPendienteParaMpPg, normalizeCrearPreferenciaReservaInput } from '../routes/reservaPendienteMp.js';
import { resolvePartidoCourtContract } from './partidoSportFormat.js';
import { isCourtBlocked, BLOCKING_RESERVA_ESTADOS, classifyReservaWriteError } from '../routes/partidos.js';
import { assertJugadorNoSuspendidoPg } from '../routes/reputacion.js';
import { reservaSolapaSlot, generarIniciosMinutosSlotReserva, horaAMinutos } from './reservaSlotsHorarios.js';

/** Server-quoted zero price is a booking, not a payment-provider checkout. */
export async function confirmReservaGratuita({ db, pgPool, body, user, quote }) {
  if (!user?.id || !user.email) throw Object.assign(new Error('Se requiere sesión'), { status: 401 });
  if (![quote?.total, quote?.base, quote?.extrasSubtotal, quote?.fee].every(value => typeof value === 'number' && Number.isFinite(value) && value === 0) || !Number.isFinite(quote?.surge?.precio) || quote.surge.precio < 0) {
    throw Object.assign(new Error('La reserva no tiene precio cero en el servidor'), { status: 400 });
  }
  const input = normalizeCrearPreferenciaReservaInput(body);
  if (input.reserva_id) throw Object.assign(new Error('La confirmación gratuita requiere una reserva nueva'), { status: 400 });
  const { data: sede, error } = await db.from('sedes').select('id,nombre,horario_apertura,horario_cierre,timezone').eq('id', input.sede_id).maybeSingle();
  if (error) throw error;
  if (!sede) throw Object.assign(new Error('Sede no encontrada'), { status: 404 });
  const court = await resolvePartidoCourtContract(db, {
    sede, body: { ...input, cancha_id: undefined }, legacyCourtNumber: String(input.cancha ?? input.cancha_id ?? ''),
  });
  const duration = input.duracion_minutos ?? 90;
  const slot = DateTime.fromISO(`${input.fecha}T${input.hora}`, { zone: sede.timezone || 'America/Argentina/Buenos_Aires' });
  if (!slot.isValid || slot.toFormat('yyyy-MM-dd') !== input.fecha || slot.toMillis() <= Date.now()) {
    throw Object.assign(new Error('Elegí una fecha y hora válidas que todavía no hayan pasado'), { status: 400 });
  }
  if (quote.pricing_snapshot?.duracion_minutos !== duration || quote.pricing_snapshot?.deporte !== court.deporte) {
    throw Object.assign(new Error('La cotización no coincide con la cancha o duración solicitada'), { status: 400 });
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.fecha) || !generarIniciosMinutosSlotReserva(sede, input.fecha, duration).includes(horaAMinutos(input.hora))) {
    throw Object.assign(new Error('Fecha u horario fuera de los turnos de la sede'), { status: 400 });
  }
  const canonicalBody = { reservaData: {
    ...input, sede: sede.nombre, sede_id: sede.id, cancha: court.numero, cancha_id: court.numero,
    email: String(user.email).trim().toLowerCase(), user_id: user.id, precio: 0,
    duracion_minutos: duration, hora_fin: null,
  } };
  const client = await pgPool.connect();
  try {
    await client.query('BEGIN');
    const suspension = await assertJugadorNoSuspendidoPg(client, user.id);
    if (suspension.suspendido) throw Object.assign(new Error('Tenés una suspensión activa y no podés reservar'), { status: 403 });
    // The database trigger serializes ALL writers and rechecks on INSERT.
    // Do not acquire its advisory lock here: Nations court-row locks come first.
    const { rows } = await client.query(
      'SELECT hora,hora_inicio,hora_fin,duracion_minutos FROM reservas WHERE sede_id=$1 AND fecha=$2 AND cancha=$3 AND estado=ANY($4::text[])',
      [sede.id, input.fecha, String(court.numero), BLOCKING_RESERVA_ESTADOS],
    );
    const blocked = rows.some(row => reservaSolapaSlot(row, input.hora, duration)) || await isCourtBlocked(db, {
      sedeNombre: sede.nombre, sedeId: sede.id, fecha: input.fecha, hora: input.hora, cancha: String(court.numero), duracionMinutos: duration,
    });
    if (blocked) throw Object.assign(new Error('Este horario ya está reservado'), { status: 409 });
    const pending = await ensureReservaPendienteParaMpPg(client, canonicalBody, { authUser: user, quote });
    const { rows: confirmed } = await client.query(
      `UPDATE reservas SET estado='confirmada',pago_estado='no_aplica',monto_pagado=0,payment_provider=NULL,cancha_id=$3
       WHERE id=$1 AND user_id=$2 AND precio=0 AND precio_esperado=0 AND estado='pendiente'
       RETURNING id,estado,pago_estado,precio,moneda`, [pending.reserva_id, user.id, court.canchaId],
    );
    if (!confirmed[0]) throw new Error('No se pudo confirmar la reserva gratuita');
    await client.query('COMMIT');
    return { free_booking: true, reserva_id: pending.reserva_id, reserva: confirmed[0] };
  } catch (err) {
    await client.query('ROLLBACK');
    const classified = classifyReservaWriteError(err);
    if (classified) throw Object.assign(new Error(classified.error), { status: classified.status });
    throw err;
  } finally { client.release(); }
}
