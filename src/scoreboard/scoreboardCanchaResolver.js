const SCOREBOARD_TERMINADO_ESTADOS = new Set(['terminado', 'finalizado']);

/** Campos mínimos para elegir scoreboard por cancha. */
export const SCOREBOARD_CANCHA_RESOLVER_SELECT = [
  'id',
  'sede_id',
  'cancha',
  'estado',
  'partido_torneo_id',
  'equipo_a_nombre',
  'equipo_b_nombre',
  'created_at',
  'updated_at',
].join(', ');

function normalizeEstado(estado) {
  return String(estado ?? '').trim().toLowerCase();
}

export function isScoreboardCanchaEligible(estado) {
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
  return String(a.id ?? '').localeCompare(String(b.id ?? ''));
}

function compareCreatedAtAsc(a, b) {
  const ta = parseTimestampMs(a.created_at) ?? Number.MAX_SAFE_INTEGER;
  const tb = parseTimestampMs(b.created_at) ?? Number.MAX_SAFE_INTEGER;
  if (ta !== tb) return ta - tb;
  return String(a.id ?? '').localeCompare(String(b.id ?? ''));
}

function getPartidoFromMap(partidosById, partidoTorneoId) {
  const pid = Number(partidoTorneoId);
  if (!Number.isFinite(pid) || pid <= 0) return null;
  if (partidosById instanceof Map) return partidosById.get(pid) ?? null;
  return partidosById?.[pid] ?? null;
}

/**
 * Elige el scoreboard que debe mostrar la pantalla fija de una cancha.
 *
 * A) en_curso → updated_at DESC
 * B) pendiente + partido_torneo_id → fecha_hora en partidos (próxima futura o mínima pasada)
 * C) pendiente sin fecha_hora usable → created_at ASC
 * D) pendiente manual (sin partido_torneo_id) → updated_at DESC
 * E) null si no hay candidatos elegibles
 */
export function pickScoreboardForCancha(candidates, partidosById, now = new Date()) {
  const nowMs = now.getTime();
  const active = (candidates ?? []).filter((sb) => isScoreboardCanchaEligible(sb.estado));
  if (active.length === 0) return null;

  const enCurso = active.filter((sb) => normalizeEstado(sb.estado) === 'en_curso');
  if (enCurso.length > 0) {
    return [...enCurso].sort(compareUpdatedAtDesc)[0];
  }

  const pendientes = active.filter((sb) => normalizeEstado(sb.estado) === 'pendiente');
  const conTorneo = pendientes.filter((sb) => sb.partido_torneo_id != null && sb.partido_torneo_id !== '');
  const manuales = pendientes.filter((sb) => sb.partido_torneo_id == null || sb.partido_torneo_id === '');

  if (conTorneo.length > 0) {
    const conFecha = [];
    const sinFecha = [];

    for (const sb of conTorneo) {
      const partido = getPartidoFromMap(partidosById, sb.partido_torneo_id);
      const fechaMs = parseTimestampMs(partido?.fecha_hora);
      const pid = Number(sb.partido_torneo_id);
      if (fechaMs != null) {
        conFecha.push({ sb, fechaMs, pid });
      } else {
        sinFecha.push(sb);
      }
    }

    if (conFecha.length > 0) {
      const futuros = conFecha.filter((row) => row.fechaMs >= nowMs);
      const pool = futuros.length > 0 ? futuros : conFecha;
      pool.sort((a, b) => {
        if (a.fechaMs !== b.fechaMs) return a.fechaMs - b.fechaMs;
        return a.pid - b.pid;
      });
      return pool[0].sb;
    }

    if (sinFecha.length > 0) {
      return [...sinFecha].sort(compareCreatedAtAsc)[0];
    }
  }

  if (manuales.length > 0) {
    return [...manuales].sort(compareUpdatedAtDesc)[0];
  }

  return null;
}

export async function fetchPartidosMapByIds(supabaseAdmin, partidoTorneoIds) {
  const ids = [...new Set(
    (partidoTorneoIds ?? [])
      .map((raw) => Number(raw))
      .filter((n) => Number.isFinite(n) && n > 0),
  )];
  if (ids.length === 0) return new Map();

  const { data, error } = await supabaseAdmin
    .from('partidos')
    .select('id, fecha_hora, estado, cancha')
    .in('id', ids);

  if (error) throw error;
  return new Map((data ?? []).map((row) => [Number(row.id), row]));
}

export async function fetchActiveScoreboardsForCancha(supabaseAdmin, sedeId, cancha, selectColumns) {
  const { data, error } = await supabaseAdmin
    .from('scoreboard_partidos')
    .select(selectColumns)
    .eq('sede_id', sedeId)
    .eq('cancha', cancha)
    .not('estado', 'in', '(terminado,finalizado)');

  if (error) throw error;
  return data ?? [];
}

export async function resolveScoreboardForCancha(
  supabaseAdmin,
  sedeId,
  cancha,
  { select, now = new Date() } = {},
) {
  const selectColumns = select ?? SCOREBOARD_CANCHA_RESOLVER_SELECT;
  const candidates = await fetchActiveScoreboardsForCancha(
    supabaseAdmin,
    sedeId,
    cancha,
    selectColumns,
  );
  const partidoIds = candidates.map((row) => row.partido_torneo_id).filter(Boolean);
  const partidosById = await fetchPartidosMapByIds(supabaseAdmin, partidoIds);
  return pickScoreboardForCancha(candidates, partidosById, now);
}
