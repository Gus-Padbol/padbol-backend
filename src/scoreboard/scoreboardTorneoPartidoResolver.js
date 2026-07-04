const SCOREBOARD_TERMINADO_ESTADOS = new Set(['terminado', 'finalizado']);

export const SCOREBOARD_TORNEO_PARTIDO_RESOLVER_SELECT = [
  'id',
  'estado',
  'partido_torneo_id',
  'torneo_id',
  'sede_id',
  'cancha',
  'updated_at',
].join(', ');

function normalizeEstado(estado) {
  return String(estado ?? '').trim().toLowerCase();
}

export function isScoreboardTorneoPartidoActivo(estado) {
  return !SCOREBOARD_TERMINADO_ESTADOS.has(normalizeEstado(estado));
}

function parseTimestampMs(value) {
  if (value == null || value === '') return null;
  const ms = Date.parse(String(value));
  return Number.isFinite(ms) ? ms : null;
}

function compareUpdatedAtDesc(a, b) {
  const ta = parseTimestampMs(a.updated_at) ?? 0;
  const tb = parseTimestampMs(b.updated_at) ?? 0;
  if (ta !== tb) return tb - ta;
  return String(b.id ?? '').localeCompare(String(a.id ?? ''));
}

/**
 * Elige el scoreboard asociado a un partido de torneo entre candidatos con el mismo
 * partido_torneo_id. Preferencia: activo más reciente; si no hay, terminado más reciente.
 *
 * @returns {{ row: object | null, multipleActive: boolean }}
 */
export function pickScoreboardRowForTorneoPartido(candidates) {
  const rows = (candidates ?? []).filter((row) => row?.id != null);
  if (rows.length === 0) {
    return { row: null, multipleActive: false };
  }

  const activos = rows.filter((row) => isScoreboardTorneoPartidoActivo(row.estado));
  if (activos.length > 0) {
    const sorted = [...activos].sort(compareUpdatedAtDesc);
    return {
      row: sorted[0],
      multipleActive: activos.length > 1,
    };
  }

  const terminados = rows.filter((row) => !isScoreboardTorneoPartidoActivo(row.estado));
  if (terminados.length === 0) {
    return { row: null, multipleActive: false };
  }

  return {
    row: [...terminados].sort(compareUpdatedAtDesc)[0],
    multipleActive: false,
  };
}

export function normalizeResolvedScoreboardForTorneoPartido(row) {
  if (!row?.id) return null;

  return {
    scoreboard_id: String(row.id),
    scoreboard_estado: normalizeEstado(row.estado) || null,
    partido_torneo_id: Number(row.partido_torneo_id),
    torneo_id: row.torneo_id != null ? Number(row.torneo_id) : null,
    sede_id: row.sede_id != null ? Number(row.sede_id) : null,
    cancha: row.cancha != null ? String(row.cancha) : null,
    updated_at: row.updated_at ?? null,
  };
}

function parseTorneoPartidoId(partidoId) {
  const id = Number(partidoId);
  if (!Number.isFinite(id) || id <= 0) return null;
  return id;
}

/**
 * Resuelve el marcador (scoreboard UUID) vinculado a un partido de torneo (partidos.id).
 * Solo lectura; no modifica datos.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {number|string} partidoId
 * @param {{ onMultipleActive?: (partidoTorneoId: number, count: number) => void }} [options]
 * @returns {Promise<object | null>}
 */
export async function resolveScoreboardForTorneoPartido(supabase, partidoId, options = {}) {
  const tid = parseTorneoPartidoId(partidoId);
  if (tid == null) return null;

  const { data, error } = await supabase
    .from('scoreboard_partidos')
    .select(SCOREBOARD_TORNEO_PARTIDO_RESOLVER_SELECT)
    .eq('partido_torneo_id', tid);

  if (error) throw error;

  const { row, multipleActive } = pickScoreboardRowForTorneoPartido(data ?? []);
  if (multipleActive && typeof options.onMultipleActive === 'function') {
    options.onMultipleActive(tid, (data ?? []).filter((r) => isScoreboardTorneoPartidoActivo(r.estado)).length);
  }

  return normalizeResolvedScoreboardForTorneoPartido(row);
}

function parseTorneoPartidoIds(partidoIds) {
  return [...new Set(
    (partidoIds ?? [])
      .map((id) => Number(id))
      .filter((id) => Number.isFinite(id) && id > 0),
  )];
}

/**
 * Agrupa filas de scoreboard_partidos por partido_torneo_id y elige una por partido.
 *
 * @returns {Map<number, object>}
 */
export function buildScoreboardMapForTorneoPartidos(rows) {
  const byPartido = new Map();

  for (const row of rows ?? []) {
    const partidoTorneoId = Number(row?.partido_torneo_id);
    if (!Number.isFinite(partidoTorneoId) || partidoTorneoId <= 0) continue;
    if (!byPartido.has(partidoTorneoId)) byPartido.set(partidoTorneoId, []);
    byPartido.get(partidoTorneoId).push(row);
  }

  const result = new Map();
  for (const [partidoTorneoId, candidates] of byPartido) {
    const { row } = pickScoreboardRowForTorneoPartido(candidates);
    const normalized = normalizeResolvedScoreboardForTorneoPartido(row);
    if (normalized) result.set(partidoTorneoId, normalized);
  }

  return result;
}

/**
 * Resuelve marcadores para varios partidos de torneo en una sola consulta.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {Array<number|string>} partidoIds
 * @returns {Promise<Map<number, object>>}
 */
export async function resolveScoreboardsMapForTorneoPartidos(supabase, partidoIds) {
  const ids = parseTorneoPartidoIds(partidoIds);
  if (ids.length === 0) return new Map();

  const { data, error } = await supabase
    .from('scoreboard_partidos')
    .select(SCOREBOARD_TORNEO_PARTIDO_RESOLVER_SELECT)
    .in('partido_torneo_id', ids);

  if (error) throw error;

  return buildScoreboardMapForTorneoPartidos(data ?? []);
}
