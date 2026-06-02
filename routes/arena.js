import express from 'express';

const LOGROS_DEFINITIONS = [
  { slug: 'primer_partido', meta: 1, metric: 'partidos_jugados' },
  { slug: 'racha_5', meta: 5, metric: 'racha_victorias' },
  { slug: 'jugador_global', meta: 3, metric: 'paises_jugados' },
  { slug: 'top10_fipa', meta: 10, metric: 'ranking_fipa_posicion', inverse: true },
  { slug: 'diez_torneos', meta: 10, metric: 'torneos_jugados' },
  { slug: 'imbatible', meta: 10, metric: 'racha_victorias' },
  { slug: 'embajador', meta: 5, metric: 'paises_jugados' },
  { slug: 'centenario', meta: 100, metric: 'partidos_jugados' },
  { slug: 'campeon_local', meta: 1, metric: 'torneos_ganados_local' },
  { slug: 'campeon_nacional', meta: 1, metric: 'torneos_ganados_nacional' },
  { slug: 'leyenda_fipa', meta: 1, metric: 'torneos_ganados_fipa' },
  { slug: 'fundador', meta: 1, metric: 'registro_temprano' },
];

function isMissingTable(error) {
  const message = String(error?.message ?? '').toLowerCase();
  return (
    error?.code === '42P01'
    || error?.code === 'PGRST205'
    || message.includes('does not exist')
    || message.includes('could not find the table')
  );
}

function parsePositiveInt(value) {
  const n = parseInt(String(value ?? ''), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function partidoResultText(partido) {
  const capitan = String(partido?.capitan_nombre ?? 'Un jugador').trim() || 'Un jugador';
  const resultado = partido?.resultado ?? partido?.ganador ?? null;
  if (resultado) {
    return `${capitan} registró un resultado${partido?.cancha ? ` en ${partido.cancha}` : ''}`;
  }
  return `${capitan} jugó un partido en la sede`;
}

function computeStreakVictories(partidos, userId, email) {
  const sorted = [...(partidos ?? [])].sort((a, b) => {
    const da = `${a.fecha ?? ''} ${a.hora ?? ''}`;
    const db = `${b.fecha ?? ''} ${b.hora ?? ''}`;
    return db.localeCompare(da);
  });

  let streak = 0;
  for (const row of sorted) {
    const ganador = String(row?.ganador ?? '').toLowerCase();
    const isWin = ganador && (
      ganador === String(userId ?? '').toLowerCase()
      || (email && ganador === String(email).toLowerCase())
      || ganador === 'capitan'
    );
    if (isWin) streak += 1;
    else if (ganador) break;
  }
  return streak;
}

async function fetchUserMetrics(supabaseAdmin, user) {
  const userId = user?.id ?? null;
  const email = String(user?.email ?? '').trim().toLowerCase();

  let partidos_jugados = 0;
  let torneos_jugados = 0;
  let paises_jugados = 0;
  let ranking_fipa_posicion = 0;
  let torneos_ganados_local = 0;
  let torneos_ganados_nacional = 0;
  let torneos_ganados_fipa = 0;
  let registro_temprano = 0;
  let racha_victorias = 0;

  const { data: perfil } = userId
    ? await supabaseAdmin
      .from('jugadores_perfil')
      .select('user_id, pais, created_at')
      .eq('user_id', userId)
      .maybeSingle()
    : { data: null };

  if (perfil?.created_at) {
    const created = new Date(perfil.created_at);
    if (!Number.isNaN(created.getTime()) && created <= new Date('2026-12-31T23:59:59Z')) {
      registro_temprano = 1;
    }
  }

      const { data: partidosRows } = userId
    ? await supabaseAdmin
      .from('partidos_abiertos')
      .select('id, fecha, hora, ganador, capitan_user_id, capitan_email, estado, sede_id, sedes ( pais )')
      .eq('capitan_user_id', userId)
      .order('fecha', { ascending: false })
      .limit(200)
    : { data: [] };

  const played = (partidosRows ?? []).filter((row) => {
    const estado = String(row?.estado ?? '').toLowerCase();
    return estado === 'jugado' || row?.ganador;
  });
  partidos_jugados = played.length;
  racha_victorias = computeStreakVictories(played, userId, email);

  const countries = new Set();
  if (perfil?.pais) countries.add(String(perfil.pais).trim().toLowerCase());
  played.forEach((row) => {
    const pais = row?.sedes?.pais ?? row?.pais ?? null;
    if (pais) countries.add(String(pais).trim().toLowerCase());
  });
  paises_jugados = countries.size;

  const { data: fipaRows } = await supabaseAdmin
    .from('rankings_leaderboard')
    .select('user_id, puntos')
    .eq('deporte', 'padbol')
    .eq('nivel', 'fipa')
    .order('puntos', { ascending: false })
    .order('updated_at', { ascending: true })
    .limit(500);

  if (fipaRows?.length && userId) {
    const idx = fipaRows.findIndex((row) => row.user_id === userId);
    if (idx >= 0) ranking_fipa_posicion = idx + 1;
  }

  const { data: equiposRows } = userId
    ? await supabaseAdmin
      .from('equipos')
      .select('id, torneo_id, jugadores, torneos ( id, estado, nivel_torneo, categoria, tipo )')
      .not('jugadores', 'is', null)
      .limit(500)
    : { data: [] };

  const myEquipos = (equiposRows ?? []).filter((eq) => {
    const jugadores = Array.isArray(eq.jugadores) ? eq.jugadores : [];
    return jugadores.some((j) => {
      const jid = String(j?.user_id ?? j?.id ?? '').toLowerCase();
      const jemail = String(j?.email ?? '').trim().toLowerCase();
      return (userId && jid === String(userId).toLowerCase()) || (email && jemail === email);
    });
  });

  const finalized = myEquipos.filter((eq) => {
    const estado = String(eq?.torneos?.estado ?? '').toLowerCase();
    return estado === 'finalizado';
  });
  torneos_jugados = finalized.length;

  finalized.forEach((eq) => {
    const nivel = String(eq?.torneos?.nivel_torneo ?? eq?.torneos?.categoria ?? eq?.torneos?.tipo ?? '').toLowerCase();
    if (nivel.includes('fipa')) torneos_ganados_fipa += 1;
    else if (nivel.includes('nacional')) torneos_ganados_nacional += 1;
    else torneos_ganados_local += 1;
  });

  return {
    partidos_jugados,
    torneos_jugados,
    paises_jugados,
    ranking_fipa_posicion,
    torneos_ganados_local,
    torneos_ganados_nacional,
    torneos_ganados_fipa,
    registro_temprano,
    racha_victorias,
  };
}

function resolveProgress(def, metrics) {
  const value = Number(metrics[def.metric] ?? 0);
  if (def.inverse) {
    if (value <= 0) return { progreso: 0, desbloqueado: false };
    return { progreso: value, desbloqueado: value > 0 && value <= def.meta };
  }
  const progreso = Math.min(value, def.meta);
  return { progreso, desbloqueado: value >= def.meta };
}

export function mountArenaRoutes(app, { supabaseAdmin, getAuthenticatedUser }) {
  const router = express.Router();

  router.get('/feed/:sede_id', async (req, res) => {
    try {
      const sedeId = parsePositiveInt(req.params.sede_id);
      if (!sedeId) {
        return res.status(400).json({ error: 'sede_id inválido' });
      }

      const feed = [];

      const { data: partidos, error: partidosErr } = await supabaseAdmin
        .from('partidos_abiertos')
        .select('id, capitan_nombre, resultado, ganador, cancha, fecha, hora, created_at, updated_at, estado')
        .eq('sede_id', sedeId)
        .in('estado', ['jugado', 'completo'])
        .order('updated_at', { ascending: false })
        .limit(10);

      if (partidosErr && !isMissingTable(partidosErr)) throw partidosErr;

      (partidos ?? []).forEach((partido) => {
        feed.push({
          tipo: 'resultado',
          texto: partidoResultText(partido),
          created_at: partido.updated_at ?? partido.created_at ?? partido.fecha,
        });
      });

      const { data: torneos, error: torneosErr } = await supabaseAdmin
        .from('torneos')
        .select('id, nombre, created_at, fecha_inicio, estado')
        .eq('sede_id', sedeId)
        .order('created_at', { ascending: false })
        .limit(5);

      if (torneosErr && !isMissingTable(torneosErr)) throw torneosErr;

      (torneos ?? []).forEach((torneo) => {
        feed.push({
          tipo: 'torneo',
          texto: `Nuevo torneo: ${torneo.nombre ?? 'Torneo'}`,
          created_at: torneo.created_at ?? torneo.fecha_inicio,
        });
      });

      const { data: rankings, error: rankingsErr } = await supabaseAdmin
        .from('rankings_leaderboard')
        .select('user_id, puntos, updated_at, deporte, nivel')
        .order('updated_at', { ascending: false })
        .limit(20);

      if (rankingsErr && !isMissingTable(rankingsErr)) throw rankingsErr;

      const rankingUserIds = [...new Set((rankings ?? []).map((r) => r.user_id).filter(Boolean))];
      let perfilByUser = {};
      if (rankingUserIds.length) {
        const { data: perfiles } = await supabaseAdmin
          .from('jugadores_perfil')
          .select('user_id, apodo, nombre, username')
          .in('user_id', rankingUserIds);
        perfilByUser = Object.fromEntries((perfiles ?? []).map((p) => [p.user_id, p]));
      }

      (rankings ?? []).slice(0, 5).forEach((row, index) => {
        const perfil = perfilByUser[row.user_id] ?? {};
        const name = String(perfil.apodo ?? perfil.nombre ?? perfil.username ?? 'Un jugador').trim();
        feed.push({
          tipo: 'ranking',
          texto: `${name} subió en el ranking ${String(row.nivel ?? 'club').toUpperCase()} (#${index + 1})`,
          created_at: row.updated_at,
        });
      });

      feed.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

      res.json({ feed: feed.slice(0, 10) });
    } catch (err) {
      console.error('❌ GET /api/arena/feed/:sede_id', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/logros', async (req, res) => {
    try {
      const { user, status, error: authError } = await getAuthenticatedUser(req);
      if (!user) {
        return res.status(status).json({ error: authError });
      }

      const metrics = await fetchUserMetrics(supabaseAdmin, user);

      let unlockedRows = [];
      const { data: dbLogros, error: logrosErr } = await supabaseAdmin
        .from('logros_jugador')
        .select('slug, desbloqueado_en')
        .eq('user_id', user.id);

      if (logrosErr) {
        if (!isMissingTable(logrosErr)) throw logrosErr;
      } else {
        unlockedRows = dbLogros ?? [];
      }

      const unlockedBySlug = Object.fromEntries(
        unlockedRows.map((row) => [row.slug, row.desbloqueado_en ?? null]),
      );

      const logros = LOGROS_DEFINITIONS.map((def) => {
        const { progreso, desbloqueado } = resolveProgress(def, metrics);
        const dbUnlockedAt = unlockedBySlug[def.slug] ?? null;
        return {
          slug: def.slug,
          meta: def.meta,
          metric: def.metric,
          progreso,
          desbloqueado: desbloqueado || Boolean(dbUnlockedAt),
          desbloqueado_en: dbUnlockedAt,
          inverse: Boolean(def.inverse),
        };
      });

      const unlockedCount = logros.filter((l) => l.desbloqueado).length;

      res.json({
        logros,
        unlockedCount,
        total: LOGROS_DEFINITIONS.length,
        metrics,
      });
    } catch (err) {
      console.error('❌ GET /api/arena/logros', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  app.use('/api/arena', router);
}
