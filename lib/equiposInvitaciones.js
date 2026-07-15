/**
 * Dominio de invitaciones/solicitudes de equipos_usuario (torneos).
 * Reutiliza equipos_jugadores; no toca partidos abiertos.
 */

export const EQUIPO_MEMBER_ESTADOS = Object.freeze([
  'pendiente',
  'aceptado',
  'rechazado',
  'cancelado',
  'vencido',
]);

export const EQUIPO_MEMBER_TIPOS = Object.freeze(['invitacion', 'solicitud']);

export const EQUIPO_VISIBILIDADES = Object.freeze(['abierto', 'cerrado']);

export const EQUIPO_INVITE_EXPIRES_HOURS_DEFAULT = 72;

export const DEPORTE_LIMITS = Object.freeze({
  padbol: { min: 2, max: 4, label: 'Padbol' },
  padel: { min: 4, max: 4, label: 'Pádel' },
  pickleball: { min: 2, max: 4, label: 'Pickleball' },
  futbol_5: { min: 5, max: 13, label: 'Fútbol 5' },
  futbol_7: { min: 7, max: 17, label: 'Fútbol 7' },
});

export function normalizeEmail(email) {
  return String(email ?? '').trim().toLowerCase();
}

export function parseEquipoId(id) {
  const equipoId = parseInt(id, 10);
  return Number.isNaN(equipoId) ? null : equipoId;
}

export function normalizeVisibilidad(raw, fallback = 'cerrado') {
  const v = String(raw ?? '').trim().toLowerCase();
  return EQUIPO_VISIBILIDADES.includes(v) ? v : fallback;
}

export function isMemberPending(member, now = new Date()) {
  if (!member || member.estado !== 'pendiente') return false;
  if (member.expires_at) {
    const exp = new Date(member.expires_at).getTime();
    if (Number.isFinite(exp) && exp <= now.getTime()) return false;
  }
  return true;
}

export function isMemberExpired(member, now = new Date()) {
  if (!member || member.estado !== 'pendiente') return false;
  if (!member.expires_at) return false;
  const exp = new Date(member.expires_at).getTime();
  return Number.isFinite(exp) && exp <= now.getTime();
}

export function computeInviteExpiresAt(from = new Date(), hours = EQUIPO_INVITE_EXPIRES_HOURS_DEFAULT) {
  return new Date(from.getTime() + hours * 60 * 60 * 1000).toISOString();
}

export function countAcceptedMembers(members = []) {
  return members.filter((m) => m.estado === 'aceptado').length;
}

export function countActivePendingMembers(members = [], now = new Date()) {
  return members.filter((m) => isMemberPending(m, now)).length;
}

export function findMembership(members, user) {
  if (!user) return null;
  const email = normalizeEmail(user.email);
  return members.find(
    (member) =>
      (member.user_id && member.user_id === user.id)
      || (email && normalizeEmail(member.email) === email),
  ) ?? null;
}

export function canCaptainInvite(equipo, user) {
  return Boolean(user && equipo && equipo.capitan_user_id === user.id);
}

export function assertCanInviteSelf({ captainUserId, inviteeUserId, inviteeEmail, captainEmail }) {
  if (inviteeUserId && captainUserId && String(inviteeUserId) === String(captainUserId)) {
    const err = new Error('No podés invitarte a vos mismo');
    err.status = 400;
    return err;
  }
  if (
    inviteeEmail
    && captainEmail
    && normalizeEmail(inviteeEmail) === normalizeEmail(captainEmail)
  ) {
    const err = new Error('No podés invitarte a vos mismo');
    err.status = 400;
    return err;
  }
  return null;
}

export function evaluateInviteSlot({ members, maxJugadores, adding = 1, now = new Date() }) {
  const accepted = countAcceptedMembers(members);
  const pending = countActivePendingMembers(members, now);
  if (accepted + pending + adding > maxJugadores) {
    const err = new Error('Supera el máximo de jugadores del equipo');
    err.status = 409;
    return err;
  }
  return null;
}

export function evaluateAcceptCupo({ members, maxJugadores, membershipId }) {
  const accepted = members.filter(
    (m) => m.estado === 'aceptado' && Number(m.id) !== Number(membershipId),
  ).length;
  if (accepted >= maxJugadores) {
    const err = new Error('El equipo ya está completo');
    err.status = 409;
    return err;
  }
  return null;
}

/**
 * Filas pendientes incompatibles: mismo jugador en otro equipo del mismo torneo.
 */
export function findIncompatiblePendingMemberships({
  allMemberships,
  acceptedUserId,
  acceptedEmail,
  torneoId,
  currentEquipoId,
}) {
  if (torneoId == null) return [];
  const email = normalizeEmail(acceptedEmail);
  return (allMemberships ?? []).filter((row) => {
    if (Number(row.equipo_id) === Number(currentEquipoId)) return false;
    if (Number(row.torneo_id) !== Number(torneoId)) return false;
    if (row.estado !== 'pendiente') return false;
    const sameUser = acceptedUserId && row.user_id && String(row.user_id) === String(acceptedUserId);
    const sameEmail = email && normalizeEmail(row.email) === email;
    return Boolean(sameUser || sameEmail);
  });
}

export function findConflictingAcceptedTeam({
  acceptedInOtherTeams,
  userId,
  email,
  torneoId,
  currentEquipoId,
}) {
  if (torneoId == null) return null;
  const needle = normalizeEmail(email);
  return (acceptedInOtherTeams ?? []).find((row) => {
    if (Number(row.equipo_id) === Number(currentEquipoId)) return false;
    if (Number(row.torneo_id) !== Number(torneoId)) return false;
    if (row.estado !== 'aceptado') return false;
    const sameUser = userId && row.user_id && String(row.user_id) === String(userId);
    const sameEmail = needle && normalizeEmail(row.email) === needle;
    return Boolean(sameUser || sameEmail);
  }) ?? null;
}

export function isTorneoOpenForTeams(torneo) {
  if (!torneo) return false;
  const estado = String(torneo.estado ?? '').trim().toLowerCase();
  const closed = new Set(['finalizado', 'cancelado', 'cerrado', 'archivado']);
  if (closed.has(estado)) return false;
  // abiertos típicos
  if (!estado || ['abierto', 'inscripcion', 'inscripciones', 'activo', 'publicado'].includes(estado)) {
    return true;
  }
  // estados desconocidos: permitir solo si no parece cerrado
  return !closed.has(estado);
}

export function buildEquipoDefinitivoDto({
  summary,
  members,
  viewer,
  now = new Date(),
}) {
  const confirmados = members.filter((m) => m.estado === 'aceptado');
  const invitacionesPendientes = members.filter(
    (m) => (m.tipo ?? 'invitacion') === 'invitacion' && isMemberPending(m, now),
  );
  const solicitudesPendientes = members.filter(
    (m) => m.tipo === 'solicitud' && isMemberPending(m, now),
  );
  const max = Number(summary.max_jugadores ?? 0);
  const cupos = Math.max(0, max - confirmados.length);
  const completo = confirmados.length >= Number(summary.min_jugadores ?? 0);
  const esCapitan = Boolean(viewer && summary.capitan_user_id === viewer.id);
  const visibilidad = normalizeVisibilidad(summary.visibilidad, 'cerrado');
  const inscrito = Boolean(summary.torneo_id) || summary.estado === 'inscripto';

  return {
    ...summary,
    visibilidad,
    integrantes_confirmados: confirmados.length,
    invitaciones_pendientes_count: invitacionesPendientes.length,
    solicitudes_pendientes_count: solicitudesPendientes.length,
    cupos_disponibles: cupos,
    equipo_completo: completo,
    puede_invitar: esCapitan && !inscrito && cupos > 0,
    puede_solicitar: !esCapitan
      && visibilidad === 'abierto'
      && !inscrito
      && cupos > 0
      && !findMembership(members, viewer),
    invitaciones_pendientes: invitacionesPendientes,
    solicitudes_pendientes: solicitudesPendientes,
  };
}

export function buildEquipoNotificacionDedupeKey(event, { equipoId, memberId, userId }) {
  return `equipo:${event}:e${equipoId}:m${memberId ?? 'x'}:u${userId ?? 'x'}`;
}

export function mapBuscarJugadorPublico(row) {
  if (!row) return null;
  const nombre = String(row.nombre ?? '').trim();
  const apellido = String(row.apellido ?? '').trim();
  const aliasRaw = String(row.apodo ?? row.username ?? row.alias ?? '').trim();
  const alias = aliasRaw
    ? (aliasRaw.startsWith('@') ? aliasRaw : `@${aliasRaw}`)
    : null;
  const full = [nombre, apellido].filter(Boolean).join(' ').trim();
  return {
    user_id: row.user_id ?? null,
    nombre: nombre || null,
    apellido: apellido || null,
    alias,
    foto_url: row.foto_url ?? null,
    nivel: row.nivel ?? row.nivel_padbol ?? null,
    display_name: full || alias || 'Jugador',
  };
}

export function canReopenMembership(existing) {
  if (!existing) return true;
  if (existing.estado === 'pendiente') return false;
  if (existing.estado === 'aceptado') return false;
  return ['rechazado', 'cancelado', 'vencido'].includes(existing.estado);
}
