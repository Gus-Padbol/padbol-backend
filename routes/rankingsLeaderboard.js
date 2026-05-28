const VALID_NIVELES = new Set(['club', 'nacional', 'fipa']);
const VALID_DEPORTES = new Set(['padbol', 'padel', 'pickleball', 'tenis', 'futbol']);

function isMissingRankingsLeaderboardTable(error) {
  const message = String(error?.message ?? '').toLowerCase();
  return (
    error?.code === '42P01'
    || error?.code === 'PGRST205'
    || message.includes('rankings_leaderboard')
    || message.includes('does not exist')
    || message.includes('could not find the table')
  );
}

function formatDisplayName(perfil) {
  const apodo = String(perfil?.apodo ?? '').trim();
  if (apodo) return apodo;
  const nombre = String(perfil?.nombre ?? '').trim();
  if (nombre) return nombre;
  return 'Jugador';
}

function formatUsername(perfil) {
  const raw = perfil?.username ?? perfil?.alias ?? '';
  const username = String(raw).trim().replace(/^@+/, '');
  return username || null;
}

export function mountRankingsLeaderboardRoutes(app, { supabaseAdmin, getAuthenticatedUser }) {
  app.get('/api/rankings/:deporte', async (req, res) => {
    try {
      const deporte = String(req.params.deporte ?? '').trim().toLowerCase();
      const nivel = String(req.query.nivel ?? 'club').trim().toLowerCase();

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

      const { data: rows, error } = await supabaseAdmin
        .from('rankings_leaderboard')
        .select('user_id, puntos')
        .eq('deporte', deporte)
        .eq('nivel', nivel)
        .order('puntos', { ascending: false })
        .order('updated_at', { ascending: true })
        .limit(500);

      if (error) {
        if (isMissingRankingsLeaderboardTable(error)) {
          return res.json({ rankings: [], current_user_id: currentUserId });
        }
        throw error;
      }

      if (!rows?.length) {
        return res.json({ rankings: [], current_user_id: currentUserId });
      }

      const userIds = [...new Set(rows.map((row) => row.user_id).filter(Boolean))];
      const { data: perfiles, error: perfilErr } = await supabaseAdmin
        .from('jugadores_perfil')
        .select('user_id, nombre, apodo, username, alias, foto_url, email')
        .in('user_id', userIds);

      if (perfilErr) throw perfilErr;

      const perfilByUserId = Object.fromEntries(
        (perfiles ?? []).map((perfil) => [perfil.user_id, perfil]),
      );

      const rankings = rows.map((row, index) => {
        const perfil = perfilByUserId[row.user_id] ?? {};
        return {
          posicion: index + 1,
          user_id: row.user_id,
          email: perfil.email ?? null,
          display_name: formatDisplayName(perfil),
          username: formatUsername(perfil),
          foto_url: perfil.foto_url ?? null,
          puntos: Number(row.puntos) || 0,
        };
      });

      res.json({ rankings, current_user_id: currentUserId });
    } catch (err) {
      console.error('❌ Error GET /api/rankings/:deporte:', err.message);
      res.status(500).json({ error: err.message });
    }
  });
}
