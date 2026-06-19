export const RANKINGS_LEADERBOARD_PERFIL_SELECT =
  'user_id, nombre, apodo, username, alias, foto_url, pais';

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

/** Public leaderboard row — no email, phone, or third-party user_id. */
export function mapRankingsLeaderboardPublicRow(row, perfil, index, currentUserId) {
  return {
    posicion: index + 1,
    display_name: formatRankingsDisplayName(perfil),
    username: formatRankingsUsername(perfil),
    foto_url: perfil?.foto_url ?? null,
    pais: perfil?.pais ?? null,
    puntos: Number(row?.puntos) || 0,
    is_current_user: Boolean(currentUserId && row?.user_id === currentUserId),
  };
}
