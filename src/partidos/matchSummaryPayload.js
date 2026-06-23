import {
  resolveEquiposPartido,
  resolveEquipoNombres,
  sortJugadoresRowsForEquipos,
} from './equiposService.js';
import { buildMatchSummaryDeterministicAnalysis } from './matchSummaryDeterministicAnalysis.js';

export const MATCH_SUMMARY_PAYLOAD_VERSION = '1.0.0';

const SCOREBOARD_TERMINADO_ESTADOS = new Set(['terminado', 'finalizado']);

const SCOREBOARD_SELECT = `
  id,
  estado,
  sets_a,
  sets_b,
  games_a,
  games_b,
  score_a,
  score_b,
  historial_sets,
  historial_puntos,
  cronometro_segundos,
  cronometro_inicio,
  cronometro_pausado,
  equipo_a_nombre,
  equipo_b_nombre,
  equipo_a_jugadores,
  equipo_b_jugadores,
  created_at,
  updated_at
`;

export class MatchSummaryPayloadError extends Error {
  constructor(message, { status = 422, code = 'MATCH_SUMMARY_PAYLOAD_ERROR' } = {}) {
    super(message);
    this.name = 'MatchSummaryPayloadError';
    this.status = status;
    this.code = code;
  }
}

function formatHora(hora) {
  if (!hora) return null;
  return String(hora).slice(0, 5);
}

function sanitizeDisplayName(value, fallback = 'Jugador') {
  if (value == null || typeof value !== 'string') return fallback;
  const cleaned = value.replace(/[\n\r\t<>]/g, '').trim();
  return cleaned.slice(0, 80) || fallback;
}

function resolveDisplayNameFromPerfil(perfil, email) {
  if (perfil) {
    const fromProfile =
      perfil.nombre_saludo
      ?? perfil.apodo
      ?? perfil.nombre
      ?? null;

    if (fromProfile && String(fromProfile).trim()) {
      return sanitizeDisplayName(String(fromProfile).trim());
    }
  }

  if (email && String(email).includes('@')) {
    const local = String(email).split('@')[0]?.trim();
    if (local) return sanitizeDisplayName(local);
  }

  return 'Jugador';
}

function inferGanadorFromScores(equipo1Score, equipo2Score) {
  if (!Number.isFinite(equipo1Score) || !Number.isFinite(equipo2Score)) return null;
  if (equipo1Score === equipo2Score) return null;
  return equipo1Score > equipo2Score ? 'equipo1' : 'equipo2';
}

function normalizeSetDetailRow(row) {
  if (!row || typeof row !== 'object') return null;

  const equipo1 = Number(row.equipo1 ?? row.eq1);
  const equipo2 = Number(row.equipo2 ?? row.eq2);

  if (!Number.isFinite(equipo1) || !Number.isFinite(equipo2)) return null;

  return { equipo1, equipo2 };
}

function buildMarcadorTextoSets(equipo1Sets, equipo2Sets, setsDetalle = []) {
  let text = `${equipo1Sets}-${equipo2Sets}`;

  const detalle = setsDetalle
    .map(normalizeSetDetailRow)
    .filter(Boolean);

  if (detalle.length > 0) {
    const fragmentos = detalle.map((set) => `${set.equipo1}-${set.equipo2}`);
    text += ` (${fragmentos.join(', ')})`;
  }

  return text;
}

function extractPuntosFromObject(source) {
  if (!source || typeof source !== 'object') return null;

  const equipo1 = Number(source.equipo1);
  const equipo2 = Number(source.equipo2);

  if (!Number.isFinite(equipo1) || !Number.isFinite(equipo2)) return null;
  if (equipo1 < 0 || equipo2 < 0) return null;

  return { equipo1, equipo2 };
}

function extractSetsFromObject(source) {
  if (!source || typeof source !== 'object') return null;

  const equipo1Sets = Number(source.equipo1_sets);
  const equipo2Sets = Number(source.equipo2_sets);

  if (!Number.isFinite(equipo1Sets) || !Number.isFinite(equipo2Sets)) return null;
  if (equipo1Sets < 0 || equipo2Sets < 0) return null;

  const setsDetalle = Array.isArray(source.sets_detalle)
    ? source.sets_detalle.map(normalizeSetDetailRow).filter(Boolean)
    : [];

  return {
    equipo1_sets: equipo1Sets,
    equipo2_sets: equipo2Sets,
    sets_detalle: setsDetalle,
  };
}

function extractPuntosFromCargas(resultadoJson) {
  const cargas = resultadoJson?.cargas;
  if (!cargas || typeof cargas !== 'object') return null;

  for (const carga of Object.values(cargas)) {
    const puntos = extractPuntosFromObject(carga);
    if (puntos) return puntos;
  }

  return null;
}

/**
 * Normaliza resultado de partido a formato explícito para Match Summary.
 * Acepta resultado suelto, resultado_json o merge { resultado, resultado_json, ganador }.
 *
 * @param {object} resultSource
 * @returns {{
 *   formato: 'puntos_agregados'|'sets'|'desconocido',
 *   ganador: 'equipo1'|'equipo2'|null,
 *   marcador_texto: string|null,
 *   puntos_agregados: { equipo1: number, equipo2: number }|null,
 *   sets: { equipo1_sets: number, equipo2_sets: number, sets_detalle: object[] }|null,
 *   fuente: 'dual_captain'|'sets_legacy_endpoint'|null,
 * }}
 */
export function normalizeMatchResult(resultSource = {}) {
  const resultado = resultSource?.resultado ?? resultSource;
  const resultadoJson = resultSource?.resultado_json ?? resultSource;
  const ganadorExplicito = resultSource?.ganador ?? null;

  const setsFromResultado = extractSetsFromObject(resultado);
  if (setsFromResultado) {
    const ganador = ganadorExplicito
      ?? inferGanadorFromScores(setsFromResultado.equipo1_sets, setsFromResultado.equipo2_sets);

    return {
      formato: 'sets',
      ganador,
      marcador_texto: buildMarcadorTextoSets(
        setsFromResultado.equipo1_sets,
        setsFromResultado.equipo2_sets,
        setsFromResultado.sets_detalle,
      ),
      puntos_agregados: null,
      sets: setsFromResultado,
      fuente: 'sets_legacy_endpoint',
    };
  }

  const setsFromJson = extractSetsFromObject(resultadoJson);
  if (setsFromJson) {
    const ganador = ganadorExplicito
      ?? inferGanadorFromScores(setsFromJson.equipo1_sets, setsFromJson.equipo2_sets);

    return {
      formato: 'sets',
      ganador,
      marcador_texto: buildMarcadorTextoSets(
        setsFromJson.equipo1_sets,
        setsFromJson.equipo2_sets,
        setsFromJson.sets_detalle,
      ),
      puntos_agregados: null,
      sets: setsFromJson,
      fuente: 'sets_legacy_endpoint',
    };
  }

  const puntosFromResultado = extractPuntosFromObject(resultado);
  if (puntosFromResultado) {
    const ganador = ganadorExplicito
      ?? inferGanadorFromScores(puntosFromResultado.equipo1, puntosFromResultado.equipo2);

    return {
      formato: 'puntos_agregados',
      ganador,
      marcador_texto: `${puntosFromResultado.equipo1}-${puntosFromResultado.equipo2}`,
      puntos_agregados: puntosFromResultado,
      sets: null,
      fuente: 'dual_captain',
    };
  }

  const puntosFromCargas = extractPuntosFromCargas(resultadoJson);
  if (puntosFromCargas) {
    const ganador = ganadorExplicito
      ?? inferGanadorFromScores(puntosFromCargas.equipo1, puntosFromCargas.equipo2);

    return {
      formato: 'puntos_agregados',
      ganador,
      marcador_texto: `${puntosFromCargas.equipo1}-${puntosFromCargas.equipo2}`,
      puntos_agregados: puntosFromCargas,
      sets: null,
      fuente: 'dual_captain',
    };
  }

  return {
    formato: 'desconocido',
    ganador: ganadorExplicito ?? null,
    marcador_texto: null,
    puntos_agregados: null,
    sets: null,
    fuente: null,
  };
}

/**
 * @param {object} payload
 * @returns {object}
 */
export function buildMatchSummaryDisclaimers(payload = {}) {
  const derivacion = payload?.equipos?.derivacion;

  return {
    basado_en_datos_cargados:
      'Resumen basado solo en datos cargados en Padbol Match.',
    sin_jugadas_ni_estadisticas:
      'No incluye jugadas ni estadísticas no registradas.',
    equipos_derivados:
      derivacion === 'capitan_manual'
        ? 'Los equipos fueron definidos por el capitán del partido.'
        : derivacion === 'sorteo'
          ? 'Los equipos se definieron por sorteo registrado en Padbol Match.'
          : derivacion === 'joined_at_split'
            ? 'Los equipos se armaron por orden de unión al partido; no hay asignación persistida.'
            : 'Los equipos provienen de los datos disponibles del partido.',
    resultado_cargado_por_capitanes:
      payload?.confirmacion?.estado === 'confirmado'
        ? 'Marcador confirmado por ambos capitanes en Padbol Match.'
        : 'Marcador sujeto a confirmación de capitanes.',
    datos_marcador: payload?.scoreboard_opcional
      ? 'El resumen puede usar datos del marcador registrados en el tanteador Padbol Match.'
      : 'No hay marcador vinculado registrado para este partido.',
  };
}

function parseJsonArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

function parseJsonValue(value) {
  if (value == null) return null;
  if (typeof value === 'object') return value;
  if (typeof value === 'string' && value.trim()) {
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  }
  return null;
}

export function computeDuracionAproximadaMinutos(cronometroSegundos) {
  if (cronometroSegundos == null || cronometroSegundos === '') {
    return null;
  }

  const seconds = Number(cronometroSegundos);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return null;
  }

  return Math.max(1, Math.round(seconds / 60));
}

export function pickBestScoreboardRow(rows = []) {
  if (!rows.length) return null;

  const sorted = [...rows].sort((a, b) => {
    const aTerminado = SCOREBOARD_TERMINADO_ESTADOS.has(String(a.estado ?? '').toLowerCase()) ? 0 : 1;
    const bTerminado = SCOREBOARD_TERMINADO_ESTADOS.has(String(b.estado ?? '').toLowerCase()) ? 0 : 1;
    if (aTerminado !== bTerminado) return aTerminado - bTerminado;

    const aUpdated = new Date(a.updated_at ?? 0).getTime();
    const bUpdated = new Date(b.updated_at ?? 0).getTime();
    if (aUpdated !== bUpdated) return bUpdated - aUpdated;

    const aCreated = new Date(a.created_at ?? 0).getTime();
    const bCreated = new Date(b.created_at ?? 0).getTime();
    return bCreated - aCreated;
  });

  return sorted[0] ?? null;
}

async function fetchScoreboardRowsByLink(pgPool, column, value) {
  if (value == null || value === '') return [];

  const sqlByColumn = {
    partido_abierto_id: `
      SELECT ${SCOREBOARD_SELECT}
      FROM scoreboard_partidos
      WHERE partido_abierto_id = $1
    `,
    reserva_id: `
      SELECT ${SCOREBOARD_SELECT}
      FROM scoreboard_partidos
      WHERE reserva_id = $1
    `,
  };

  const sql = sqlByColumn[column];
  if (!sql) return [];

  const { rows } = await pgPool.query(sql, [value]);
  return rows ?? [];
}

async function fetchHistorialPuntosCount(pgPool, scoreboardId) {
  if (!scoreboardId) return 0;

  const { rows } = await pgPool.query(
    `SELECT COUNT(*)::int AS total
     FROM scoreboard_historial_puntos
     WHERE partido_id = $1`,
    [scoreboardId],
  );

  return Number(rows?.[0]?.total) || 0;
}

export function buildScoreboardOpcional(scoreboardRow, historialPuntosCount = 0) {
  if (!scoreboardRow) return null;

  const historialPuntosJson = parseJsonArray(scoreboardRow.historial_puntos);
  const duracionAproximadaMinutos = computeDuracionAproximadaMinutos(
    scoreboardRow.cronometro_segundos,
  );

  return {
    scoreboard_id: scoreboardRow.id,
    estado: scoreboardRow.estado ?? null,
    sets_a: Number(scoreboardRow.sets_a) || 0,
    sets_b: Number(scoreboardRow.sets_b) || 0,
    games_a: Number(scoreboardRow.games_a) || 0,
    games_b: Number(scoreboardRow.games_b) || 0,
    score_a: Number(scoreboardRow.score_a) || 0,
    score_b: Number(scoreboardRow.score_b) || 0,
    historial_sets: parseJsonArray(scoreboardRow.historial_sets),
    historial_puntos_resumen: {
      registros_tabla: historialPuntosCount,
      snapshots_json: historialPuntosJson.length,
    },
    cronometro_segundos:
      scoreboardRow.cronometro_segundos == null
        ? null
        : Number(scoreboardRow.cronometro_segundos) || 0,
    duracion_aproximada_minutos: duracionAproximadaMinutos,
    equipo_a_nombre: scoreboardRow.equipo_a_nombre ?? null,
    equipo_b_nombre: scoreboardRow.equipo_b_nombre ?? null,
    equipo_a_jugadores: parseJsonValue(scoreboardRow.equipo_a_jugadores) ?? [],
    equipo_b_jugadores: parseJsonValue(scoreboardRow.equipo_b_jugadores) ?? [],
  };
}

export async function fetchLinkedScoreboard(pgPool, { partidoId, reservaId }) {
  const byPartido = await fetchScoreboardRowsByLink(pgPool, 'partido_abierto_id', partidoId);
  const selectedByPartido = pickBestScoreboardRow(byPartido);
  if (selectedByPartido) return selectedByPartido;

  if (!reservaId) return null;

  const byReserva = await fetchScoreboardRowsByLink(pgPool, 'reserva_id', reservaId);
  return pickBestScoreboardRow(byReserva);
}

function buildEquipoJugador(row, perfil, capitanUserId) {
  const userId = row.user_id ?? null;

  return {
    user_id: userId,
    nombre_display: resolveDisplayNameFromPerfil(perfil, row.email),
    nivel: perfil?.nivel ?? null,
    es_capitan: Boolean(userId && capitanUserId && String(userId) === String(capitanUserId)),
  };
}

async function fetchPartidoById(pgPool, partidoId) {
  const { rows } = await pgPool.query(
    `SELECT
      pa.id,
      pa.sede_id,
      pa.sede_nombre,
      pa.cancha,
      pa.reserva_id,
      pa.capitan_user_id,
      pa.capitan_email,
      pa.capitan_nombre,
      pa.fecha,
      pa.hora,
      pa.nivel,
      pa.estado,
      pa.ganador,
      pa.resultado,
      pa.resultado_json,
      pa.deporte,
      pa.equipos_asignacion,
      pa.jugadores_requeridos,
      s.nombre AS sede_nombre_join,
      s.ciudad AS sede_ciudad
    FROM partidos_abiertos pa
    LEFT JOIN sedes s ON s.id = pa.sede_id
    WHERE pa.id = $1
    LIMIT 1`,
    [partidoId],
  );

  return rows[0] ?? null;
}

async function fetchJugadoresByPartidoId(pgPool, partidoId) {
  const { rows } = await pgPool.query(
    `SELECT user_id, email, joined_at
     FROM partidos_abiertos_jugadores
     WHERE partido_id = $1
     ORDER BY joined_at ASC`,
    [partidoId],
  );

  return rows ?? [];
}

async function fetchPerfilesByUserIds(pgPool, userIds) {
  const uniqueIds = [...new Set((userIds ?? []).filter(Boolean))];
  if (uniqueIds.length === 0) return {};

  const { rows } = await pgPool.query(
    `SELECT user_id, nombre, nombre_saludo, apodo, email, nivel, liga, xp
     FROM jugadores_perfil
     WHERE user_id = ANY($1::uuid[])`,
    [uniqueIds],
  );

  return Object.fromEntries((rows ?? []).map((row) => [row.user_id, row]));
}

async function fetchXpForPartido(pgPool, partidoId) {
  const referencia = String(partidoId);

  const { rows } = await pgPool.query(
    `SELECT user_id, tipo, xp, liga_despues
     FROM xp_transacciones
     WHERE referencia_id = $1
     ORDER BY created_at ASC`,
    [referencia],
  );

  if (!rows?.length) return null;

  const tipos = [...new Set(rows.map((row) => row.tipo).filter(Boolean))];
  const ligaPorJugadorMap = new Map();

  for (const row of rows) {
    if (row.user_id && row.liga_despues) {
      ligaPorJugadorMap.set(String(row.user_id), row.liga_despues);
    }
  }

  return {
    xp_otorgado_partido: true,
    tipos,
    liga_por_jugador: [...ligaPorJugadorMap.entries()].map(([user_id, liga]) => ({
      user_id,
      liga,
    })),
  };
}

function userIsParticipant(userId, partido, jugadoresRows) {
  if (!userId) return false;

  if (partido.capitan_user_id && String(partido.capitan_user_id) === String(userId)) {
    return true;
  }

  return (jugadoresRows ?? []).some(
    (row) => row.user_id && String(row.user_id) === String(userId),
  );
}

function assertPayloadPreconditions(partido) {
  if (!partido) {
    throw new MatchSummaryPayloadError('Partido no encontrado', {
      status: 404,
      code: 'PARTIDO_NOT_FOUND',
    });
  }

  const estadoConfirmacion = partido.resultado_json?.estado_confirmacion ?? null;

  if (estadoConfirmacion === 'en_disputa' || partido.estado === 'en_disputa') {
    throw new MatchSummaryPayloadError('El partido está en disputa', {
      status: 409,
      code: 'PARTIDO_EN_DISPUTA',
    });
  }

  if (partido.estado !== 'finalizado') {
    throw new MatchSummaryPayloadError('El partido no está finalizado', {
      status: 409,
      code: 'PARTIDO_NO_FINALIZADO',
    });
  }

  if (estadoConfirmacion && estadoConfirmacion !== 'confirmado') {
    throw new MatchSummaryPayloadError('El resultado no está confirmado', {
      status: 409,
      code: 'RESULTADO_NO_CONFIRMADO',
    });
  }

  if (!partido.resultado && !partido.resultado_json?.cargas) {
    throw new MatchSummaryPayloadError('Datos insuficientes para generar resumen', {
      status: 422,
      code: 'DATOS_INSUFICIENTES',
    });
  }
}

/**
 * Construye payload determinístico para Match Summary IA v1.
 *
 * @param {{ partidoId: number|string, userId?: string|null, pgPool: import('pg').Pool }} params
 * @returns {Promise<object>}
 */
export async function buildMatchSummaryPayload({ partidoId, userId = null, pgPool }) {
  if (!pgPool) {
    throw new MatchSummaryPayloadError('pgPool no disponible', {
      status: 503,
      code: 'PG_POOL_UNAVAILABLE',
    });
  }

  const parsedPartidoId = parseInt(String(partidoId), 10);
  if (!Number.isFinite(parsedPartidoId) || parsedPartidoId <= 0) {
    throw new MatchSummaryPayloadError('ID de partido inválido', {
      status: 400,
      code: 'PARTIDO_ID_INVALIDO',
    });
  }

  const partido = await fetchPartidoById(pgPool, parsedPartidoId);
  assertPayloadPreconditions(partido);

  const jugadoresRowsRaw = await fetchJugadoresByPartidoId(pgPool, parsedPartidoId);

  if (userId && !userIsParticipant(userId, partido, jugadoresRowsRaw)) {
    throw new MatchSummaryPayloadError('No tenés acceso a este partido', {
      status: 403,
      code: 'PARTIDO_ACCESS_DENIED',
    });
  }

  const capitanUserId = partido.capitan_user_id ?? null;
  const jugadoresRows = sortJugadoresRowsForEquipos(
    jugadoresRowsRaw,
    capitanUserId,
    partido.capitan_email ?? null,
  );

  const equiposResueltos = resolveEquiposPartido({
    jugadoresRows,
    capitanUserId,
    capitanEmail: partido.capitan_email ?? null,
    equiposAsignacion: partido.equipos_asignacion ?? null,
    jugadoresRequeridos: partido.jugadores_requeridos ?? 4,
  });

  const capitanEquipo2 = equiposResueltos.equipo2Rows[0]?.user_id ?? null;
  const capitanes = {
    capitan1: capitanUserId ?? null,
    capitan2: capitanEquipo2,
    capitanes: [capitanUserId, capitanEquipo2].filter(Boolean),
  };

  const perfilByUserId = await fetchPerfilesByUserIds(
    pgPool,
    jugadoresRows.map((row) => row.user_id).filter(Boolean),
  );

  const buildEquipoJugadores = (rows, capitanId) => rows.map((row) => {
    const perfil = row.user_id ? perfilByUserId[row.user_id] ?? null : null;
    const jugador = buildEquipoJugador(row, perfil, capitanUserId);
    return {
      ...jugador,
      es_capitan:
        String(jugador.user_id) === String(capitanUserId)
        || String(jugador.user_id) === String(capitanId),
    };
  });

  const equipo1Jugadores = buildEquipoJugadores(
    equiposResueltos.equipo1Rows,
    capitanes.capitan1,
  );
  const equipo2Jugadores = buildEquipoJugadores(
    equiposResueltos.equipo2Rows,
    capitanes.capitan2,
  );

  const resultado = normalizeMatchResult({
    resultado: partido.resultado,
    resultado_json: partido.resultado_json,
    ganador: partido.ganador,
  });

  if (resultado.formato === 'desconocido') {
    throw new MatchSummaryPayloadError('Datos insuficientes para normalizar resultado', {
      status: 422,
      code: 'RESULTADO_DESCONOCIDO',
    });
  }

  const xpOpcional = await fetchXpForPartido(pgPool, parsedPartidoId).catch(() => null);

  const linkedScoreboard = await fetchLinkedScoreboard(pgPool, {
    partidoId: parsedPartidoId,
    reservaId: partido.reserva_id ?? null,
  }).catch(() => null);

  const historialPuntosCount = linkedScoreboard
    ? await fetchHistorialPuntosCount(pgPool, linkedScoreboard.id).catch(() => 0)
    : 0;

  const scoreboardOpcional = buildScoreboardOpcional(linkedScoreboard, historialPuntosCount);

  const equipoNombres = resolveEquipoNombres(partido.equipos_asignacion);

  const payload = {
    schema_version: MATCH_SUMMARY_PAYLOAD_VERSION,
    partido_id: parsedPartidoId,
    contexto: {
      deporte: partido.deporte ?? 'padbol',
      sede_id: partido.sede_id ?? null,
      sede_nombre: partido.sede_nombre ?? partido.sede_nombre_join ?? null,
      sede_ciudad: partido.sede_ciudad ?? null,
      cancha: partido.cancha ?? null,
      fecha: partido.fecha ?? null,
      hora: formatHora(partido.hora),
      nivel: partido.nivel ?? null,
      reserva_id: partido.reserva_id ?? null,
    },
    equipos: {
      derivacion: equiposResueltos.derivacion,
      equipo1: { nombre: equipoNombres.equipo1_nombre, jugadores: equipo1Jugadores },
      equipo2: { nombre: equipoNombres.equipo2_nombre, jugadores: equipo2Jugadores },
    },
    resultado,
    confirmacion: {
      estado: partido.resultado_json?.estado_confirmacion ?? 'confirmado',
      confirmado_at: partido.resultado_json?.confirmado_at ?? null,
      capitanes_user_ids: capitanes.capitanes,
    },
    xp_opcional: xpOpcional,
    scoreboard_opcional: scoreboardOpcional,
    disclaimers: null,
  };

  payload.disclaimers = buildMatchSummaryDisclaimers(payload);
  payload.analisis_previo = buildMatchSummaryDeterministicAnalysis(payload);

  return payload;
}
