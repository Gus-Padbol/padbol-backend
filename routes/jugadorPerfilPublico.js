const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UUID_COMPACT_REGEX = /^[0-9a-f]{32}$/i;

function pgUnavailable(res) {
  return res.status(503).json({ error: 'DATABASE_URL no configurada — perfil público no disponible' });
}

function normalizeUuid(raw) {
  const s = String(raw ?? '').trim().toLowerCase();
  if (UUID_REGEX.test(s)) return s;
  if (UUID_COMPACT_REGEX.test(s)) {
    return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
  }
  return null;
}

export function parsePerfilPublicoIdentifier(raw) {
  const s = decodeURIComponent(String(raw ?? '')).trim();
  if (!s) return null;
  if (s.includes('@')) return { kind: 'email', value: s.toLowerCase() };
  const uuid = normalizeUuid(s);
  if (uuid) return { kind: 'user_id', value: uuid };
  if (/^\d+$/.test(s)) return { kind: 'profile_id', value: s };
  return { kind: 'username', value: s };
}

/** Public routes must not resolve profiles by email (enumeration risk). */
export function isEmailPublicIdentifier(raw) {
  return parsePerfilPublicoIdentifier(raw)?.kind === 'email';
}

function parseDeportesFromPerfil(raw) {
  if (raw == null) return [];
  if (Array.isArray(raw)) return raw.map((d) => String(d).trim()).filter(Boolean);
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed.map((d) => String(d).trim()).filter(Boolean);
    } catch {
      return raw.split(',').map((d) => d.trim()).filter(Boolean);
    }
  }
  return [];
}

function buildDisplayName(perfil) {
  const nombre = String(perfil?.nombre ?? '').trim();
  const apellido = String(perfil?.apellido ?? '').trim();
  const full = [nombre, apellido].filter(Boolean).join(' ');
  if (full) return full;
  const apodo = String(perfil?.apodo ?? '').trim();
  if (apodo) return apodo;
  return String(perfil?.username ?? '').trim() || 'Jugador';
}

const PERFIL_PUBLICO_COLUMNS = [
  'id',
  'user_id',
  'nombre',
  'apellido',
  'apodo',
  'username',
  'alias',
  'foto_url',
  'nivel',
  'lateralidad',
  'posicion_cancha',
  'pais',
  'email',
  'deportes',
].join(', ');

/** Diestro / Zurdo / Ambas — from mano_preferida or legacy lateralidad (Derecho). */
function mapManoPreferida(perfil) {
  const explicit = String(perfil?.mano_preferida ?? '').trim();
  if (explicit) {
    const key = explicit.toLowerCase();
    if (key === 'diestro' || key === 'derecho') return 'Diestro';
    if (key === 'zurdo') return 'Zurdo';
    if (key === 'ambas' || key === 'ambidiestro') return 'Ambas';
    return explicit;
  }

  const lat = String(perfil?.lateralidad ?? '').trim().toLowerCase();
  if (lat === 'diestro' || lat === 'derecho') return 'Diestro';
  if (lat === 'zurdo') return 'Zurdo';
  if (lat === 'ambas' || lat === 'ambidiestro') return 'Ambas';
  return null;
}

function mapPosicionCancha(perfil) {
  const raw = String(perfil?.posicion_cancha ?? '').trim();
  if (!raw) return null;
  const key = raw.toLowerCase();
  if (key === 'derecha') return 'Derecha';
  if (key === 'izquierda') return 'Izquierda';
  if (key === 'ambas' || key === 'ambos') return 'Ambas';
  return raw;
}

function posicionFinalLabel(posicion) {
  const n = Number(posicion);
  if (n === 1) return '1ro';
  if (n === 2) return '2do';
  if (n === 3) return '3ro';
  return 'Participante';
}

function partidoEquipoGanadorId(partido) {
  if (!partido || String(partido.estado || '').toLowerCase() !== 'finalizado' || !partido.resultado) {
    return null;
  }
  let res;
  try {
    res = typeof partido.resultado === 'string' ? JSON.parse(partido.resultado) : partido.resultado;
  } catch {
    return null;
  }
  const sets = [res?.set1, res?.set2, res?.set3].filter(Boolean);
  if (!sets.length) return null;
  let sgA = 0;
  let sgB = 0;
  for (const set of sets) {
    const parts = String(set).split('-').map((x) => Number(String(x).trim()));
    const a = parts[0];
    const b = parts[1];
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
    if (a > b) sgA += 1;
    else sgB += 1;
  }
  if (sgA === sgB) return null;
  return sgA > sgB ? partido.equipo_a_id : partido.equipo_b_id;
}

async function fetchPerfilPg(pgPool, identifier) {
  const parsed = parsePerfilPublicoIdentifier(identifier);
  if (!parsed || parsed.kind === 'email') return null;

  if (parsed.kind === 'user_id') {
    const { rows } = await pgPool.query(
      `SELECT ${PERFIL_PUBLICO_COLUMNS}
       FROM jugadores_perfil
       WHERE user_id = $1::uuid
       LIMIT 1`,
      [parsed.value],
    );
    console.log('[PERFIL-PUBLICO] query result rows:', rows?.length);
    return rows[0] ?? null;
  }

  if (parsed.kind === 'profile_id') {
    const { rows } = await pgPool.query(
      `SELECT ${PERFIL_PUBLICO_COLUMNS}
       FROM jugadores_perfil
       WHERE id::text = $1
       LIMIT 1`,
      [parsed.value],
    );
    return rows[0] ?? null;
  }

  const username = parsed.value.toLowerCase();
  const { rows } = await pgPool.query(
    `SELECT ${PERFIL_PUBLICO_COLUMNS}
     FROM jugadores_perfil
     WHERE lower(trim(username)) = $1
        OR lower(trim(apodo)) = $1
        OR lower(trim(alias)) = $1
     LIMIT 1`,
    [username],
  );
  return rows[0] ?? null;
}

async function fetchDeportesPg(pgPool, perfil) {
  const fromColumn = parseDeportesFromPerfil(perfil.deportes);
  if (fromColumn.length > 0) return fromColumn;

  if (!perfil.user_id) return [];

  const { rows } = await pgPool.query(
    `SELECT deporte FROM jugador_deportes WHERE user_id = $1::uuid ORDER BY deporte`,
    [String(perfil.user_id)],
  );
  const list = rows.map((r) => String(r.deporte || '').trim()).filter(Boolean);
  return list.length ? list : ['padbol'];
}

async function fetchEquiposDelJugadorPg(pgPool, perfil) {
  const userId = perfil.user_id ? String(perfil.user_id) : '';
  const email = String(perfil.email || '').trim().toLowerCase();

  const { rows } = await pgPool.query(
    `SELECT e.id, e.torneo_id, e.jugadores, e.nombre
     FROM equipos e
     WHERE e.jugadores IS NOT NULL
       AND EXISTS (
         SELECT 1
         FROM jsonb_array_elements(
           CASE
             WHEN jsonb_typeof(e.jugadores::jsonb) = 'array' THEN e.jugadores::jsonb
             ELSE '[]'::jsonb
           END
         ) AS elem
         WHERE ($1 <> '' AND elem->>'user_id' = $1)
            OR ($1 <> '' AND elem->>'id' = $1)
            OR ($2 <> '' AND lower(trim(elem->>'email')) = $2)
       )`,
    [userId, email],
  );
  return rows;
}

async function fetchTorneosStatsPg(pgPool, equipoIds) {
  if (!equipoIds.length) {
    return {
      torneos_jugados: 0,
      torneos_ganados: 0,
      partidos_jugados: 0,
      partidos_ganados: 0,
      historial_torneos: [],
    };
  }

  const { rows: torneoRows } = await pgPool.query(
    `SELECT DISTINCT ON (t.id)
            t.id AS torneo_id,
            t.nombre,
            t.deporte,
            t.estado,
            COALESCE(t.fecha_fin, t.fecha_inicio) AS fecha,
            s.nombre AS sede,
            e.id AS equipo_id,
            tp.posicion
     FROM equipos e
     JOIN torneos t ON t.id = e.torneo_id
     LEFT JOIN sedes s ON s.id = t.sede_id
     LEFT JOIN tabla_puntos tp ON tp.torneo_id = t.id AND tp.equipo_id = e.id
     WHERE e.id = ANY($1::bigint[])
     ORDER BY t.id, COALESCE(t.fecha_fin, t.fecha_inicio) DESC NULLS LAST`,
    [equipoIds],
  );

  const finalized = torneoRows.filter((t) => String(t.estado || '').toLowerCase() === 'finalizado');
  const torneos_jugados = finalized.length;
  const torneos_ganados = finalized.filter((t) => Number(t.posicion) === 1).length;

  const finalTorneoIds = finalized.map((t) => t.torneo_id);
  const equipoPorTorneo = new Map(finalized.map((t) => [Number(t.torneo_id), Number(t.equipo_id)]));

  let partidos_jugados = 0;
  let partidos_ganados = 0;

  if (finalTorneoIds.length > 0) {
    const { rows: partidos } = await pgPool.query(
      `SELECT id, torneo_id, estado, resultado, equipo_a_id, equipo_b_id
       FROM partidos
       WHERE torneo_id = ANY($1::int[])
         AND lower(trim(estado)) = 'finalizado'`,
      [finalTorneoIds],
    );

    for (const p of partidos) {
      const myEq = equipoPorTorneo.get(Number(p.torneo_id));
      if (!myEq) continue;
      if (Number(p.equipo_a_id) !== myEq && Number(p.equipo_b_id) !== myEq) continue;
      partidos_jugados += 1;
      const winId = partidoEquipoGanadorId(p);
      if (winId != null && Number(winId) === myEq) partidos_ganados += 1;
    }
  }

  const historialSorted = [...torneoRows].sort((a, b) => {
    const da = a.fecha ? new Date(a.fecha).getTime() : 0;
    const db = b.fecha ? new Date(b.fecha).getTime() : 0;
    return db - da;
  });

  const historial_torneos = historialSorted.slice(0, 10).map((t) => ({
    torneo_id: t.torneo_id,
    nombre: t.nombre ?? null,
    sede: t.sede ?? null,
    sede_nombre: t.sede ?? null,
    deporte: t.deporte ?? null,
    fecha: t.fecha ?? null,
    posicion_final: posicionFinalLabel(t.posicion),
    posicion: t.posicion != null ? Number(t.posicion) : null,
  }));

  const torneos_recientes = historial_torneos.slice(0, 5);

  return {
    torneos_jugados,
    torneos_ganados,
    partidos_jugados,
    partidos_ganados,
    historial_torneos,
    torneos_recientes: historial_torneos.slice(0, 5),
  };
}

export async function buildPublicPerfilPayloadPg(pgPool, identifier) {
  const perfil = await fetchPerfilPg(pgPool, identifier);
  if (!perfil) return null;

  const deportes = await fetchDeportesPg(pgPool, perfil);
  const equipos = await fetchEquiposDelJugadorPg(pgPool, perfil);
  const equipoIds = equipos.map((e) => Number(e.id)).filter(Number.isFinite);
  const stats = await fetchTorneosStatsPg(pgPool, equipoIds);

  return {
    user_id: perfil.user_id ?? null,
    display_name: buildDisplayName(perfil),
    nombre: perfil.nombre ?? null,
    apellido: perfil.apellido ?? null,
    apodo: perfil.apodo ?? null,
    nombre_saludo: perfil.nombre_saludo ?? null,
    username: perfil.username ?? perfil.alias ?? null,
    foto_url: perfil.foto_url ?? null,
    nivel: perfil.nivel ?? null,
    lateralidad: perfil.lateralidad ?? null,
    mano_preferida: mapManoPreferida(perfil),
    posicion_cancha: mapPosicionCancha(perfil),
    pais: perfil.pais ?? null,
    deportes,
    deporte_principal: deportes[0] ?? null,
    estadisticas: {
      torneos_jugados: stats.torneos_jugados,
      torneos_ganados: stats.torneos_ganados,
      partidos_jugados: stats.partidos_jugados,
      partidos_ganados: stats.partidos_ganados,
    },
    historial_torneos: stats.historial_torneos,
    torneos_recientes: stats.torneos_recientes ?? stats.historial_torneos?.slice(0, 5) ?? [],
    stats: {
      torneos: stats.torneos_jugados,
      torneos_ganados: stats.torneos_ganados,
      partidos_jugados: stats.partidos_jugados,
      victorias: stats.partidos_ganados,
    },
  };
}

function createPublicPerfilHandler(pgPool) {
  return async (req, res) => {
    try {
      const identifier = req.params.userId ?? req.params.user_id ?? req.params.identifier ?? '';
      if (!String(identifier).trim()) {
        return res.status(400).json({ error: 'Identificador de jugador requerido' });
      }

      const parsed = parsePerfilPublicoIdentifier(identifier);
      console.log('[PERFIL-PUBLICO] identifier parsed:', { kind: parsed?.kind ?? 'unknown' });

      if (parsed?.kind === 'email') {
        return res.status(404).json({ error: 'Perfil de jugador no encontrado' });
      }

      if (!pgPool) return pgUnavailable(res);

      const payload = await buildPublicPerfilPayloadPg(pgPool, identifier);
      if (!payload) {
        return res.status(404).json({ error: 'Perfil de jugador no encontrado' });
      }

      return res.json(payload);
    } catch (err) {
      console.error('❌ GET perfil público jugador:', err.message);
      return res.status(500).json({ error: err.message || 'Error al obtener perfil público' });
    }
  };
}

export function mountJugadorPerfilPublicoRoutes(app, { pgPool, jugadorRouter, usuariosRouter = null }) {
  const handler = createPublicPerfilHandler(pgPool);

  jugadorRouter.get('/perfil-publico/:userId', handler);
  app.get('/api/jugadores/perfil-publico/:user_id', handler);
  if (usuariosRouter) {
    usuariosRouter.get('/perfil-publico/:identifier', handler);
  }
}
