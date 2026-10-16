/** Sporting readiness is independent from account ownership and ranking recognition. */
export function tournamentParticipantLimits(torneo = {}) {
  const mode = String(torneo.modalidad_plantel || 'dobles').toLowerCase();
  const format = String(torneo.formato_equipo || '').toLowerCase();
  if (mode === 'selecciones') return { min_jugadores: 4, max_jugadores: 8 };
  if (['individual', 'individuales', 'singles', 'single'].includes(mode) || ['individual', 'individuales', 'singles', 'single'].includes(format)) return { min_jugadores: 1, max_jugadores: 1 };
  return { min_jugadores: 2, max_jugadores: 2 };
}
export function participantSportingReadiness(torneo, jugadores) {
  const limits = tournamentParticipantLimits(torneo);
  const rows = Array.isArray(jugadores) ? jugadores : [];
  const seen = new Set();
  let ready = 0;
  for (const row of rows) {
    if (!row || row.tipo_identidad === 'plaza_pendiente' || ['pendiente','rechazado','cancelado','vencido'].includes(row.estado)) continue;
    const name = String(row.nombre || '').trim();
    const identity = row.participante_id || row.user_id || row.id || row.email || name.toLowerCase();
    if (name && identity && !seen.has(identity)) { ready++; seen.add(identity); }
  }
  const valid = ready >= limits.min_jugadores && rows.length <= limits.max_jugadores;
  return { habilitado: valid, minimos: limits.min_jugadores, maximos: limits.max_jugadores,
    jugadores_identificados: ready, faltantes: Math.max(0, limits.min_jugadores - ready) };
}
export async function assertTournamentTeamsSportReady(_db, { torneo, equipos }) {
  const pending = (equipos || []).map(team => ({ equipo_id: Number(team.id), ...participantSportingReadiness(torneo, team.jugadores) })).filter(x => !x.habilitado);
  if (pending.length) {
    const error = new Error('Completa los participantes deportivos de cada equipo antes de iniciar o abrir el marcador.');
    error.status = 409; error.code = 'PARTICIPANTS_NOT_READY'; error.details = pending; throw error;
  }
  return equipos;
}
