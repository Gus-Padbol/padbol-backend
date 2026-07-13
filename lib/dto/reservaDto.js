import { reservaHoraFinFromRow, reservaHoraInicioFromRow } from '../../utils/reservasColumns.js';

/** Columnas que nunca deben aparecer en respuestas HTTP de reservas. */
export const RESERVA_SENSITIVE_RESPONSE_KEYS = new Set([
  'mp_payment_id',
  'mp_preference_id',
  'stripe_checkout_session_id',
  'stripe_payment_intent_id',
  'pricing_snapshot',
  'payment_provider',
  'internal_metadata',
  'metadata',
]);

/** Select para dueño / listado jugador (sin columnas de pago internas). */
export const RESERVA_OWNER_SELECT = [
  'id',
  'sede',
  'sede_id',
  'fecha',
  'hora',
  'hora_inicio',
  'hora_fin',
  'duracion_minutos',
  'cancha',
  'estado',
  'pago_estado',
  'precio',
  'precio_esperado',
  'monto_pagado',
  'moneda',
  'nombre',
  'nivel',
  'checkin_realizado',
  'checkin_at',
  'qr_token',
  'created_at',
  // reservas no tiene updated_at en producción; pedirlo rompe insert/select (42703 → 500).
].join(', ');

/** Select operativo admin (contacto + estado; sin ids de pago ni snapshots). */
export const RESERVA_ADMIN_SELECT = [
  ...RESERVA_OWNER_SELECT.split(', '),
  'email',
  'telefono',
  'whatsapp',
  'user_id',
].join(', ');

function resolveSedeNombre(row) {
  return row?.sedes?.nombre ?? row?.sede_nombre ?? row?.sede ?? null;
}

function buildReservaTimeFields(row) {
  const horaInicio = reservaHoraInicioFromRow(row);
  const horaFin = reservaHoraFinFromRow(row, row?.duracion_minutos);
  return {
    hora: row?.hora ?? horaInicio,
    hora_inicio: horaInicio,
    hora_fin: horaFin,
  };
}

/**
 * @param {'list'|'mis_reservas'|'detail'|'create'|'admin_list'|'admin_detail'} context
 */
export function mapReservaDto(row, context = 'list') {
  if (!row) return null;

  const times = buildReservaTimeFields(row);
  const sedeNombre = resolveSedeNombre(row);

  const base = {
    id: row.id,
    sede: sedeNombre,
    sede_nombre: sedeNombre,
    sede_id: row.sede_id ?? null,
    fecha: row.fecha,
    ...times,
    duracion_minutos: row.duracion_minutos ?? null,
    cancha: row.cancha ?? null,
    estado: row.estado ?? null,
    pago_estado: row.pago_estado ?? null,
    precio: row.precio ?? null,
    moneda: row.moneda ?? 'ARS',
    nombre: row.nombre ?? null,
    nivel: row.nivel ?? null,
    created_at: row.created_at ?? null,
  };

  const ownerDetailContexts = new Set(['mis_reservas', 'detail', 'create']);
  if (ownerDetailContexts.has(context)) {
    base.monto_pagado = row.monto_pagado ?? null;
    base.checkin_realizado = row.checkin_realizado ?? false;
    base.qr_token = row.qr_token ?? null;
  }

  if (context === 'list') {
    base.monto_pagado = row.monto_pagado ?? null;
    base.checkin_realizado = row.checkin_realizado ?? false;
  }

  const adminContexts = new Set(['admin_list', 'admin_detail']);
  if (adminContexts.has(context)) {
    base.email = row.email ?? null;
    base.telefono = row.telefono ?? row.whatsapp ?? null;
    base.whatsapp = row.whatsapp ?? row.telefono ?? null;
    base.precio_esperado = row.precio_esperado ?? null;
    base.monto_pagado = row.monto_pagado ?? null;
    base.checkin_realizado = row.checkin_realizado ?? false;
    base.checkin_at = row.checkin_at ?? null;
    base.user_id = row.user_id ?? null;
    base.updated_at = row.updated_at ?? row.created_at ?? null;
  }

  for (const key of RESERVA_SENSITIVE_RESPONSE_KEYS) {
    delete base[key];
  }

  return base;
}

/** Compat: mis-reservas / POST reserva (dueño). */
export function mapMisReservaRow(row) {
  return mapReservaDto(row, 'mis_reservas');
}

export function mapReservaListDto(row, { isAdmin = false } = {}) {
  return mapReservaDto(row, isAdmin ? 'admin_list' : 'list');
}

export function mapReservaDetailDto(row, { isAdmin = false } = {}) {
  return mapReservaDto(row, isAdmin ? 'admin_detail' : 'detail');
}

/** Respuesta mínima de poll pago exitoso (sin ids internos de MP/Stripe). */
export function mapPagoExitosoPollDto({
  reserva,
  reservaId,
  confirmed,
  message,
  provider = null,
  paymentStatus = null,
}) {
  const dto = {
    ok: true,
    read_only: true,
    confirmed: Boolean(confirmed),
    reserva_id: reservaId ?? reserva?.id ?? null,
    estado: reserva?.estado ?? null,
    pago_estado: reserva?.pago_estado ?? null,
    payment_status: paymentStatus ?? null,
    message: message ?? null,
  };
  if (provider) dto.provider = provider;
  return dto;
}
