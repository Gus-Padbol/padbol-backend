export const RANKINGS_LEADERBOARD_PERFIL_SELECT =
  'user_id, nombre, apodo, username, alias, foto_url, pais';

export const RANKINGS_LEADERBOARD_STATS_SELECT =
  'user_id, puntos, partidos_jugados, ganados, perdidos, empatados, racha_actual, mejor_racha';

export function formatRankingsDisplayName(perfil) {
  const apodo = String(perfil?.apodo ?? '').trim();
  if (apodo) return apodo;
  const nombre = String(perfil?.nombre ?? '').trim();
  if (nombre) return nombre;
  return 'Jugador';
}

export function formatRankingsUsername(perfil) {
  const raw = perfil?.username ?? perfil?.alias ?? '';
  const username = String(raw).trim().replace(/^@+/, '');
  return username || null;
}

export function isMissingRankingsStatsColumnError(error) {
  const message = String(error?.message ?? '').toLowerCase();
  return (
    error?.code === '42703'
    || message.includes('partidos_jugados')
    || message.includes('ganados')
    || message.includes('perdidos')
    || message.includes('empatados')
    || message.includes('racha_actual')
    || message.includes('mejor_racha')
    || (message.includes('column') && message.includes('does not exist'))
  );
}

export function normalizeRankingsStatsRow(row = {}) {
  return {
    partidos_jugados: Number(row.partidos_jugados) || 0,
    ganados: Number(row.ganados) || 0,
    perdidos: Number(row.perdidos) || 0,
    // Legado: Padbol no admite empates; la columna DB puede existir pero la API expone siempre 0.
    empatados: 0,
    racha_actual: Number(row.racha_actual) || 0,
    mejor_racha: Number(row.mejor_racha) || 0,
  };
}

export function computePorcentajeVictorias(ganados, partidosJugados) {
  const pj = Number(partidosJugados) || 0;
  const g = Number(ganados) || 0;
  if (pj <= 0) return 0;
  return Math.round((g / pj) * 10000) / 100;
}

/** Public leaderboard row — no email, phone, or third-party user_id. */
export function mapRankingsLeaderboardPublicRow(row, perfil, index, currentUserId) {
  const stats = normalizeRankingsStatsRow(row);

  return {
    posicion: index + 1,
    display_name: formatRankingsDisplayName(perfil),
    username: formatRankingsUsername(perfil),
    foto_url: perfil?.foto_url ?? null,
    pais: perfil?.pais ?? null,
    puntos: Number(row?.puntos) || 0,
    partidos_jugados: stats.partidos_jugados,
    ganados: stats.ganados,
    perdidos: stats.perdidos,
    empatados: stats.empatados,
    racha_actual: stats.racha_actual,
    mejor_racha: stats.mejor_racha,
    porcentaje_victorias: computePorcentajeVictorias(stats.ganados, stats.partidos_jugados),
    is_current_user: Boolean(currentUserId && row?.user_id === currentUserId),
  };
}
