/** Selects y mappers seguros para equipos de usuario (sin columnas internas). */

export const EQUIPO_USUARIO_SELECT = [
  'id',
  'nombre',
  'deporte',
  'capitan_user_id',
  'capitan_email',
  'min_jugadores',
  'max_jugadores',
  'estado',
  'torneo_id',
  'created_at',
  'updated_at',
].join(', ');

export const EQUIPO_JUGADOR_SELECT = [
  'id',
  'equipo_id',
  'user_id',
  'email',
  'nombre',
  'rol',
  'estado',
  'invited_at',
  'responded_at',
].join(', ');

function normalizeEmail(email) {
  return String(email ?? '').trim().toLowerCase();
}

function isViewerSelf(member, viewer) {
  if (!viewer) return false;
  if (member.user_id && member.user_id === viewer.id) return true;
  return normalizeEmail(member.email) === normalizeEmail(viewer.email);
}

/** Miembro en detalle de equipo: email/user_id solo para capitán o el propio jugador. */
export function mapEquipoJugadorDto(member, perfil, { viewer, isCaptain }) {
  const isSelf = isViewerSelf(member, viewer);
  const showContact = Boolean(isCaptain || isSelf);

  return {
    id: member.id,
    user_id: showContact ? (member.user_id ?? perfil?.user_id ?? null) : null,
    email: showContact ? member.email : null,
    nombre: member.nombre ?? perfil?.nombre ?? (showContact ? member.email : 'Jugador'),
    foto_url: perfil?.foto_url ?? null,
    rol: member.rol,
    estado: member.estado,
  };
}

/** Resumen de equipo: oculta email del capitán salvo al propio capitán. */
export function mapEquipoSummaryContactFields(equipo, viewer) {
  const esCapitan = Boolean(viewer && equipo.capitan_user_id === viewer.id);
  return {
    capitan_user_id: equipo.capitan_user_id,
    capitan_email: esCapitan ? (equipo.capitan_email ?? null) : null,
    es_capitan: esCapitan,
  };
}
