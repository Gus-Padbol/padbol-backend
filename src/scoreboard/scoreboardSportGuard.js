import { resolvePersistedScoringPolicy } from './napoliScoringPolicy.js';
const PICKLEBALL_UNAVAILABLE = 'El marcador de Pickleball todavía no está disponible para modificar la puntuación, el saque o reiniciar el partido.';
const SPORT_UNVERIFIED = 'No se pudo verificar el deporte del partido. Intentá nuevamente.';

function conflict(message) {
  return Object.assign(new Error(message), { status: 409 });
}

async function readLinkedRow(db, table, columns, id, optional = false) {
  let result;
  try {
    result = await db.from(table).select(columns).eq('id', id).maybeSingle();
  } catch {
    throw conflict(SPORT_UNVERIFIED);
  }
  if (result?.error || (!optional && !result?.data)) throw conflict(SPORT_UNVERIFIED);
  return result.data;
}

function assertNotPickleball(row) {
  if (String(row?.deporte ?? '').trim().toLowerCase() === 'pickleball') {
    throw conflict(PICKLEBALL_UNAVAILABLE);
  }
}

/**
 * Temporary containment, not a Pickleball engine or a sport inference service.
 * Read persisted match/tournament links before any scoring write. No request-body
 * sport, team size, venue label or old score can establish the scoring rules.
 * Legacy rows with no sport-bearing link remain unchanged; they are unverified.
 */
export async function assertScoreboardScoringSupported(db, scoreboard, { readOnly = false } = {}) {
  const tournamentIds = new Set();
  let linkedMatch = null;
  let policy = null;
  if (scoreboard.torneo_id != null) tournamentIds.add(String(scoreboard.torneo_id));

  if (scoreboard.partido_abierto_id != null) {
    const match = await readLinkedRow(db, 'partidos_abiertos', 'id, deporte', scoreboard.partido_abierto_id, readOnly);
    if (!readOnly) assertNotPickleball(match);
  }

  if (scoreboard.partido_torneo_id != null) {
    const match = await readLinkedRow(db, 'partidos', 'id, torneo_id, grupo, ronda, bracket_round, bracket_position, partido_siguiente_id, partido_siguiente_slot', scoreboard.partido_torneo_id, readOnly && String(scoreboard.torneo_id) !== '57');
    if (!match && readOnly) return null;
    if (match.torneo_id == null) throw conflict(SPORT_UNVERIFIED);
    tournamentIds.add(String(match.torneo_id));
    linkedMatch = match;
  }

  // Check every persisted link: a conflicting non-Pickleball link cannot mask it.
  for (const id of tournamentIds) {
    const tournament = await readLinkedRow(db, 'torneos', 'id, deporte, modalidad_plantel, plan_nations, es_prueba', id, readOnly);
    if (!readOnly) assertNotPickleball(tournament);
    if (tournamentIds.size === 1) policy = resolvePersistedScoringPolicy(tournament, linkedMatch);
  }
  if (!readOnly && tournamentIds.size > 1 && tournamentIds.has('57')) throw conflict(SPORT_UNVERIFIED);
  return policy;
}
