/** DTOs para rutas legacy / listados públicos de torneos (compatibles con app nativa). */

export const JUGADOR_PUBLIC_SELECT = [
  'id',
  'nombre',
  'foto_url',
  'nacionalidad',
  'pierna_habil',
  'bio',
  'estado',
].join(', ');

export const TORNEO_PUBLIC_SELECT = [
  'id',
  'nombre',
  'sede_id',
  'nivel_torneo',
  'tipo_torneo',
  'estado',
  'fecha_inicio',
  'fecha_fin',
  'cantidad_equipos',
  'es_multisede',
  'categoria',
  'deporte',
].join(', ');

export const JUGADOR_TORNEO_PUBLIC_SELECT = [
  'id',
  'torneo_id',
  'nombre',
  'numero_camiseta',
  'es_capitan',
  'pais',
  'email',
].join(', ');

/** Lectura completa de equipos de torneo (service role). */
export const EQUIPO_TORNEO_PUBLIC_SELECT = '*';

export const PARTIDO_TORNEO_PUBLIC_SELECT = `
  *,
  equipo_a:equipos!equipo_a_id(id, nombre),
  equipo_b:equipos!equipo_b_id(id, nombre)
`;

export const PARTIDO_TORNEO_DETAIL_PUBLIC_SELECT = `
  *,
  equipo_a:equipos!equipo_a_id(id, nombre),
  equipo_b:equipos!equipo_b_id(id, nombre),
  games(id, partido_id, numero_game, equipo_a_score, equipo_b_score, estado)
`;

function safeJugadoresArray(raw) {
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

function unwrapResultadoJson(val, depth = 0) {
  if (val == null || depth > 4) return null;
  if (typeof val === 'string') {
    const t = val.trim();
    if (!t) return null;
    try {
      return unwrapResultadoJson(JSON.parse(t), depth + 1);
    } catch {
      return null;
    }
  }
  if (typeof val === 'object') return val;
  return null;
}

function parseSetGames(setStr) {
  const parts = String(setStr ?? '')
    .trim()
    .split(/[\s\-–—:]+/)
    .filter(Boolean);
  if (parts.length < 2) return null;
  const a = Number(parts[0]);
  const b = Number(parts[1]);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return { a, b };
}

/** Sets ganados por cada equipo (goles_a / goles_b en la app nativa). */
export function extractSetsGanadosFromResultado(resultado) {
  const res = unwrapResultadoJson(resultado);
  if (!res) return { goles_a: null, goles_b: null };

  if (res.goles_a != null && res.goles_b != null) {
    return {
      goles_a: Number(res.goles_a),
      goles_b: Number(res.goles_b),
    };
  }

  if (res.puntos_a != null && res.puntos_b != null) {
    return {
      goles_a: Number(res.puntos_a),
      goles_b: Number(res.puntos_b),
    };
  }

  let sgA = 0;
  let sgB = 0;
  let counted = 0;

  const setValues = Array.isArray(res.sets)
    ? res.sets
    : [res.set1, res.set2, res.set3, res.set_1, res.set_2, res.set_3].filter(Boolean);

  for (const raw of setValues) {
    const parsed = parseSetGames(
      typeof raw === 'object' && raw != null
        ? `${raw.a ?? raw.games_a ?? raw.local ?? 0}-${raw.b ?? raw.games_b ?? raw.visitante ?? 0}`
        : raw,
    );
    if (!parsed) continue;
    counted += 1;
    if (parsed.a > parsed.b) sgA += 1;
    else if (parsed.b > parsed.a) sgB += 1;
  }

  if (counted === 0) return { goles_a: null, goles_b: null };
  return { goles_a: sgA, goles_b: sgB };
}

export function splitFechaHoraPartido(row) {
  if (!row) return { fecha: null, hora: null };

  if (row.fecha) {
    const horaRaw = row.hora ?? row.hora_partido ?? null;
    return {
      fecha: String(row.fecha).slice(0, 10),
      hora: horaRaw != null ? String(horaRaw).slice(0, 5) : null,
    };
  }

  const fh = row.fecha_hora ?? row.fecha_partido ?? null;
  if (!fh) return { fecha: null, hora: null };

  const s = String(fh);
  if (s.includes('T')) {
    const [datePart, timePart] = s.split('T');
    return {
      fecha: datePart,
      hora: timePart ? timePart.slice(0, 5) : null,
    };
  }
  if (s.includes(' ')) {
    const [datePart, timePart] = s.split(' ');
    return {
      fecha: datePart,
      hora: timePart ? timePart.slice(0, 5) : null,
    };
  }
  return { fecha: s.slice(0, 10), hora: null };
}

function resolveCapitanNombre(jugadores, row) {
  const cap = jugadores.find((j) => j?.es_capitan === true || String(j?.rol ?? '').toLowerCase() === 'capitan');
  if (cap?.nombre) return String(cap.nombre).trim();
  if (row?.capitan_nombre) return String(row.capitan_nombre).trim();
  if (jugadores[0]?.nombre) return String(jugadores[0].nombre).trim();
  return null;
}

function resolveEquipoEstado(row) {
  const raw = String(row?.estado ?? row?.inscripcion_estado ?? row?.status ?? '').toLowerCase();
  if (!raw) return 'confirmado';
  if (raw.includes('pend')) return 'pendiente';
  if (raw.includes('confirm') || raw.includes('inscript') || raw.includes('activ')) return 'confirmado';
  return raw;
}

function mapEquipoRef(row, side) {
  const sideKey = side === 'a' ? 'a' : 'b';
  const id = row[`equipo_${sideKey}_id`] ?? null;
  const nested = row[`equipo_${sideKey}`];
  const nestedNombre = typeof nested === 'object' && nested != null ? nested.nombre : null;
  const flatNombre = row[`equipo_${sideKey}_nombre`] ?? null;
  const nombre = nestedNombre ?? flatNombre ?? `Equipo ${sideKey.toUpperCase()}`;
  const nestedId = typeof nested === 'object' && nested != null ? nested.id : null;
  return {
    id: id ?? nestedId ?? null,
    nombre,
  };
}

export function legacyWriteDisabled(res, endpoint) {
  return res.status(410).json({
    error: `Este endpoint legacy (${endpoint}) ya no está disponible. Usá las rutas actuales de la app.`,
    code: 'LEGACY_ENDPOINT_DISABLED',
  });
}

export function mapJugadorPublicRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    nombre: row.nombre ?? null,
    foto_url: row.foto_url ?? null,
    nacionalidad: row.nacionalidad ?? null,
    pierna_habil: row.pierna_habil ?? null,
    bio: row.bio ?? null,
    estado: row.estado ?? null,
  };
}

export function mapTorneoPublicRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    nombre: row.nombre ?? null,
    sede_id: row.sede_id ?? null,
    nivel_torneo: row.nivel_torneo ?? null,
    tipo_torneo: row.tipo_torneo ?? null,
    estado: row.estado ?? null,
    fecha_inicio: row.fecha_inicio ?? null,
    fecha_fin: row.fecha_fin ?? null,
    cantidad_equipos: row.cantidad_equipos ?? null,
    es_multisede: row.es_multisede ?? null,
    categoria: row.categoria ?? null,
    deporte: row.deporte ?? null,
  };
}

export function mapJugadorTorneoPublicRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    torneo_id: row.torneo_id ?? null,
    nombre: row.nombre ?? null,
    numero_camiseta: row.numero_camiseta ?? null,
    es_capitan: row.es_capitan ?? false,
    pais: row.pais ?? null,
    email: row.email ?? null,
    equipo_nombre: row.equipo_nombre ?? null,
  };
}

export function mapEquipoTorneoPublicRow(row, grupo = null, posicionFinal = null) {
  if (!row) return null;

  const jugadores = safeJugadoresArray(row.jugadores);
  const tipoEquipo =
    row.tipo_equipo != null && String(row.tipo_equipo).trim() !== ''
      ? row.tipo_equipo
      : row.tipo != null && String(row.tipo).trim() !== ''
        ? row.tipo
        : null;

  return {
    id: row.id,
    torneo_id: row.torneo_id ?? null,
    nombre: row.nombre ?? null,
    sede_id: row.sede_id ?? null,
    puntos_totales: row.puntos_totales ?? 0,
    puntos_ranking: row.puntos_ranking ?? null,
    grupo: grupo ?? row.grupo ?? null,
    jugadores,
    capitan_nombre: resolveCapitanNombre(jugadores, row),
    jugadores_count: jugadores.length,
    estado: resolveEquipoEstado(row),
    posicion_final: posicionFinal ?? row.posicion_final ?? row.posicion ?? null,
    tipo_equipo: tipoEquipo,
  };
}

export function mapPartidoTorneoPublicRow(row) {
  if (!row) return null;

  const equipoA = mapEquipoRef(row, 'a');
  const equipoB = mapEquipoRef(row, 'b');
  const { fecha, hora } = splitFechaHoraPartido(row);
  const { goles_a, goles_b } = extractSetsGanadosFromResultado(row.resultado);

  return {
    id: row.id,
    torneo_id: row.torneo_id ?? null,
    fecha_hora: row.fecha_hora ?? null,
    fecha,
    hora,
    estado: row.estado ?? null,
    grupo: row.grupo ?? null,
    ronda: row.ronda ?? row.round ?? row.fase ?? row.fase_torneo ?? null,
    fase: row.fase ?? row.fase_torneo ?? null,
    fase_torneo: row.fase_torneo ?? row.fase ?? null,
    resultado: row.resultado ?? null,
    goles_a,
    goles_b,
    equipo_a_id: row.equipo_a_id ?? equipoA.id ?? null,
    equipo_b_id: row.equipo_b_id ?? equipoB.id ?? null,
    equipo_a_nombre: equipoA.nombre,
    equipo_b_nombre: equipoB.nombre,
    equipo_a: equipoA,
    equipo_b: equipoB,
    sede_id: row.sede_id ?? null,
    games: Array.isArray(row.games)
      ? row.games.map((game) => ({
        id: game.id,
        numero_game: game.numero_game ?? null,
        equipo_a_score: game.equipo_a_score ?? null,
        equipo_b_score: game.equipo_b_score ?? null,
        estado: game.estado ?? null,
      }))
      : undefined,
  };
}

export function mapPartidoJugadorPublicSlot(jugador) {
  if (!jugador) return null;
  return {
    nombre: jugador.nombre ?? null,
    apodo: jugador.apodo ?? null,
    username: jugador.username ?? null,
    nombre_saludo: jugador.nombre_saludo ?? null,
    foto_url: jugador.foto_url ?? null,
    nivel: jugador.nivel ?? null,
  };
}

/** Oculta emails, user_ids, pago_url y reserva_id en listados públicos/semi-públicos. */
export function toPartidoPublicDto(full) {
  if (!full) return null;
  return {
    id: full.id,
    sede_id: full.sede_id,
    sede_nombre: full.sede_nombre,
    sede_direccion: full.sede_direccion,
    sede_ciudad: full.sede_ciudad,
    sede_pais: full.sede_pais,
    cancha: full.cancha,
    fecha: full.fecha,
    hora: full.hora,
    nivel: full.nivel,
    estado: full.estado,
    jugadores_actuales: full.jugadores_actuales,
    jugadores_count: full.jugadores_count,
    jugadores_necesarios: full.jugadores_necesarios,
    max_jugadores: full.max_jugadores,
    lugares_disponibles: full.lugares_disponibles,
    deadline_cancel: full.deadline_cancel,
    capitan_nombre: full.capitan_nombre,
    capitan_foto_url: full.capitan_foto_url,
    host_nombre: full.host_nombre,
    deporte: full.deporte,
    ganador: full.ganador,
    resultado: full.resultado,
    created_at: full.created_at,
    es_anfitrion: full.es_anfitrion,
    soy_participante: full.soy_participante,
    partidos_abiertos_jugadores: (full.partidos_abiertos_jugadores ?? [])
      .map(mapPartidoJugadorPublicSlot)
      .filter(Boolean),
  };
}
