/**
 * Alcance torneo vs casual — Fase 3 asistencia / recompensas.
 * partido_torneo_id vive en scoreboard_partidos, no en partidos_abiertos (prod).
 */

export function isScoreboardTorneoOutOfScope(scoreboard = null) {
  const raw = scoreboard?.partido_torneo_id;
  return raw != null && raw !== '';
}

/** Marcadores legacy solo si ya vienen en memoria (tests); no se seleccionan de DB. */
export function hasLegacyPartidoTorneoMarker(partido = {}) {
  return partido?.partido_torneo_id != null || partido?.torneo_id != null;
}

export function isTorneoOutOfScopeForCasualAttendance({ partido = {}, scoreboard = null } = {}) {
  if (isScoreboardTorneoOutOfScope(scoreboard)) {
    return true;
  }
  if (hasLegacyPartidoTorneoMarker(partido)) {
    return true;
  }
  return false;
}

export function isMissingOptionalPartidoTorneoColumnError(error) {
  if (error?.code !== '42703') {
    return false;
  }
  const message = String(error?.message ?? '').toLowerCase();
  return message.includes('partido_torneo_id') || message.includes('torneo_id');
}
