/**
 * GET /api/admin/torneos/resumen-stats — resumen batch para badges del panel.
 *
 * Consultas internas (constantes, no N+1):
 *  1. torneos (scoped)
 *  2. equipos de todos los torneo_id
 *  3. partidos de todos los torneo_id
 *  4. tabla_puntos (solo si hay torneos finalizados; ganador posicion=1)
 */

export const TORNEOS_RESUMEN_MAX_IDS = 200;
export const TORNEOS_RESUMEN_DEFAULT_LIMIT = 100;
export const TORNEOS_RESUMEN_MAX_LIMIT = 200;

const TORNEO_SELECT = 'id, sede_id, estado, tipo_torneo, nombre';
const EQUIPO_SELECT = 'id, torneo_id, nombre, estado, inscripcion_estado, status, grupo';
const PARTIDO_SELECT = 'id, torneo_id, estado, grupo';
const TABLA_PUNTOS_WINNER_SELECT = 'torneo_id, equipo_id, posicion';

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

/**
 * Scope admin para el resumen batch.
 * Alineado con requireAdminUser + resolveTorneoAdminAccess:
 * - super_admin: global (filtro sede_id opcional)
 * - admin_club: solo su sede (intersecta; no puede ampliar)
 * - admin_nacional / empleado / otros: 403 (sin alcance admin de torneos hoy)
 */
export function resolveTorneosResumenScope(role, requestedSedeId) {
  const rol = String(role?.rol || '').trim().toLowerCase();

  if (rol === 'super_admin') {
    return {
      ok: true,
      sedeId: requestedSedeId != null ? Number(requestedSedeId) : null,
      requireSede: false,
    };
  }

  if (rol === 'admin_club') {
    if (role.sede_id == null) {
      return { ok: false, status: 403, error: 'Tu cuenta de admin no tiene sede asignada' };
    }
    const own = Number(role.sede_id);
    if (requestedSedeId != null && Number(requestedSedeId) !== own) {
      return { ok: false, status: 403, error: 'No tenés permiso para operar torneos de otra sede' };
    }
    return { ok: true, sedeId: own, requireSede: true };
  }

  // admin_nacional, empleado y demás: alcance actual = sin admin de torneos.
  return { ok: false, status: 403, error: 'No tenés permiso para esta operación' };
}

/**
 * Parseo estricto de query. Rechaza ids inválidos y cantidades fuera de rango.
 *
 * @returns {{ sedeId: number|null, estado: string|null, torneoIds: number[]|null, limit: number }}
 */
export function parseTorneosResumenQuery(query = {}) {
  let sedeId = null;
  if (query.sede_id != null && String(query.sede_id).trim() !== '') {
    const n = Number.parseInt(String(query.sede_id).trim(), 10);
    if (!Number.isFinite(n) || n <= 0) {
      throw httpError(400, 'sede_id inválido');
    }
    sedeId = n;
  }

  let estado = null;
  if (query.estado != null && String(query.estado).trim() !== '') {
    estado = String(query.estado).trim().toLowerCase();
    if (!/^[a-z0-9_]{1,40}$/.test(estado)) {
      throw httpError(400, 'estado inválido');
    }
  }

  let torneoIds = null;
  if (query.torneo_ids != null && String(query.torneo_ids).trim() !== '') {
    const rawParts = String(query.torneo_ids)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (rawParts.length === 0) {
      throw httpError(400, 'torneo_ids inválidos');
    }
    if (rawParts.length > TORNEOS_RESUMEN_MAX_IDS) {
      throw httpError(400, `torneo_ids supera el máximo de ${TORNEOS_RESUMEN_MAX_IDS}`);
    }
    const seen = new Set();
    const ids = [];
    for (const part of rawParts) {
      const n = Number.parseInt(part, 10);
      // Solo enteros positivos en decimal (sin signos, sin decimales).
      if (!/^\d+$/.test(part) || !Number.isFinite(n) || n <= 0) {
        throw httpError(400, 'torneo_ids inválidos');
      }
      if (seen.has(n)) continue;
      seen.add(n);
      ids.push(n);
    }
    if (ids.length > TORNEOS_RESUMEN_MAX_IDS) {
      throw httpError(400, `torneo_ids supera el máximo de ${TORNEOS_RESUMEN_MAX_IDS}`);
    }
    torneoIds = ids;
  }

  let limit = TORNEOS_RESUMEN_DEFAULT_LIMIT;
  if (query.limit != null && String(query.limit).trim() !== '') {
    const n = Number.parseInt(String(query.limit).trim(), 10);
    if (!Number.isFinite(n) || n <= 0) {
      throw httpError(400, 'limit inválido');
    }
    if (n > TORNEOS_RESUMEN_MAX_LIMIT) {
      throw httpError(400, `limit supera el máximo de ${TORNEOS_RESUMEN_MAX_LIMIT}`);
    }
    limit = n;
  }

  return { sedeId, estado, torneoIds, limit };
}

/**
 * Misma normalización que resolveEquipoEstado (legacyPublic):
 * - vacío → confirmado
 * - contiene pend → pendiente
 * - confirm/inscript/activ → confirmado
 * - otro → se cuenta en equipos_count pero no como confirmado ni pendiente
 */
export function classifyEquipoInscripcionEstado(row) {
  const raw = String(row?.estado ?? row?.inscripcion_estado ?? row?.status ?? '')
    .trim()
    .toLowerCase();
  if (!raw) return 'confirmado';
  if (raw.includes('pend')) return 'pendiente';
  if (raw.includes('confirm') || raw.includes('inscript') || raw.includes('activ')) {
    return 'confirmado';
  }
  return 'otro';
}

/** Partido jugado: solo estado finalizado (criterio del panel / tabla). */
export function isPartidoJugado(row) {
  return String(row?.estado ?? '').trim().toLowerCase() === 'finalizado';
}

/**
 * Pendiente de jugar: no finalizado y no cancelado/suspendido.
 * No introduce empate.
 */
export function isPartidoPendiente(row) {
  const e = String(row?.estado ?? '').trim().toLowerCase();
  if (!e) return true;
  if (e === 'finalizado') return false;
  if (e === 'cancelado' || e === 'cancelada' || e === 'suspendido') return false;
  return true;
}

export function hasGrupoValue(value) {
  return value != null && String(value).trim() !== '';
}

/**
 * sorteo_realizado: hay al menos un partido generado (POST generar-partidos).
 * Criterio de producto actual — no existe columna dedicada.
 */
export function resolveSorteoRealizado(partidos) {
  return Array.isArray(partidos) && partidos.length > 0;
}

/**
 * tiene_grupos: hay asignación real de grupo en partidos o equipos.
 * (No se infiere solo por tipo_torneo.)
 */
export function resolveTieneGrupos(equipos, partidos) {
  if ((partidos || []).some((p) => hasGrupoValue(p?.grupo))) return true;
  if ((equipos || []).some((eq) => hasGrupoValue(eq?.grupo))) return true;
  return false;
}

export function buildEmptyTorneoResumenItem(torneoId) {
  return {
    torneo_id: String(torneoId),
    equipos_count: 0,
    equipos_confirmados: 0,
    equipos_pendientes: 0,
    partidos_total: 0,
    partidos_jugados: 0,
    partidos_pendientes: 0,
    tiene_grupos: false,
    sorteo_realizado: false,
    winner_equipo_id: null,
    winner_nombre: null,
  };
}

/**
 * Agrega un item de resumen a partir de filas ya cargadas (sin secretos ni planteles).
 */
export function aggregateTorneoResumenItem({
  torneoId,
  torneoEstado = null,
  equipos = [],
  partidos = [],
  winnerEquipoId = null,
  winnerNombre = null,
} = {}) {
  let confirmados = 0;
  let pendientes = 0;
  for (const eq of equipos) {
    const cls = classifyEquipoInscripcionEstado(eq);
    if (cls === 'confirmado') confirmados += 1;
    else if (cls === 'pendiente') pendientes += 1;
  }

  let jugados = 0;
  let pendientesPartidos = 0;
  for (const p of partidos) {
    if (isPartidoJugado(p)) jugados += 1;
    else if (isPartidoPendiente(p)) pendientesPartidos += 1;
  }

  const finalizado = String(torneoEstado ?? '').trim().toLowerCase() === 'finalizado';
  const winnerId = finalizado && winnerEquipoId != null ? String(winnerEquipoId) : null;
  const winnerName = winnerId != null && winnerNombre != null
    ? String(winnerNombre).trim() || null
    : null;

  return {
    torneo_id: String(torneoId),
    equipos_count: equipos.length,
    equipos_confirmados: confirmados,
    equipos_pendientes: pendientes,
    partidos_total: partidos.length,
    partidos_jugados: jugados,
    partidos_pendientes: pendientesPartidos,
    tiene_grupos: resolveTieneGrupos(equipos, partidos),
    sorteo_realizado: resolveSorteoRealizado(partidos),
    winner_equipo_id: winnerId,
    winner_nombre: winnerId ? winnerName : null,
  };
}

/**
 * Asserts that a resumen item never leaks private/full payloads.
 */
export function assertResumenItemIsMinimal(item) {
  const allowed = new Set([
    'torneo_id',
    'equipos_count',
    'equipos_confirmados',
    'equipos_pendientes',
    'partidos_total',
    'partidos_jugados',
    'partidos_pendientes',
    'tiene_grupos',
    'sorteo_realizado',
    'winner_equipo_id',
    'winner_nombre',
  ]);
  for (const key of Object.keys(item || {})) {
    if (!allowed.has(key)) {
      throw new Error(`Campo no permitido en resumen: ${key}`);
    }
  }
  const forbidden = ['email', 'telefono', 'jugadores', 'resultado', 'partidos', 'equipos', 'empate'];
  const serialized = JSON.stringify(item);
  for (const f of forbidden) {
    if (serialized.toLowerCase().includes(`"${f}"`)) {
      throw new Error(`Payload de resumen contiene dato prohibido: ${f}`);
    }
  }
  return true;
}

async function trackedQuery(tracker, label, run) {
  if (tracker) tracker.queries.push(label);
  return run();
}

/**
 * Carga batch de resumen. Cantidad de queries:
 * - 0 torneos → 1 (solo torneos)
 * - N torneos sin finalizados → 3
 * - N torneos con ≥1 finalizado → 4
 * Independiente de N (1, 10, 50, 200).
 */
export async function getTorneosResumenStats(supabaseAdmin, { role, query } = {}, options = {}) {
  if (!supabaseAdmin) throw httpError(500, 'supabaseAdmin requerido');

  const tracker = options.tracker || null;
  const parsed = parseTorneosResumenQuery(query || {});
  const scope = resolveTorneosResumenScope(role, parsed.sedeId);
  if (!scope.ok) {
    throw httpError(scope.status || 403, scope.error || 'No tenés permiso para esta operación');
  }

  let torneosQuery = supabaseAdmin
    .from('torneos')
    .select(TORNEO_SELECT)
    .order('id', { ascending: false })
    .limit(parsed.limit);

  if (scope.sedeId != null) {
    torneosQuery = torneosQuery.eq('sede_id', scope.sedeId);
  }
  if (parsed.estado) {
    torneosQuery = torneosQuery.eq('estado', parsed.estado);
  }
  if (parsed.torneoIds) {
    torneosQuery = torneosQuery.in('id', parsed.torneoIds);
  }

  const { data: torneosRaw, error: torneosErr } = await trackedQuery(
    tracker,
    'torneos',
    () => torneosQuery,
  );
  if (torneosErr) throw torneosErr;

  const torneos = Array.isArray(torneosRaw) ? torneosRaw : [];
  if (torneos.length === 0) {
    return {
      items: [],
      meta: {
        query_count: tracker ? tracker.queries.length : 1,
        torneos_count: 0,
      },
    };
  }

  // Defensa extra: nunca devolver torneos fuera de sede del admin_club.
  const scopedTorneos = torneos.filter((t) => {
    if (scope.requireSede) {
      return t.sede_id != null && Number(t.sede_id) === Number(scope.sedeId);
    }
    return true;
  });

  const torneoIds = scopedTorneos.map((t) => Number(t.id)).filter((n) => Number.isFinite(n));
  if (torneoIds.length === 0) {
    return {
      items: [],
      meta: {
        query_count: tracker ? tracker.queries.length : 1,
        torneos_count: 0,
      },
    };
  }

  const [{ data: equiposRaw, error: equiposErr }, { data: partidosRaw, error: partidosErr }] =
    await Promise.all([
      trackedQuery(tracker, 'equipos', () =>
        supabaseAdmin
          .from('equipos')
          .select(EQUIPO_SELECT)
          .in('torneo_id', torneoIds),
      ),
      trackedQuery(tracker, 'partidos', () =>
        supabaseAdmin
          .from('partidos')
          .select(PARTIDO_SELECT)
          .in('torneo_id', torneoIds),
      ),
    ]);

  if (equiposErr) throw equiposErr;
  if (partidosErr) throw partidosErr;

  const equipos = Array.isArray(equiposRaw) ? equiposRaw : [];
  const partidos = Array.isArray(partidosRaw) ? partidosRaw : [];

  const equiposByTorneo = new Map();
  const partidosByTorneo = new Map();
  for (const id of torneoIds) {
    equiposByTorneo.set(id, []);
    partidosByTorneo.set(id, []);
  }
  for (const eq of equipos) {
    const tid = Number(eq.torneo_id);
    if (!equiposByTorneo.has(tid)) continue;
    equiposByTorneo.get(tid).push(eq);
  }
  for (const p of partidos) {
    const tid = Number(p.torneo_id);
    if (!partidosByTorneo.has(tid)) continue;
    partidosByTorneo.get(tid).push(p);
  }

  const finalizadosIds = scopedTorneos
    .filter((t) => String(t.estado || '').trim().toLowerCase() === 'finalizado')
    .map((t) => Number(t.id));

  const winnerByTorneo = new Map();
  if (finalizadosIds.length > 0) {
    const { data: podioRaw, error: podioErr } = await trackedQuery(tracker, 'tabla_puntos', () =>
      supabaseAdmin
        .from('tabla_puntos')
        .select(TABLA_PUNTOS_WINNER_SELECT)
        .in('torneo_id', finalizadosIds)
        .eq('posicion', 1),
    );
    if (podioErr) throw podioErr;

    for (const row of podioRaw || []) {
      const tid = Number(row.torneo_id);
      const eid = row.equipo_id;
      if (!Number.isFinite(tid) || eid == null) continue;
      const eqs = equiposByTorneo.get(tid) || [];
      const found = eqs.find((e) => Number(e.id) === Number(eid));
      winnerByTorneo.set(tid, {
        equipoId: eid,
        nombre: found?.nombre != null ? String(found.nombre).trim() : null,
      });
    }
  }

  const items = scopedTorneos.map((t) => {
    const tid = Number(t.id);
    const winner = winnerByTorneo.get(tid) || null;
    return aggregateTorneoResumenItem({
      torneoId: tid,
      torneoEstado: t.estado,
      equipos: equiposByTorneo.get(tid) || [],
      partidos: partidosByTorneo.get(tid) || [],
      winnerEquipoId: winner?.equipoId ?? null,
      winnerNombre: winner?.nombre ?? null,
    });
  });

  return {
    items,
    meta: {
      query_count: tracker ? tracker.queries.length : (finalizadosIds.length > 0 ? 4 : 3),
      torneos_count: items.length,
    },
  };
}
