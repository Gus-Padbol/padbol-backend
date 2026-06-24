/**
 * Conflictos horarios y vencimiento de solicitudes/invitaciones a partidos abiertos.
 */

import { intervalosSeSolapan } from './reservaSlotsHorarios.js';

export const SOLICITUD_ESTADOS = Object.freeze([
  'invitado',
  'pendiente',
  'aceptado',
  'rechazado',
  'expirado',
  'cancelado',
  'conflicto',
]);

export const SOLICITUD_ESTADOS_PENDIENTES = Object.freeze(['pendiente', 'invitado']);

export const PARTIDO_HORARIO_CONFLICTO_ESTADOS = Object.freeze([
  'abierto',
  'completo',
  'confirmado',
  'en_disputa',
]);

export const PARTIDO_DURACION_DEFAULT_MIN = 90;
export const SOLICITUD_EXPIRES_HOURS_DEFAULT = 4;
export const SOLICITUD_EXPIRES_HOURS_BEFORE_MATCH = 2;
export const SOLICITUD_EXPIRES_MINUTES_MIN_FROM_CREATED = 30;

export const PARTIDO_HORARIO_CONFLICTO_CODE = 'PARTIDO_HORARIO_CONFLICTO';
export const JUGADOR_HORARIO_CONFLICTO_CODE = 'JUGADOR_HORARIO_CONFLICTO';

export const SOLICITUD_ESTADO_VISIBLE_COPY = Object.freeze({
  pendiente: {
    estado_label: 'Solicitud pendiente',
    estado_mensaje: 'El capitán todavía no confirmó tu lugar.',
    estado_accion_sugerida: 'Esperá la respuesta del capitán.',
  },
  invitado: {
    estado_label: 'Invitación pendiente',
    estado_mensaje: 'Tenés una invitación para sumarte a este partido.',
    estado_accion_sugerida: 'Aceptá o decliná la invitación.',
  },
  aceptado: {
    estado_label: 'Confirmado',
    estado_mensaje: 'Tu lugar está confirmado.',
    estado_accion_sugerida: null,
  },
  rechazado: {
    estado_label: 'No se confirmó tu lugar',
    estado_mensaje: 'El capitán eligió completar el partido con otros jugadores. Te esperamos en otro partido.',
    estado_accion_sugerida: 'Buscá otro partido disponible.',
  },
  expirado: {
    estado_label: 'Invitación vencida',
    estado_mensaje: 'El plazo para confirmar esta invitación terminó.',
    estado_accion_sugerida: 'Buscá otro partido disponible.',
  },
  cancelado: {
    estado_label: 'Partido cancelado',
    estado_mensaje: 'Este partido fue cancelado.',
    estado_accion_sugerida: null,
  },
  conflicto: {
    estado_label: 'Conflicto de horario',
    estado_mensaje: 'Ya tenés otro partido confirmado en ese horario.',
    estado_accion_sugerida: 'Revisá tus partidos confirmados.',
  },
});

const MS_HOUR = 60 * 60 * 1000;
const ARG_TZ_OFFSET = '-03:00';

function horaToHHMM(hora) {
  const s = String(hora ?? '').trim();
  const m = /^(\d{1,2}):(\d{2})/.exec(s);
  if (!m) return null;
  return `${String(parseInt(m[1], 10)).padStart(2, '0')}:${m[2]}`;
}

export function partidoDuracionMinutos(partido, reserva = null) {
  const fromPartido = parseInt(String(partido?.duracion_minutos ?? ''), 10);
  if (Number.isFinite(fromPartido) && fromPartido >= 15) return fromPartido;
  const fromReserva = parseInt(String(reserva?.duracion_minutos ?? ''), 10);
  if (Number.isFinite(fromReserva) && fromReserva >= 15) return fromReserva;
  return PARTIDO_DURACION_DEFAULT_MIN;
}

export function partidoRangoMs(partido, reserva = null) {
  const fecha = String(partido?.fecha ?? '').trim();
  const hora = horaToHHMM(partido?.hora);
  if (!fecha || !hora) return null;

  const startMs = new Date(`${fecha}T${hora}:00${ARG_TZ_OFFSET}`).getTime();
  if (Number.isNaN(startMs)) return null;

  const durMin = partidoDuracionMinutos(partido, reserva);
  return { startMs, endMs: startMs + durMin * 60 * 1000 };
}

export function partidosSeSolapan(partidoA, partidoB, reservaA = null, reservaB = null) {
  const a = partidoRangoMs(partidoA, reservaA);
  const b = partidoRangoMs(partidoB, reservaB);
  if (!a || !b) return false;
  return intervalosSeSolapan(a.startMs, a.endMs, b.startMs, b.endMs);
}

export function computeSolicitudExpiresAt(createdAt, partido, reserva = null) {
  const createdMs = new Date(createdAt).getTime();
  if (Number.isNaN(createdMs)) return null;

  const defaultExpiryMs = createdMs + SOLICITUD_EXPIRES_HOURS_DEFAULT * MS_HOUR;
  const rango = partidoRangoMs(partido, reserva);
  if (!rango) {
    return new Date(defaultExpiryMs).toISOString();
  }

  if (rango.startMs < defaultExpiryMs) {
    const beforeMatchMs = rango.startMs - SOLICITUD_EXPIRES_HOURS_BEFORE_MATCH * MS_HOUR;
    const minFromCreatedMs = createdMs + SOLICITUD_EXPIRES_MINUTES_MIN_FROM_CREATED * 60 * 1000;
    const capped = Math.min(defaultExpiryMs, Math.max(minFromCreatedMs, beforeMatchMs));
    return new Date(capped).toISOString();
  }

  return new Date(defaultExpiryMs).toISOString();
}

export function mapSolicitudEstadoVisible(solicitud, partido, reserva = null, nowMs = Date.now()) {
  if (!solicitud) return null;
  if (SOLICITUD_ESTADOS_PENDIENTES.includes(String(solicitud.estado ?? ''))
    && isSolicitudExpirada(solicitud, partido, nowMs, reserva)) {
    return 'expirado';
  }
  return solicitud.estado;
}

export function resolveSolicitudEstadoVisibleCopy(estadoVisible) {
  const key = String(estadoVisible ?? '').trim().toLowerCase();
  const copy = SOLICITUD_ESTADO_VISIBLE_COPY[key];
  if (copy) {
    return {
      estado_label: copy.estado_label,
      estado_mensaje: copy.estado_mensaje,
      estado_accion_sugerida: copy.estado_accion_sugerida ?? null,
    };
  }
  return {
    estado_label: estadoVisible ?? null,
    estado_mensaje: null,
    estado_accion_sugerida: null,
  };
}

export function buildMiSolicitudApiFields(
  solicitud,
  partido,
  reserva = null,
  nowMs = Date.now(),
) {
  if (!solicitud) {
    return {
      solicitud_id: null,
      estado: null,
      estado_label: null,
      estado_mensaje: null,
      estado_accion_sugerida: null,
      expires_at: null,
    };
  }

  const estado = partido
    ? mapSolicitudEstadoVisible(solicitud, partido, reserva, nowMs)
    : solicitud.estado ?? null;
  const copy = resolveSolicitudEstadoVisibleCopy(estado);

  return {
    solicitud_id: solicitud.id,
    estado,
    ...copy,
    expires_at: solicitud.expires_at ?? (partido
      ? resolveSolicitudExpiresAt(solicitud, partido, reserva)
      : null),
  };
}

export function buildInvitacionPartidoRow({
  partidoId,
  invitadoId,
  partido,
  reserva = null,
  nowMs = Date.now(),
}) {
  const createdAt = new Date(nowMs).toISOString();
  return {
    partido_id: partidoId,
    solicitante_id: invitadoId,
    estado: 'invitado',
    created_at: createdAt,
    expires_at: computeSolicitudExpiresAt(createdAt, partido, reserva),
  };
}

export function countCuposReservadosSolicitudesActivas(
  solicitudes,
  partido,
  reserva = null,
  nowMs = Date.now(),
) {
  return (solicitudes ?? []).filter(
    (solicitud) => isSolicitudPendienteActiva(solicitud, partido, nowMs, reserva),
  ).length;
}

export function computeLugaresDisponiblesPartido({
  maxJugadores,
  jugadoresConfirmados,
  solicitudes = [],
  partido,
  reserva = null,
  nowMs = Date.now(),
}) {
  const cuposReservados = countCuposReservadosSolicitudesActivas(
    solicitudes,
    partido,
    reserva,
    nowMs,
  );
  return Math.max(0, maxJugadores - jugadoresConfirmados - cuposReservados);
}

export function mapSolicitudPartidoApiItem(
  solicitud,
  partido,
  perfil = null,
  reserva = null,
  nowMs = Date.now(),
) {
  const estadoVisible = mapSolicitudEstadoVisible(solicitud, partido, reserva, nowMs);
  const expiresAt = resolveSolicitudExpiresAt(solicitud, partido, reserva);
  const tipo = String(solicitud?.estado ?? '') === 'invitado' ? 'invitacion' : 'solicitud';
  const visibleCopy = resolveSolicitudEstadoVisibleCopy(estadoVisible);

  return {
    id: solicitud.id,
    solicitud_id: solicitud.id,
    solicitante_id: solicitud.solicitante_id,
    invitado_id: solicitud.solicitante_id,
    user_id: solicitud.solicitante_id,
    estado: estadoVisible,
    estado_raw: solicitud.estado,
    tipo,
    etiqueta: visibleCopy.estado_label,
    estado_label: visibleCopy.estado_label,
    estado_mensaje: visibleCopy.estado_mensaje,
    estado_accion_sugerida: visibleCopy.estado_accion_sugerida,
    activa: estadoVisible === 'pendiente' || estadoVisible === 'invitado',
    created_at: solicitud.created_at,
    expires_at: expiresAt,
    nombre: perfil?.nombre_saludo
      ?? perfil?.apodo
      ?? perfil?.nombre
      ?? 'Jugador',
    username: perfil?.username ?? null,
    apodo: perfil?.apodo ?? null,
    nombre_saludo: perfil?.nombre_saludo ?? null,
    foto_url: perfil?.foto_url ?? null,
    nivel: perfil?.nivel ?? 'Intermedio',
  };
}

export function partitionSolicitudesPartidoApiItems(items) {
  const all = items ?? [];
  return {
    invitaciones: all.filter((row) => row.tipo === 'invitacion'),
    invitaciones_activas: all.filter((row) => row.tipo === 'invitacion' && row.activa),
    solicitudes: all.filter((row) => row.tipo === 'solicitud'),
    solicitudes_activas: all.filter((row) => row.tipo === 'solicitud' && row.activa),
    activas: all.filter((row) => row.activa),
  };
}

export function formatInvitacionExpiresLabel(expiresAt) {
  if (!expiresAt) return null;
  const date = new Date(expiresAt);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleString('es-AR', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function resolveSolicitudExpiresAt(solicitud, partido, reserva = null) {
  if (solicitud?.expires_at) {
    return solicitud.expires_at;
  }
  return computeSolicitudExpiresAt(solicitud?.created_at ?? new Date().toISOString(), partido, reserva);
}

export function isSolicitudExpirada(solicitud, partido, nowMs = Date.now(), reserva = null) {
  if (!SOLICITUD_ESTADOS_PENDIENTES.includes(String(solicitud?.estado ?? ''))) {
    return false;
  }
  const expiresAt = resolveSolicitudExpiresAt(solicitud, partido, reserva);
  if (!expiresAt) return false;
  const expiresMs = new Date(expiresAt).getTime();
  return Number.isFinite(expiresMs) && expiresMs <= nowMs;
}

export function isSolicitudPendienteActiva(solicitud, partido, nowMs = Date.now(), reserva = null) {
  if (!SOLICITUD_ESTADOS_PENDIENTES.includes(String(solicitud?.estado ?? ''))) {
    return false;
  }
  return !isSolicitudExpirada(solicitud, partido, nowMs, reserva);
}

export function findPartidoConHorarioSuperpuesto(
  partidos,
  targetPartido,
  { excludePartidoId = null, reservasById = {} } = {},
) {
  for (const partido of partidos ?? []) {
    if (excludePartidoId != null && Number(partido.id) === Number(excludePartidoId)) {
      continue;
    }
    if (!PARTIDO_HORARIO_CONFLICTO_ESTADOS.includes(String(partido?.estado ?? ''))) {
      continue;
    }
    const reservaA = partido.reserva_id ? reservasById[partido.reserva_id] : null;
    const reservaB = targetPartido.reserva_id ? reservasById[targetPartido.reserva_id] : null;
    if (partidosSeSolapan(partido, targetPartido, reservaA, reservaB)) {
      return partido;
    }
  }
  return null;
}

export function solicitudesSuperpuestasParaMarcarConflicto(
  solicitudesConPartido,
  acceptedPartido,
  { excludeSolicitudId = null, nowMs = Date.now(), reservasById = {} } = {},
) {
  const reservaAccepted = acceptedPartido.reserva_id
    ? reservasById[acceptedPartido.reserva_id]
    : null;
  const out = [];

  for (const row of solicitudesConPartido ?? []) {
    const { solicitud, partido } = row;
    if (!solicitud || !partido) continue;
    if (excludeSolicitudId != null && String(solicitud.id) === String(excludeSolicitudId)) {
      continue;
    }
    if (!isSolicitudPendienteActiva(solicitud, partido, nowMs, reservaAccepted)) {
      continue;
    }
    const reservaOtra = partido.reserva_id ? reservasById[partido.reserva_id] : null;
    if (partidosSeSolapan(partido, acceptedPartido, reservaOtra, reservaAccepted)) {
      out.push(solicitud);
    }
  }

  return out;
}

export function buildPartidoHorarioConflictoBody() {
  return {
    error: 'Ya tenés un partido confirmado en ese horario.',
    code: PARTIDO_HORARIO_CONFLICTO_CODE,
  };
}

export function buildJugadorHorarioConflictoBody() {
  return {
    error: 'El jugador ya tiene un partido confirmado en ese horario.',
    code: JUGADOR_HORARIO_CONFLICTO_CODE,
  };
}

export async function fetchReservasDuracionByIds(supabaseAdmin, reservaIds) {
  const ids = [...new Set((reservaIds ?? []).filter(Boolean))];
  if (!ids.length) return {};

  const { data, error } = await supabaseAdmin
    .from('reservas')
    .select('id, duracion_minutos')
    .in('id', ids);

  if (error) throw error;

  const map = {};
  for (const row of data ?? []) {
    if (row?.id != null) map[row.id] = row;
  }
  return map;
}

export async function fetchPartidosConfirmadosUsuario(
  supabaseAdmin,
  userId,
  { excludePartidoId = null } = {},
) {
  if (!userId) return [];

  const { data: joins, error: joinErr } = await supabaseAdmin
    .from('partidos_abiertos_jugadores')
    .select('partido_id')
    .eq('user_id', userId);

  if (joinErr) throw joinErr;

  const partidoIds = [...new Set((joins ?? []).map((row) => row.partido_id).filter(Boolean))]
    .filter((id) => excludePartidoId == null || Number(id) !== Number(excludePartidoId));

  if (!partidoIds.length) return [];

  const { data: partidos, error: partidosErr } = await supabaseAdmin
    .from('partidos_abiertos')
    .select('id, fecha, hora, duracion_minutos, estado, reserva_id')
    .in('id', partidoIds)
    .in('estado', [...PARTIDO_HORARIO_CONFLICTO_ESTADOS]);

  if (partidosErr) throw partidosErr;
  return partidos ?? [];
}

export async function findConflictoHorarioJugador(
  supabaseAdmin,
  userId,
  targetPartido,
  { excludePartidoId = null } = {},
) {
  const partidos = await fetchPartidosConfirmadosUsuario(supabaseAdmin, userId, { excludePartidoId });
  const reservaIds = [
    ...partidos.map((p) => p.reserva_id),
    targetPartido?.reserva_id,
  ].filter(Boolean);
  const reservasById = await fetchReservasDuracionByIds(supabaseAdmin, reservaIds);
  return findPartidoConHorarioSuperpuesto(partidos, targetPartido, {
    excludePartidoId: excludePartidoId ?? targetPartido?.id,
    reservasById,
  });
}

export async function expireSolicitudesVencidas(
  supabaseAdmin,
  solicitudes,
  partidoById,
  { reservasById = {}, nowMs = Date.now() } = {},
) {
  const toExpire = [];

  for (const solicitud of solicitudes ?? []) {
    if (!SOLICITUD_ESTADOS_PENDIENTES.includes(String(solicitud.estado ?? ''))) {
      continue;
    }
    const partido = partidoById[solicitud.partido_id];
    if (!partido) continue;
    const reserva = partido.reserva_id ? reservasById[partido.reserva_id] : null;
    if (isSolicitudExpirada(solicitud, partido, nowMs, reserva)) {
      toExpire.push(solicitud.id);
    }
  }

  if (!toExpire.length) return 0;

  const { error } = await supabaseAdmin
    .from('solicitudes_partido')
    .update({ estado: 'expirado' })
    .in('id', toExpire)
    .in('estado', [...SOLICITUD_ESTADOS_PENDIENTES]);

  if (error) throw error;
  return toExpire.length;
}

export async function marcarSolicitudesSuperpuestasEnConflicto(
  supabaseAdmin,
  userId,
  acceptedPartido,
  { excludeSolicitudId = null, nowMs = Date.now() } = {},
) {
  const { data: solicitudes, error: solErr } = await supabaseAdmin
    .from('solicitudes_partido')
    .select('id, partido_id, solicitante_id, estado, created_at, expires_at')
    .eq('solicitante_id', userId)
    .in('estado', [...SOLICITUD_ESTADOS_PENDIENTES]);

  if (solErr) throw solErr;
  if (!solicitudes?.length) return 0;

  const partidoIds = [...new Set(solicitudes.map((s) => s.partido_id).filter(Boolean))];
  const { data: partidos, error: partidosErr } = await supabaseAdmin
    .from('partidos_abiertos')
    .select('id, fecha, hora, duracion_minutos, estado, reserva_id')
    .in('id', partidoIds);

  if (partidosErr) throw partidosErr;

  const partidoById = Object.fromEntries((partidos ?? []).map((p) => [p.id, p]));
  const reservasById = await fetchReservasDuracionByIds(
    supabaseAdmin,
    (partidos ?? []).map((p) => p.reserva_id).filter(Boolean),
  );

  const rows = solicitudes.map((solicitud) => ({
    solicitud,
    partido: partidoById[solicitud.partido_id],
  }));

  const conflictIds = solicitudesSuperpuestasParaMarcarConflicto(
    rows,
    acceptedPartido,
    { excludeSolicitudId, nowMs, reservasById },
  ).map((s) => s.id);

  if (!conflictIds.length) return 0;

  const { error } = await supabaseAdmin
    .from('solicitudes_partido')
    .update({ estado: 'conflicto' })
    .in('id', conflictIds)
    .in('estado', [...SOLICITUD_ESTADOS_PENDIENTES]);

  if (error) throw error;
  return conflictIds.length;
}

export async function expireSolicitudesPartidoPendientes(
  supabaseAdmin,
  { partidoIds = null, solicitanteId = null, nowMs = Date.now() } = {},
) {
  let query = supabaseAdmin
    .from('solicitudes_partido')
    .select('id, partido_id, solicitante_id, estado, created_at, expires_at')
    .in('estado', [...SOLICITUD_ESTADOS_PENDIENTES]);

  if (partidoIds?.length) {
    query = query.in('partido_id', partidoIds);
  }
  if (solicitanteId) {
    query = query.eq('solicitante_id', solicitanteId);
  }

  const { data: solicitudes, error } = await query;
  if (error) throw error;
  if (!solicitudes?.length) return 0;

  const ids = [...new Set(solicitudes.map((s) => s.partido_id).filter(Boolean))];
  const { data: partidos, error: partidosErr } = await supabaseAdmin
    .from('partidos_abiertos')
    .select('id, fecha, hora, duracion_minutos, reserva_id')
    .in('id', ids);

  if (partidosErr) throw partidosErr;

  const partidoById = Object.fromEntries((partidos ?? []).map((p) => [p.id, p]));
  const reservasById = await fetchReservasDuracionByIds(
    supabaseAdmin,
    (partidos ?? []).map((p) => p.reserva_id).filter(Boolean),
  );

  return expireSolicitudesVencidas(supabaseAdmin, solicitudes, partidoById, {
    reservasById,
    nowMs,
  });
}

export function solicitudExpiresAtForInsert(partido, reserva = null, nowMs = Date.now()) {
  return computeSolicitudExpiresAt(new Date(nowMs).toISOString(), partido, reserva);
}

export async function fetchSolicitudesPartidoRows(supabaseAdmin, partidoId) {
  const { data, error } = await supabaseAdmin
    .from('solicitudes_partido')
    .select('id, partido_id, solicitante_id, estado, created_at, expires_at')
    .eq('partido_id', partidoId)
    .order('created_at', { ascending: true });

  if (error) throw error;
  return data ?? [];
}

export async function cancelarSolicitudesPendientesDePartido(supabaseAdmin, partidoId) {
  const { error } = await supabaseAdmin
    .from('solicitudes_partido')
    .update({ estado: 'cancelado' })
    .eq('partido_id', partidoId)
    .in('estado', [...SOLICITUD_ESTADOS_PENDIENTES]);

  if (error) throw error;
}
