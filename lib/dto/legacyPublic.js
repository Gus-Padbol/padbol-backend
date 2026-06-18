/** DTOs mínimos para rutas legacy / listados públicos (sin PII ni secretos). */

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
].join(', ');

export const EQUIPO_TORNEO_PUBLIC_SELECT = [
  'id',
  'torneo_id',
  'nombre',
  'sede_id',
  'puntos_totales',
].join(', ');

export const PARTIDO_TORNEO_PUBLIC_SELECT = `
  id,
  torneo_id,
  fecha_hora,
  estado,
  grupo,
  resultado,
  equipo_a_id,
  equipo_b_id,
  equipo_a:equipos!equipo_a_id(nombre),
  equipo_b:equipos!equipo_b_id(nombre)
`;

export const PARTIDO_TORNEO_DETAIL_PUBLIC_SELECT = `
  id,
  torneo_id,
  fecha_hora,
  estado,
  grupo,
  resultado,
  equipo_a_id,
  equipo_b_id,
  equipo_a:equipos!equipo_a_id(nombre),
  equipo_b:equipos!equipo_b_id(nombre),
  games(id, partido_id, numero_game, equipo_a_score, equipo_b_score, estado)
`;

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
  };
}

export function mapEquipoTorneoPublicRow(row, grupo = null) {
  if (!row) return null;
  return {
    id: row.id,
    torneo_id: row.torneo_id ?? null,
    nombre: row.nombre ?? null,
    sede_id: row.sede_id ?? null,
    puntos_totales: row.puntos_totales ?? 0,
    grupo: grupo ?? row.grupo ?? null,
  };
}

export function mapPartidoTorneoPublicRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    torneo_id: row.torneo_id ?? null,
    fecha_hora: row.fecha_hora ?? null,
    estado: row.estado ?? null,
    grupo: row.grupo ?? null,
    resultado: row.resultado ?? null,
    equipo_a_id: row.equipo_a_id ?? null,
    equipo_b_id: row.equipo_b_id ?? null,
    equipo_a: row.equipo_a?.nombre ?? null,
    equipo_b: row.equipo_b?.nombre ?? null,
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
