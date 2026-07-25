import {
  mapRankingsLeaderboardPublicRow,
  RANKINGS_LEADERBOARD_PERFIL_SELECT,
  RANKINGS_LEADERBOARD_STATS_SELECT,
  isMissingRankingsStatsColumnError,
  normalizeRankingsStatsRow,
} from '../lib/rankingsLeaderboardPublic.js';

const VALID_NIVELES = new Set(['club', 'nacional', 'fipa']);
const VALID_DEPORTES = new Set(['padbol', 'padel', 'pickleball', 'tenis', 'futbol']);

function isMissingRankingsLeaderboardTable(error) {
  if (isMissingRankingsStatsColumnError(error)) return false;
  const message = String(error?.message ?? '').toLowerCase();
  return (
    error?.code === '42P01'
    || error?.code === 'PGRST205'
    || (message.includes('rankings_leaderboard') && message.includes('does not exist'))
    || message.includes('could not find the table')
  );
}

export function mountRankingsLeaderboardRoutes(app, { supabaseAdmin, getAuthenticatedUser }) {
  app.get('/api/rankings/:deporte', async (req, res) => {
    try {
      const deporte = String(req.params.deporte ?? '').trim().toLowerCase();
      const nivel = String(req.query.nivel ?? 'club').trim().toLowerCase();
      const sedeId = Number(req.query.sede_id);
      const categoria = String(req.query.categoria ?? '').trim();

      if (!VALID_DEPORTES.has(deporte)) {
        return res.status(400).json({ error: 'Deporte no válido' });
      }
      if (!VALID_NIVELES.has(nivel)) {
        return res.status(400).json({ error: 'nivel debe ser club, nacional o fipa' });
      }
      if (deporte !== 'padbol' && nivel !== 'club') {
        return res.json({ rankings: [], current_user_id: null });
      }

      const auth = await getAuthenticatedUser(req);
      const currentUserId = auth.user?.id ?? null;

      let rows;
      let query = supabaseAdmin
        .from('rankings_leaderboard')
        .select(RANKINGS_LEADERBOARD_STATS_SELECT)
        .eq('deporte', deporte)
        .eq('nivel', nivel)
        .order('puntos', { ascending: false })
        .order('updated_at', { ascending: true })
        .limit(500);

      const { data: rowsWithStats, error: statsErr } = await query;
      if (statsErr) {
        if (isMissingRankingsLeaderboardTable(statsErr)) {
          return res.json({ rankings: [], current_user_id: currentUserId });
        }
        if (isMissingRankingsStatsColumnError(statsErr)) {
          const { data: fallbackRows, error: fallbackErr } = await supabaseAdmin
            .from('rankings_leaderboard')
            .select('user_id, puntos')
            .eq('deporte', deporte)
            .eq('nivel', nivel)
            .order('puntos', { ascending: false })
            .order('updated_at', { ascending: true })
            .limit(500);
          if (fallbackErr) {
            if (isMissingRankingsLeaderboardTable(fallbackErr)) {
              return res.json({ rankings: [], current_user_id: currentUserId });
            }
            throw fallbackErr;
          }
          rows = (fallbackRows ?? []).map((row) => ({
            ...row,
            ...normalizeRankingsStatsRow({}),
          }));
        } else {
          throw statsErr;
        }
      } else {
        rows = rowsWithStats ?? [];
      }

      if (!rows?.length) {
        return res.json({ rankings: [], current_user_id: currentUserId });
      }

      const userIds = [...new Set(rows.map((row) => row.user_id).filter(Boolean))];
      let perfilesQuery = supabaseAdmin
        .from('jugadores_perfil')
        .select(`${RANKINGS_LEADERBOARD_PERFIL_SELECT},sede_id,nivel`)
        .in('user_id', userIds);
      if (nivel === 'club' && Number.isSafeInteger(sedeId) && sedeId > 0 && categoria) {
        perfilesQuery = perfilesQuery.eq('sede_id', sedeId).eq('nivel', categoria);
      }
      const { data: perfiles, error: perfilErr } = await perfilesQuery;

      if (perfilErr) throw perfilErr;

      const perfilByUserId = Object.fromEntries(
        (perfiles ?? []).map((perfil) => [perfil.user_id, perfil]),
      );

      const filteredRows = nivel === 'club' && Number.isSafeInteger(sedeId) && sedeId > 0 && categoria
        ? rows.filter((row) => perfilByUserId[row.user_id])
        : rows;
      const rankings = filteredRows.map((row, index) =>
        mapRankingsLeaderboardPublicRow(
          row,
          perfilByUserId[row.user_id] ?? {},
          index,
          currentUserId,
        ),
      );

      res.json({ rankings, current_user_id: currentUserId });
    } catch (err) {
      console.error('❌ Error GET /api/rankings/:deporte:', err.message);
      res.status(500).json({ error: err.message });
    }
  });
}
