/**
 * Dominio puro de Comunidad (sin I/O).
 */

export const VISIBILIDADES = Object.freeze(['publica', 'seguidores']);
export const PUB_ESTADOS = Object.freeze(['activa', 'ocultada', 'eliminada']);
export const COM_ESTADOS = Object.freeze(['activo', 'eliminado', 'ocultado']);
export const DENUNCIA_ESTADOS = Object.freeze(['pendiente', 'revisada', 'descartada']);
export const OBJETO_TIPOS = Object.freeze(['publicacion', 'comentario']);

export const TEXTO_MAX = 2000;
export const COMENTARIO_MAX = 1000;
export const MOTIVO_MAX = 500;
export const FEED_DEFAULT_LIMIT = 20;
export const FEED_MAX_LIMIT = 50;

export function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

/** Quita HTML/scripts; deja texto plano. */
export function sanitizePlainText(raw, { max = TEXTO_MAX } = {}) {
  let text = String(raw ?? '');
  text = text.replace(/<[^>]*>/g, ' ');
  text = text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
  text = text.replace(/\s+/g, ' ').trim();
  if (text.length > max) text = text.slice(0, max).trim();
  return text;
}

export function normalizeVisibilidad(raw, fallback = 'publica') {
  const v = String(raw ?? '').trim().toLowerCase();
  return VISIBILIDADES.includes(v) ? v : fallback;
}

export function parsePositiveInt(raw) {
  const n = parseInt(String(raw ?? ''), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function parseFeedLimit(raw) {
  const n = parseInt(String(raw ?? FEED_DEFAULT_LIMIT), 10);
  if (!Number.isFinite(n) || n < 1) return FEED_DEFAULT_LIMIT;
  return Math.min(n, FEED_MAX_LIMIT);
}

export function isMissingComunidadTableError(err) {
  const msg = String(err?.message ?? err ?? '');
  return /comunidad_/i.test(msg) && (/schema cache|does not exist|Could not find the table/i.test(msg));
}

export function assertCanEditPublicacion(pub, user) {
  if (!user?.id || !pub) return httpError(404, 'Publicación no encontrada');
  if (pub.autor_user_id !== user.id) return httpError(403, 'Solo el autor puede editar esta publicación');
  if (pub.estado === 'eliminada') return httpError(404, 'Publicación no encontrada');
  return null;
}

export function assertCanDeletePublicacion(pub, user, { isModerator = false } = {}) {
  if (!user?.id || !pub) return httpError(404, 'Publicación no encontrada');
  if (pub.estado === 'eliminada') return httpError(404, 'Publicación no encontrada');
  if (pub.autor_user_id === user.id || isModerator) return null;
  return httpError(403, 'No tenés permiso para eliminar esta publicación');
}

export function assertCanDeleteComentario(com, user, { isModerator = false } = {}) {
  if (!user?.id || !com) return httpError(404, 'Comentario no encontrado');
  if (com.estado === 'eliminado') return httpError(404, 'Comentario no encontrado');
  if (com.autor_user_id === user.id || isModerator) return null;
  return httpError(403, 'No tenés permiso para eliminar este comentario');
}

export function assertCanFollow({ actorId, targetId }) {
  if (!actorId || !targetId) return httpError(400, 'Usuario inválido');
  if (String(actorId) === String(targetId)) return httpError(400, 'No podés seguirte a vos mismo');
  return null;
}

export function assertCanInteractDespiteBlocks({
  actorId,
  targetAuthorId,
  blockedPairIds = [],
}) {
  if (!actorId || !targetAuthorId) return null;
  if (String(actorId) === String(targetAuthorId)) return null;
  const blocked = blockedPairIds.some((pair) => {
    const a = String(pair.blocker_user_id);
    const b = String(pair.blocked_user_id);
    return (
      (a === String(actorId) && b === String(targetAuthorId))
      || (a === String(targetAuthorId) && b === String(actorId))
    );
  });
  if (blocked) return httpError(403, 'No podés interactuar con este usuario');
  return null;
}

export function filterFeedVisibility(rows, {
  viewerId = null,
  followingIds = new Set(),
  blockedUserIds = new Set(),
}) {
  return (rows ?? []).filter((row) => {
    if (!row || row.estado !== 'activa') return false;
    if (blockedUserIds.has(String(row.autor_user_id))) return false;
    if (row.visibilidad === 'publica') return true;
    if (row.visibilidad === 'seguidores') {
      if (viewerId && String(row.autor_user_id) === String(viewerId)) return true;
      return viewerId && followingIds.has(String(row.autor_user_id));
    }
    return false;
  });
}

export function toggleReactionState(existing) {
  if (existing) {
    return { action: 'removed', reacted: false };
  }
  return { action: 'added', reacted: true };
}

export function buildComunidadNotificacionDedupeKey(event, parts = {}) {
  const bits = Object.entries(parts)
    .filter(([, v]) => v != null && v !== '')
    .map(([k, v]) => `${k}${v}`);
  return `comunidad:${event}:${bits.join(':')}`;
}

export function isModeratorRole(role) {
  const rol = String(role?.rol ?? role ?? '').toLowerCase();
  return rol === 'super_admin' || rol === 'admin_club';
}

export function mapAutorPublico(perfil) {
  if (!perfil) {
    return {
      user_id: null,
      display_name: 'Jugador',
      foto_url: null,
      alias: null,
    };
  }
  const nombre = String(perfil.nombre ?? '').trim();
  const apellido = String(perfil.apellido ?? '').trim();
  const aliasRaw = String(perfil.apodo ?? perfil.username ?? '').trim();
  const alias = aliasRaw ? (aliasRaw.startsWith('@') ? aliasRaw : `@${aliasRaw}`) : null;
  const full = [nombre, apellido].filter(Boolean).join(' ').trim();
  return {
    user_id: perfil.user_id ?? null,
    display_name: full || alias || 'Jugador',
    foto_url: perfil.foto_url ?? null,
    alias,
  };
}

export function mapPublicacionDto(row, {
  autor = null,
  reacciones_count = 0,
  comentarios_count = 0,
  reacted = false,
} = {}) {
  if (!row) return null;
  return {
    id: row.id,
    texto: row.texto,
    imagen_url: row.imagen_url ?? null,
    sede_id: row.sede_id ?? null,
    evento_ref: row.evento_ref ?? null,
    visibilidad: row.visibilidad,
    estado: row.estado,
    created_at: row.created_at,
    updated_at: row.updated_at,
    autor: autor ?? mapAutorPublico({ user_id: row.autor_user_id }),
    reacciones_count: Number(reacciones_count) || 0,
    comentarios_count: Number(comentarios_count) || 0,
    reacted: Boolean(reacted),
  };
}

export function mapComentarioDto(row, autor = null) {
  if (!row) return null;
  return {
    id: row.id,
    publicacion_id: row.publicacion_id,
    texto: row.texto,
    estado: row.estado,
    created_at: row.created_at,
    autor: autor ?? mapAutorPublico({ user_id: row.autor_user_id }),
  };
}

export function mapUsuarioResumenDto({
  userId,
  autor,
  seguidores_count = 0,
  seguidos_count = 0,
  following = false,
  blocked_by_me = false,
  blocks_me = false,
}) {
  return {
    user_id: userId,
    ...mapAutorPublico(autor ? { ...autor, user_id: userId } : { user_id: userId }),
    seguidores_count,
    seguidos_count,
    following: Boolean(following),
    blocked_by_me: Boolean(blocked_by_me),
    blocks_me: Boolean(blocks_me),
  };
}
