function pgUnavailable(res) {
  return res.status(503).json({ error: 'DATABASE_URL no configurada — torneos finalizados no disponible' });
}

function parsePositiveInt(value, fallback = null) {
  const n = parseInt(String(value ?? ''), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function normalizeDeporteFilter(raw) {
  const s = String(raw ?? '').trim().toLowerCase();
  if (!s) return null;
  const compact = s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[\s-]+/g, '_');
  if (compact === 'futbol5' || compact === 'futbol_5') return 'futbol_5';
  if (compact === 'futbol7' || compact === 'futbol_7') return 'futbol_7';
  return compact;
}

function buildDisplayNameFromJugador(j, perfil) {
  if (perfil) {
    const nombre = String(perfil.nombre ?? '').trim();
    const apellido = String(perfil.apellido ?? '').trim();
    const full = [nombre, apellido].filter(Boolean).join(' ');
    if (full) return full;
    if (perfil.apodo) return String(perfil.apodo).trim();
    if (perfil.username) return String(perfil.username).trim();
  }
  const nombre = String(j?.nombre ?? j?.name ?? '').trim();
  if (nombre) return nombre;
  const email = String(j?.email ?? '').trim();
  if (email) return email.split('@')[0];
  return 'Jugador';
}

function mapJugadoresPodio(jugadoresRaw, perfilByEmail, perfilByUserId) {
  let arr = jugadoresRaw;
  if (typeof arr === 'string') {
    try {
      arr = JSON.parse(arr);
    } catch {
      arr = [];
    }
  }
  if (!Array.isArray(arr)) return [];

  return arr.map((j) => {
    if (!j || typeof j !== 'object') {
      return { display_name: 'Jugador', foto_url: null };
    }
    const email = String(j.email || '').trim().toLowerCase();
    const uid = j.user_id ?? j.id ?? null;
    const perfil = (uid && perfilByUserId.get(String(uid)))
      ?? (email && perfilByEmail.get(email))
      ?? null;
    return {
      display_name: buildDisplayNameFromJugador(j, perfil),
      foto_url: perfil?.foto_url ?? j.foto_url ?? null,
    };
  });
}

async function fetchPerfilesForJugadoresPg(pgPool, jugadoresLists) {
  const emails = new Set();
  const userIds = new Set();

  for (const list of jugadoresLists) {
    let arr = list;
    if (typeof arr === 'string') {
      try {
        arr = JSON.parse(arr);
      } catch {
        arr = [];
      }
    }
    if (!Array.isArray(arr)) continue;
    for (const j of arr) {
      if (!j || typeof j !== 'object') continue;
      const email = String(j.email || '').trim().toLowerCase();
      const uid = j.user_id ?? j.id ?? null;
      if (email) emails.add(email);
      if (uid) userIds.add(String(uid));
    }
  }

  const perfilByEmail = new Map();
  const perfilByUserId = new Map();

  if (emails.size > 0) {
    const { rows } = await pgPool.query(
      `SELECT user_id, nombre, apellido, apodo, username, email, foto_url
       FROM jugadores_perfil
       WHERE lower(trim(email)) = ANY($1::text[])`,
      [[...emails]],
    );
    for (const row of rows) {
      const em = String(row.email || '').trim().toLowerCase();
      if (em) perfilByEmail.set(em, row);
      if (row.user_id) perfilByUserId.set(String(row.user_id), row);
    }
  }

  if (userIds.size > 0) {
    const missing = [...userIds].filter((id) => !perfilByUserId.has(id));
    if (missing.length > 0) {
      const { rows } = await pgPool.query(
        `SELECT user_id, nombre, apellido, apodo, username, email, foto_url
         FROM jugadores_perfil
         WHERE user_id::text = ANY($1::text[])`,
        [missing],
      );
      for (const row of rows) {
        if (row.user_id) perfilByUserId.set(String(row.user_id), row);
        const em = String(row.email || '').trim().toLowerCase();
        if (em) perfilByEmail.set(em, row);
      }
    }
  }

  return { perfilByEmail, perfilByUserId };
}

async function listTorneosFinalizadosPg(pgPool, { sedeId, deporte, page, limit }) {
  const params = [];
  const where = [`lower(trim(t.estado)) = 'finalizado'`];

  if (sedeId != null) {
    params.push(sedeId);
    where.push(`t.sede_id = $${params.length}`);
  }

  if (deporte) {
    params.push(deporte);
    where.push(`lower(replace(replace(trim(COALESCE(t.deporte, 'padbol')), '-', '_'), ' ', '_')) = $${params.length}`);
  }

  const whereSql = where.join(' AND ');

  const countResult = await pgPool.query(
    `SELECT COUNT(*)::int AS total FROM torneos t WHERE ${whereSql}`,
    params,
  );
  const total = countResult.rows[0]?.total ?? 0;

  const offset = (page - 1) * limit;
  params.push(limit, offset);

  const { rows: torneos } = await pgPool.query(
    `SELECT
       t.id,
       t.nombre,
       COALESCE(t.deporte, 'padbol') AS deporte,
       t.tipo_torneo,
       t.fecha_inicio,
       t.fecha_fin,
       t.sede_id,
       s.nombre AS sede_nombre
     FROM torneos t
     LEFT JOIN sedes s ON s.id = t.sede_id
     WHERE ${whereSql}
     ORDER BY t.fecha_fin DESC NULLS LAST, t.fecha_inicio DESC NULLS LAST, t.id DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );

  if (!torneos.length) {
    return {
      torneos: [],
      pagination: { page, limit, total, total_pages: Math.ceil(total / limit) || 0 },
    };
  }

  const torneoIds = torneos.map((t) => t.id);

  const [{ rows: counts }, { rows: podioRows }] = await Promise.all([
    pgPool.query(
      `SELECT torneo_id, COUNT(*)::int AS total
       FROM equipos
       WHERE torneo_id = ANY($1::int[])
       GROUP BY torneo_id`,
      [torneoIds],
    ),
    pgPool.query(
      `SELECT
         tp.torneo_id,
         tp.posicion,
         tp.equipo_id,
         e.nombre AS equipo_nombre,
         e.jugadores
       FROM tabla_puntos tp
       JOIN equipos e ON e.id = tp.equipo_id
       WHERE tp.torneo_id = ANY($1::int[])
         AND tp.posicion BETWEEN 1 AND 3
       ORDER BY tp.torneo_id, tp.posicion ASC`,
      [torneoIds],
    ),
  ]);

  const countByTorneo = new Map(counts.map((r) => [Number(r.torneo_id), Number(r.total)]));
  const podioByTorneo = new Map();
  for (const row of podioRows) {
    const tid = Number(row.torneo_id);
    if (!podioByTorneo.has(tid)) podioByTorneo.set(tid, []);
    podioByTorneo.get(tid).push(row);
  }

  const { perfilByEmail, perfilByUserId } = await fetchPerfilesForJugadoresPg(
    pgPool,
    podioRows.map((r) => r.jugadores),
  );

  const items = torneos.map((t) => {
    const tid = Number(t.id);
    const podioRaw = podioByTorneo.get(tid) ?? [];
    return {
      id: t.id,
      nombre: t.nombre,
      deporte: t.deporte,
      sede_nombre: t.sede_nombre ?? null,
      sede_id: t.sede_id ?? null,
      fecha_inicio: t.fecha_inicio ?? null,
      fecha_fin: t.fecha_fin ?? null,
      formato: t.tipo_torneo ?? null,
      total_participantes: countByTorneo.get(tid) ?? 0,
      podio: podioRaw.map((p) => ({
        posicion: Number(p.posicion),
        equipo_id: p.equipo_id,
        equipo_nombre: p.equipo_nombre ?? null,
        jugadores: mapJugadoresPodio(p.jugadores, perfilByEmail, perfilByUserId),
      })),
    };
  });

  return {
    torneos: items,
    pagination: {
      page,
      limit,
      total,
      total_pages: Math.ceil(total / limit) || 0,
    },
  };
}

export function mountTorneosFinalizadosRoutes(app, { pgPool }) {
  app.get('/api/torneos/finalizados', async (req, res) => {
    try {
      if (!pgPool) return pgUnavailable(res);

      const page = parsePositiveInt(req.query.page, 1);
      const limit = Math.min(parsePositiveInt(req.query.limit, 10), 50);
      const sedeId = req.query.sede_id != null && String(req.query.sede_id).trim() !== ''
        ? parsePositiveInt(req.query.sede_id, null)
        : null;
      const deporte = normalizeDeporteFilter(req.query.deporte);

      const result = await listTorneosFinalizadosPg(pgPool, {
        sedeId,
        deporte,
        page,
        limit,
      });

      return res.json(result);
    } catch (err) {
      console.error('❌ GET /api/torneos/finalizados:', err.message);
      return res.status(500).json({ error: err.message || 'Error al listar torneos finalizados' });
    }
  });
}
