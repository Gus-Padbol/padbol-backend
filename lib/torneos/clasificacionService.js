/**
 * Tabla live de torneos — calculada en lectura desde partidos finalizados.
 * resultado.goles_a / goles_b = nombre legacy interno; representa sets ganados.
 */

export const CRITERIOS_DESEMPATE = [
  'puntos',
  'diferencia_sets',
  'sets_favor',
  'diferencia_games',
  'games_favor',
  'equipo_nombre',
  'equipo_id',
];

// Criterios expuestos públicamente (los deportivos). `equipo_nombre`/`equipo_id`
// se mantienen como desempate final estable internamente en sortStandingsRows.
export const CRITERIOS_DESEMPATE_PUBLICOS = [
  'puntos',
  'diferencia_sets',
  'sets_favor',
  'diferencia_games',
  'games_favor',
];

const ESTADOS_EXCLUIDOS = new Set([
  'pendiente',
  'en_curso',
  'programado',
  'cancelado',
  'suspendido',
]);

const FASES_EXCLUIDAS_TABLA = new Set([
  'eliminatoria',
  'playoff',
  'final',
  'knockout',
]);

const RONDAS_ELIMINATORIA = new Set([
  'cuartos',
  'octavos',
  'dieciseisavos',
  'semifinal',
  'semifinales',
  'final',
  'tercer_puesto',
  'tercer puesto',
]);

const TIPOS_TABLA_GRUPOS = new Set(['grupos', 'grupos_knockout']);

function normalizeEstado(estado) {
  return String(estado ?? '').trim().toLowerCase();
}

function normalizeFase(fase) {
  return String(fase ?? '').trim().toLowerCase();
}

function normalizeRonda(ronda) {
  return String(ronda ?? '').trim().toLowerCase();
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

function parseSetGamesString(setStr) {
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

function collectLegacySetValues(res) {
  if (Array.isArray(res.sets)) return res.sets;
  return [res.set1, res.set2, res.set3, res.set_1, res.set_2, res.set_3].filter(Boolean);
}

function parseLegacySetsResultado(res) {
  const setValues = collectLegacySetValues(res);
  if (setValues.length === 0) return null;

  let setsA = 0;
  let setsB = 0;
  let gamesA = 0;
  let gamesB = 0;
  let parsedCount = 0;

  for (const raw of setValues) {
    const setStr = typeof raw === 'object' && raw != null
      ? `${raw.a ?? raw.games_a ?? raw.local ?? 0}-${raw.b ?? raw.games_b ?? raw.visitante ?? 0}`
      : raw;
    const parsed = parseSetGamesString(setStr);
    if (!parsed) continue;
    parsedCount += 1;
    gamesA += parsed.a;
    gamesB += parsed.b;
    if (parsed.a > parsed.b) setsA += 1;
    else if (parsed.b > parsed.a) setsB += 1;
  }

  if (parsedCount === 0) return null;
  return { sets_a: setsA, sets_b: setsB, games_a: gamesA, games_b: gamesB };
}

function parseLegacyGolesAsSets(res) {
  const legacyA = res.goles_a ?? res.puntos_a;
  const legacyB = res.goles_b ?? res.puntos_b;
  if (legacyA == null || legacyB == null) return null;
  const setsA = Number(legacyA);
  const setsB = Number(legacyB);
  if (!Number.isFinite(setsA) || !Number.isFinite(setsB)) return null;
  return {
    sets_a: setsA,
    sets_b: setsB,
    games_a: null,
    games_b: null,
  };
}

function resolveWinnerId(partido, setsA, setsB) {
  const eqA = partido?.equipo_a_id;
  const eqB = partido?.equipo_b_id;
  const ganador = partido?.ganador_equipo_id;

  if (ganador != null && (ganador === eqA || ganador === eqB)) {
    return ganador;
  }
  if (setsA > setsB) return eqA ?? null;
  if (setsB > setsA) return eqB ?? null;
  return null;
}

/**
 * @returns {null | {
 *   sets_a: number,
 *   sets_b: number,
 *   games_a: number | null,
 *   games_b: number | null,
 *   winner_id: number | null,
 *   source_format: 'legacy_goles_as_sets' | 'legacy_sets' | 'unknown'
 * }}
 */
export function parsePartidoResultado(partido) {
  const res = unwrapResultadoJson(partido?.resultado);
  if (!res) return null;

  let parsed = parseLegacyGolesAsSets(res);
  let sourceFormat = 'legacy_goles_as_sets';

  if (!parsed) {
    parsed = parseLegacySetsResultado(res);
    sourceFormat = 'legacy_sets';
  }

  if (!parsed) {
    return {
      sets_a: 0,
      sets_b: 0,
      games_a: null,
      games_b: null,
      winner_id: resolveWinnerId(partido, 0, 0),
      source_format: 'unknown',
    };
  }

  return {
    sets_a: parsed.sets_a,
    sets_b: parsed.sets_b,
    games_a: parsed.games_a,
    games_b: parsed.games_b,
    winner_id: resolveWinnerId(partido, parsed.sets_a, parsed.sets_b),
    source_format: sourceFormat,
  };
}

export function shouldPartidoImpactarTabla(partido, tipoTorneo) {
  const estado = normalizeEstado(partido?.estado);
  if (estado !== 'finalizado') return false;
  if (ESTADOS_EXCLUIDOS.has(estado)) return false;
  if (!partido?.resultado) return false;
  if (partido.equipo_a_id == null || partido.equipo_b_id == null) return false;

  const tipo = String(tipoTorneo ?? '').trim().toLowerCase();
  if (tipo === 'knockout') return false;

  if (partido.impacto_tabla === false) return false;
  if (partido.impacto_tabla === true) return true;

  const fase = normalizeFase(partido.fase);
  if (fase && FASES_EXCLUIDAS_TABLA.has(fase)) return false;
  if (partido.es_final === true) return false;

  const ronda = normalizeRonda(partido.ronda);
  if (ronda && RONDAS_ELIMINATORIA.has(ronda) && !partido.grupo && !fase) {
    return false;
  }

  if (tipo === 'liga_playoff') {
    if (fase && fase !== 'liga' && fase !== 'grupos') return false;
  }

  if (TIPOS_TABLA_GRUPOS.has(tipo)) {
    if (fase === 'liga') return false;
  }

  return true;
}

function createEmptyStats(equipo) {
  return {
    equipo_id: equipo.id,
    equipo_nombre: String(equipo.nombre ?? `Equipo ${equipo.id}`).trim(),
    grupo: null,
    jugados: 0,
    ganados: 0,
    perdidos: 0,
    empatados: 0,
    puntos: 0,
    sets_favor: 0,
    sets_contra: 0,
    diferencia_sets: 0,
    games_favor: null,
    games_contra: null,
    diferencia_games: null,
    partidos_finalizados: 0,
    _has_games: false,
  };
}

function applyPartidoToStats(stats, side, parsed) {
  const isA = side === 'A';
  const setsFavor = isA ? parsed.sets_a : parsed.sets_b;
  const setsContra = isA ? parsed.sets_b : parsed.sets_a;

  stats.jugados += 1;
  stats.partidos_finalizados += 1;
  stats.sets_favor += setsFavor;
  stats.sets_contra += setsContra;
  stats.diferencia_sets = stats.sets_favor - stats.sets_contra;

  if (parsed.games_a != null && parsed.games_b != null) {
    const gamesFavor = isA ? parsed.games_a : parsed.games_b;
    const gamesContra = isA ? parsed.games_b : parsed.games_a;
    stats.games_favor = (stats.games_favor ?? 0) + gamesFavor;
    stats.games_contra = (stats.games_contra ?? 0) + gamesContra;
    stats.diferencia_games = stats.games_favor - stats.games_contra;
    stats._has_games = true;
  }
}

function finalizeStatsRow(stats, posicion, tiebreak) {
  return {
    equipo_id: stats.equipo_id,
    equipo_nombre: stats.equipo_nombre,
    grupo: stats.grupo,
    posicion,
    jugados: stats.jugados,
    ganados: stats.ganados,
    perdidos: stats.perdidos,
    empatados: stats.empatados,
    puntos: stats.puntos,
    sets_favor: stats.sets_favor,
    sets_contra: stats.sets_contra,
    diferencia_sets: stats.diferencia_sets,
    games_favor: stats._has_games ? stats.games_favor : null,
    games_contra: stats._has_games ? stats.games_contra : null,
    diferencia_games: stats._has_games ? stats.diferencia_games : null,
    partidos_finalizados: stats.partidos_finalizados,
    tiebreak,
  };
}

function bucketAllHaveGames(rows) {
  return rows.length > 0 && rows.every((r) => r._has_games);
}

function compareStandingsRows(a, b, useGames) {
  if (b.puntos !== a.puntos) return b.puntos - a.puntos;
  if (b.diferencia_sets !== a.diferencia_sets) return b.diferencia_sets - a.diferencia_sets;
  if (b.sets_favor !== a.sets_favor) return b.sets_favor - a.sets_favor;

  if (useGames) {
    const diffGamesA = a.games_favor - a.games_contra;
    const diffGamesB = b.games_favor - b.games_contra;
    if (diffGamesB !== diffGamesA) return diffGamesB - diffGamesA;
    if (b.games_favor !== a.games_favor) return b.games_favor - a.games_favor;
  }

  const nameA = a.equipo_nombre.toLowerCase();
  const nameB = b.equipo_nombre.toLowerCase();
  if (nameA !== nameB) return nameA < nameB ? -1 : 1;
  return a.equipo_id - b.equipo_id;
}

function detectTiebreakCriterion(current, previous, useGames) {
  if (!previous) return { nivel: 0, detalle: 'puntos' };
  if (current.puntos !== previous.puntos) return { nivel: 0, detalle: 'puntos' };
  if (current.diferencia_sets !== previous.diferencia_sets) return { nivel: 1, detalle: 'diferencia_sets' };
  if (current.sets_favor !== previous.sets_favor) return { nivel: 2, detalle: 'sets_favor' };
  if (useGames) {
    const diffCur = (current.games_favor ?? 0) - (current.games_contra ?? 0);
    const diffPrev = (previous.games_favor ?? 0) - (previous.games_contra ?? 0);
    if (diffCur !== diffPrev) return { nivel: 3, detalle: 'diferencia_games' };
    if (current.games_favor !== previous.games_favor) return { nivel: 4, detalle: 'games_favor' };
  }
  if (current.equipo_nombre !== previous.equipo_nombre) return { nivel: 5, detalle: 'equipo_nombre' };
  return { nivel: 6, detalle: 'equipo_id' };
}

export function sortStandingsRows(rows) {
  const useGames = bucketAllHaveGames(rows);
  const sorted = [...rows].sort((a, b) => compareStandingsRows(a, b, useGames));

  let previous = null;
  return sorted.map((row, index) => {
    const tiebreak = detectTiebreakCriterion(row, previous, useGames);
    previous = row;
    return finalizeStatsRow(row, index + 1, tiebreak);
  });
}

function inferGrupoMap(partidos) {
  const map = {};
  for (const p of partidos) {
    const g = p?.grupo != null ? String(p.grupo).trim().toUpperCase() : null;
    if (!g) continue;
    if (p.equipo_a_id != null) map[p.equipo_a_id] = g;
    if (p.equipo_b_id != null) map[p.equipo_b_id] = g;
  }
  return map;
}

function partidoFechaEpoch(partido) {
  const t = partido?.fecha_hora ? Date.parse(partido.fecha_hora) : NaN;
  return Number.isFinite(t) ? t : null;
}

// Orden cronológico estable: por fecha_hora y, en su defecto, por id (más viejo primero).
function comparePartidosCronologico(a, b) {
  const fa = partidoFechaEpoch(a);
  const fb = partidoFechaEpoch(b);
  if (fa != null && fb != null && fa !== fb) return fa - fb;
  if (fa != null && fb == null) return -1;
  if (fa == null && fb != null) return 1;
  return Number(a?.id ?? 0) - Number(b?.id ?? 0);
}

// Racha reciente por equipo: 'G' ganó, 'P' perdió. Solo partidos que impactan tabla.
function buildUltimos5Map(partidos, tipo, mode) {
  const finalizados = [];
  for (const p of partidos || []) {
    if (!shouldPartidoImpactarTabla(p, tipo)) continue;
    if (mode === 'grupos') {
      const g = p.grupo != null ? String(p.grupo).trim() : '';
      if (!g) continue;
    }
    const parsed = parsePartidoResultado(p);
    if (!parsed || parsed.winner_id == null) continue;
    finalizados.push({ partido: p, winner: Number(parsed.winner_id) });
  }

  finalizados.sort((x, y) => comparePartidosCronologico(x.partido, y.partido));

  const map = new Map();
  const push = (equipoId, outcome) => {
    if (equipoId == null) return;
    const key = Number(equipoId);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(outcome);
  };

  for (const { partido: p, winner } of finalizados) {
    push(p.equipo_a_id, Number(p.equipo_a_id) === winner ? 'G' : 'P');
    push(p.equipo_b_id, Number(p.equipo_b_id) === winner ? 'G' : 'P');
  }
  return map;
}

// Adjunta ultimos_5 (del más viejo al más nuevo) a cada fila ya ordenada.
function attachUltimos5(rows, map) {
  return (rows || []).map((row) => ({
    ...row,
    ultimos_5: (map.get(Number(row.equipo_id)) ?? []).slice(-5),
  }));
}

function buildKnockoutEmptyMetadata(equipos, partidos) {
  const finalizados = (partidos || []).filter((p) => normalizeEstado(p.estado) === 'finalizado');
  return {
    partidos_considerados: 0,
    partidos_excluidos: finalizados.length,
    partidos_pendientes: (partidos || []).filter((p) => normalizeEstado(p.estado) !== 'finalizado').length,
    equipos_inscriptos: equipos.length,
    tabla_aplica: false,
    motivo: 'knockout_no_tiene_tabla_general',
    formato_resultado: {
      legacy_goles_as_sets: 0,
      legacy_sets: 0,
    },
  };
}

function applyScopeFilter({ general, grupos, scope, grupoFilter }) {
  let outGeneral = general;
  let outGrupos = grupos;

  if (scope === 'general') {
    outGrupos = {};
  } else if (scope === 'grupos') {
    outGeneral = [];
  }

  if (grupoFilter) {
    const key = grupoFilter.toUpperCase();
    outGrupos = Object.prototype.hasOwnProperty.call(outGrupos, key)
      ? { [key]: outGrupos[key] }
      : {};
  }

  return { general: outGeneral, grupos: outGrupos };
}

/**
 * @param {{
 *   equipos: Array<{ id: number, nombre?: string }>,
 *   partidos: Array<object>,
 *   tipoTorneo?: string | null,
 *   scope?: 'all' | 'general' | 'grupos',
 *   grupo?: string | null,
 * }} input
 */
export function buildClasificacion({
  equipos = [],
  partidos = [],
  tipoTorneo = null,
  scope = 'all',
  grupo = null,
}) {
  const tipo = String(tipoTorneo ?? '').trim().toLowerCase();

  if (tipo === 'knockout') {
    const metadata = buildKnockoutEmptyMetadata(equipos, partidos);
    const filtered = applyScopeFilter({ general: [], grupos: {}, scope, grupoFilter: grupo });
    return {
      metadata,
      general: filtered.general,
      grupos: filtered.grupos,
    };
  }

  const grupoMap = inferGrupoMap(partidos);
  const generalStats = new Map();
  const gruposStats = new Map();

  for (const eq of equipos) {
    const base = createEmptyStats(eq);
    generalStats.set(eq.id, { ...base });
    const g = grupoMap[eq.id] ?? null;
    if (g) {
      if (!gruposStats.has(g)) gruposStats.set(g, new Map());
      gruposStats.get(g).set(eq.id, { ...base, grupo: g });
    }
  }

  let partidosConsiderados = 0;
  let partidosExcluidos = 0;
  const formatoResultado = { legacy_goles_as_sets: 0, legacy_sets: 0 };

  const mode = TIPOS_TABLA_GRUPOS.has(tipo) ? 'grupos' : 'general';

  const applyToBucket = (statsMap, equipoId, side, isWinner, parsed, grupoLabel = null) => {
    if (!statsMap.has(equipoId)) {
      const eq = equipos.find((e) => e.id === equipoId);
      statsMap.set(equipoId, createEmptyStats(eq ?? { id: equipoId, nombre: `Equipo ${equipoId}` }));
    }
    const stats = statsMap.get(equipoId);
    if (grupoLabel) stats.grupo = grupoLabel;
    applyPartidoToStats(stats, side, parsed);
    if (isWinner) {
      stats.ganados += 1;
      stats.puntos += 3;
    } else {
      stats.perdidos += 1;
    }
  };

  for (const partido of partidos) {
    if (!shouldPartidoImpactarTabla(partido, tipo)) {
      if (normalizeEstado(partido.estado) === 'finalizado' && partido.resultado) {
        partidosExcluidos += 1;
      }
      continue;
    }

    const parsed = parsePartidoResultado(partido);
    if (!parsed || parsed.winner_id == null) continue;

    const partidoGrupo = partido.grupo != null
      ? String(partido.grupo).trim().toUpperCase()
      : null;

    if (mode === 'grupos' && !partidoGrupo) {
      partidosExcluidos += 1;
      continue;
    }

    partidosConsiderados += 1;
    if (parsed.source_format === 'legacy_goles_as_sets') {
      formatoResultado.legacy_goles_as_sets += 1;
    } else if (parsed.source_format === 'legacy_sets') {
      formatoResultado.legacy_sets += 1;
    }

    const winA = parsed.winner_id === partido.equipo_a_id;

    if (mode === 'general') {
      applyToBucket(generalStats, partido.equipo_a_id, 'A', winA, parsed);
      applyToBucket(generalStats, partido.equipo_b_id, 'B', !winA, parsed);
    } else {
      if (!gruposStats.has(partidoGrupo)) gruposStats.set(partidoGrupo, new Map());
      const bucket = gruposStats.get(partidoGrupo);
      applyToBucket(bucket, partido.equipo_a_id, 'A', winA, parsed, partidoGrupo);
      applyToBucket(bucket, partido.equipo_b_id, 'B', !winA, parsed, partidoGrupo);
    }
  }

  for (const eq of equipos) {
    if (!generalStats.has(eq.id)) {
      generalStats.set(eq.id, createEmptyStats(eq));
    }
    const g = grupoMap[eq.id];
    if (g) {
      if (!gruposStats.has(g)) gruposStats.set(g, new Map());
      if (!gruposStats.get(g).has(eq.id)) {
        gruposStats.get(g).set(eq.id, { ...createEmptyStats(eq), grupo: g });
      }
    }
  }

  const ultimos5Map = buildUltimos5Map(partidos, tipo, mode);

  const generalSorted = attachUltimos5(sortStandingsRows([...generalStats.values()]), ultimos5Map);
  const gruposSorted = {};
  for (const [grupoKey, map] of [...gruposStats.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    gruposSorted[grupoKey] = attachUltimos5(sortStandingsRows([...map.values()]), ultimos5Map);
  }

  const useGruposLayout = mode === 'grupos';
  const metadata = {
    partidos_considerados: partidosConsiderados,
    partidos_excluidos: partidosExcluidos,
    partidos_pendientes: (partidos || []).filter((p) => normalizeEstado(p.estado) !== 'finalizado').length,
    equipos_inscriptos: equipos.length,
    tabla_aplica: true,
    motivo: null,
    formato_resultado: formatoResultado,
  };

  const scoped = applyScopeFilter({
    general: useGruposLayout ? [] : generalSorted,
    grupos: useGruposLayout ? gruposSorted : {},
    scope,
    grupoFilter: grupo,
  });

  return {
    metadata,
    general: scoped.general,
    grupos: scoped.grupos,
  };
}

// Mapea una fila interna de standing al contrato público (pj/pg/pe/pp + ultimos_5).
// games_* y diferencia_games quedan null si no hay datos suficientes (legacy sets-as-goles).
function mapStandingRowToPublic(row) {
  return {
    posicion: row.posicion ?? null,
    equipo_id: row.equipo_id,
    equipo_nombre: row.equipo_nombre,
    grupo: row.grupo ?? null,
    pj: row.jugados ?? 0,
    pg: row.ganados ?? 0,
    pe: row.empatados ?? 0,
    pp: row.perdidos ?? 0,
    sets_favor: row.sets_favor ?? 0,
    sets_contra: row.sets_contra ?? 0,
    diferencia_sets: row.diferencia_sets ?? 0,
    games_favor: row.games_favor ?? null,
    games_contra: row.games_contra ?? null,
    diferencia_games: row.diferencia_games ?? null,
    puntos: row.puntos ?? 0,
    ultimos_5: Array.isArray(row.ultimos_5) ? row.ultimos_5 : [],
  };
}

/**
 * Contrato público de la tabla live para la app.
 * No cambia la estructura interna: mapea la salida de buildClasificacion.
 *
 * @param {{
 *   torneoId: number | string,
 *   tipoTorneo?: string | null,
 *   clasificacion: { metadata: object, general: Array, grupos: object },
 *   actualizadoAt?: string | null,
 * }} input
 */
export function buildTablaLivePublicResponse({
  torneoId,
  tipoTorneo = null,
  clasificacion,
  actualizadoAt = null,
}) {
  const tipo = tipoTorneo != null ? String(tipoTorneo) : null;
  const meta = clasificacion?.metadata ?? {};

  const grupos = {};
  for (const [key, rows] of Object.entries(clasificacion?.grupos ?? {})) {
    grupos[key] = (rows ?? []).map(mapStandingRowToPublic);
  }

  return {
    ok: true,
    torneo_id: Number(torneoId),
    tipo,
    tipo_torneo: tipo,
    general: (clasificacion?.general ?? []).map(mapStandingRowToPublic),
    grupos,
    metadata: {
      es_live: true,
      partidos_computados: meta.partidos_considerados ?? 0,
      actualizado_at: actualizadoAt ?? new Date().toISOString(),
      tabla_aplica: meta.tabla_aplica ?? null,
      partidos_pendientes: meta.partidos_pendientes ?? null,
      partidos_excluidos: meta.partidos_excluidos ?? null,
      equipos_inscriptos: meta.equipos_inscriptos ?? null,
      motivo: meta.motivo ?? null,
      formato_resultado: meta.formato_resultado ?? null,
    },
    criterios_desempate: CRITERIOS_DESEMPATE_PUBLICOS,
  };
}

function resolvePartidoWinnerId(partido) {
  const parsed = parsePartidoResultado(partido);
  if (parsed?.winner_id != null) return parsed.winner_id;
  const ganador = partido?.ganador_equipo_id;
  if (ganador === partido?.equipo_a_id || ganador === partido?.equipo_b_id) return ganador;
  return null;
}

function resolvePartidoLoserId(partido) {
  const winnerId = resolvePartidoWinnerId(partido);
  if (winnerId == null) return null;
  return winnerId === partido.equipo_a_id ? partido.equipo_b_id : partido.equipo_a_id;
}

export function partidoIsKnockoutStage(partido, tipoTorneo) {
  const tipo = String(tipoTorneo ?? '').trim().toLowerCase();
  if (normalizeEstado(partido?.estado) !== 'finalizado') return false;
  if (tipo === 'knockout') return true;
  if (partido.impacto_tabla === true) return false;
  if (partido.impacto_tabla === false) return true;

  const fase = normalizeFase(partido.fase);
  if (fase && FASES_EXCLUIDAS_TABLA.has(fase)) return true;
  if (partido.es_final === true) return true;

  const ronda = normalizeRonda(partido.ronda);
  if (ronda && RONDAS_ELIMINATORIA.has(ronda) && !partido.grupo && !fase) return true;
  return false;
}

function findFinalPartido(partidos) {
  const finished = (partidos || []).filter((p) => normalizeEstado(p.estado) === 'finalizado');
  const explicit = finished.find((p) => p.es_final === true)
    ?? finished.find((p) => normalizeFase(p.fase) === 'final')
    ?? finished.find((p) => normalizeRonda(p.ronda) === 'final');
  if (explicit) return explicit;
  if (finished.length === 1) return finished[0];
  return null;
}

function toRankingRow(equiposById, equipoId, tiebreakDetalle = 'knockout') {
  const eq = equiposById.get(equipoId) ?? { id: equipoId, nombre: `Equipo ${equipoId}` };
  return finalizeStatsRow(
    createEmptyStats(eq),
    0,
    { nivel: 0, detalle: tiebreakDetalle },
  );
}

/**
 * Orden de podio/ranking para fases eliminatorias: final → perdedores semifinal → perdedores cuartos → resto.
 */
export function buildKnockoutRankingRows(partidos, equipos = []) {
  const finished = (partidos || []).filter((p) => resolvePartidoWinnerId(p) != null);
  const equiposById = new Map((equipos || []).map((e) => [e.id, e]));
  const rankedIds = new Set();
  const rows = [];

  const add = (equipoId, detalle = 'knockout') => {
    if (equipoId == null || rankedIds.has(equipoId)) return;
    rankedIds.add(equipoId);
    rows.push(toRankingRow(equiposById, equipoId, detalle));
  };

  const finalP = findFinalPartido(finished);
  if (finalP) {
    add(resolvePartidoWinnerId(finalP), 'campeon');
    add(resolvePartidoLoserId(finalP), 'subcampeon');
  }

  const semiPartidos = finished
    .filter((p) => {
      const r = normalizeRonda(p.ronda);
      return r === 'semifinal' || r === 'semifinales';
    })
    .sort((a, b) => Number(a.id) - Number(b.id));

  for (const p of semiPartidos) {
    add(resolvePartidoLoserId(p), 'semifinal');
  }

  const cuartosPartidos = finished
    .filter((p) => normalizeRonda(p.ronda) === 'cuartos')
    .sort((a, b) => Number(a.id) - Number(b.id));

  for (const p of cuartosPartidos) {
    add(resolvePartidoLoserId(p), 'cuartos');
  }

  for (const eq of equipos || []) {
    add(eq.id, 'resto');
  }

  return rows.map((row, index) => ({ ...row, posicion: index + 1 }));
}

/** Aplana tablas por grupo (A, B, …) en un único array ordenado. */
export function flattenGruposRows(grupos = {}) {
  const out = [];
  for (const key of Object.keys(grupos).sort((a, b) => a.localeCompare(b))) {
    out.push(...(grupos[key] || []));
  }
  return out.map((row, index) => ({ ...row, posicion: index + 1 }));
}

/**
 * Ranking final para persistir en tabla_puntos — misma base que GET /tabla + podio eliminatorio.
 */
export function buildFinalRankingForTorneo({ equipos = [], partidos = [], tipoTorneo = null }) {
  const tipo = String(tipoTorneo ?? '').trim().toLowerCase();
  const clasificacion = buildClasificacion({
    equipos,
    partidos,
    tipoTorneo: tipo,
    scope: 'all',
  });

  if (tipo === 'knockout') {
    return {
      rankingRows: buildKnockoutRankingRows(partidos, equipos),
      source: 'knockout',
      clasificacion,
    };
  }

  if (tipo === 'grupos_knockout') {
    const elimPartidos = partidos.filter((p) => partidoIsKnockoutStage(p, tipo));
    const hasElimFinished = elimPartidos.some((p) => resolvePartidoWinnerId(p) != null);
    if (hasElimFinished) {
      const knockoutRows = buildKnockoutRankingRows(elimPartidos, equipos);
      const rankedIds = new Set(knockoutRows.map((r) => r.equipo_id));
      const rest = flattenGruposRows(clasificacion.grupos).filter((r) => !rankedIds.has(r.equipo_id));
      return {
        rankingRows: [...knockoutRows, ...rest],
        source: 'knockout_then_grupos',
        clasificacion,
      };
    }
    return {
      rankingRows: flattenGruposRows(clasificacion.grupos),
      source: 'grupos',
      clasificacion,
    };
  }

  if (TIPOS_TABLA_GRUPOS.has(tipo)) {
    return {
      rankingRows: flattenGruposRows(clasificacion.grupos),
      source: 'grupos',
      clasificacion,
    };
  }

  return {
    rankingRows: clasificacion.general,
    source: 'general',
    clasificacion,
  };
}

/**
 * Convierte filas de ranking en payload para tabla_puntos (FIPA).
 */
export function buildTablaPuntosFromRankingRows(rankingRows, { torneoId, basePoints = 10, posicionMult = [] }) {
  const tid = Number(torneoId);
  return (rankingRows || []).map((row, idx) => ({
    torneo_id: tid,
    equipo_id: row.equipo_id,
    posicion: idx + 1,
    puntos: Math.round(Number(basePoints) * (posicionMult[idx] ?? 0.05)),
  }));
}
