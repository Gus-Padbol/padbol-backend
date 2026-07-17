/**
 * Historial unificado del jugador — adapters de lectura + merge (FASE 1 + FASE 2 + FASE 3).
 * No modifica reglas de negocio de módulos cerrados.
 */

import {
  JUGADOR_HISTORIAL_SOURCE_LIMIT,
  combineFechaHora,
  decodeHistorialCursor,
  equipoJsonIncludesUser,
  filterHistorialEvents,
  httpError,
  normalizeLogroEvent,
  normalizeMembresiaEvent,
  normalizePadcoinsEvent,
  normalizePartidoEvent,
  normalizeReservaEvent,
  normalizeTorneoEvent,
  paginateHistorialEvents,
  parseHistorialIsoDate,
  parseHistorialLimit,
  parseHistorialSedeId,
  parseHistorialTipos,
  tryNormalizeAsistenciaEvent,
  tryNormalizeRankingCasualEvent,
  tryNormalizeResultadoCasual,
  tryNormalizeResultadoTorneo,
} from './jugadorHistorialDomain.js';

const RESERVA_HISTORIAL_SELECT =
  'id, sede, sede_id, fecha, hora, hora_inicio, cancha, estado, created_at';

const PARTIDO_HISTORIAL_SELECT =
  'id, sede_id, sede_nombre, fecha, hora, nivel, estado, deporte, created_at, capitan_user_id';

const PADCOINS_HISTORIAL_SELECT =
  'id, tipo, monto, sede_id, referencia_tipo, referencia_id, created_at, saldo_despues';

const MEMBRESIA_HISTORIAL_SELECT =
  'id, sede_id, plan_id, estado, origen, inicio, vencimiento, created_at';

const LOGRO_HISTORIAL_SELECT =
  'id, slug, logro_id, desbloqueado_en, created_at, contexto';

const PARTIDO_RESULTADO_SELECT = [
  'id',
  'sede_id',
  'sede_nombre',
  'fecha',
  'hora',
  'estado',
  'deporte',
  'ganador',
  'resultado',
  'resultado_json',
  'created_at',
  'capitan_user_id',
].join(', ');

/** Columnas reales de `partidos` en prod (sin ganador_equipo_id / fecha sueltas). */
const PARTIDO_TORNEO_RESULTADO_SELECT = [
  'id',
  'torneo_id',
  'estado',
  'resultado',
  'equipo_a_id',
  'equipo_b_id',
  'fecha_hora',
  'sede_id',
  'ronda',
  'created_at',
  'updated_at',
].join(', ');

const RANKING_CASUAL_SELECT = [
  'id',
  'user_id',
  'match_id',
  'match_type',
  'reward_type',
  'amount',
  'status',
  'created_at',
  'updated_at',
  'metadata',
].join(', ');

const ASISTENCIA_SELECT = [
  'id',
  'user_id',
  'match_id',
  'match_type',
  'attendance_status',
  'attendance_confirmed_at',
  'attendance_responded_at',
  'attendance_response_source',
  'created_at',
  'updated_at',
].join(', ');

function buildUserEmailOrIdFilters(user) {
  const filters = [];
  if (user?.email) {
    filters.push(`email.eq."${String(user.email).replace(/"/g, '\\"')}"`);
  }
  if (user?.id) {
    filters.push(`user_id.eq.${user.id}`);
  }
  return filters;
}

function sourceLimitFor(limit) {
  return Math.min(
    JUGADOR_HISTORIAL_SOURCE_LIMIT,
    Math.max(limit * 3, 40),
  );
}

function isMissingTableError(error) {
  const message = String(error?.message || error?.details || error || '');
  return (
    error?.code === 'PGRST205'
    || error?.code === '42P01'
    || message.includes('does not exist')
    || message.includes('Could not find the table')
    || message.includes('schema cache')
  );
}

/**
 * @returns {{ events: object[], skipped_no_fecha: number }}
 */
export async function fetchReservaHistorialEvents(supabaseAdmin, user, { sourceLimit }) {
  const filters = buildUserEmailOrIdFilters(user);
  if (!filters.length) return { events: [], skipped_no_fecha: 0 };

  const { data, error } = await supabaseAdmin
    .from('reservas')
    .select(RESERVA_HISTORIAL_SELECT)
    .or(filters.join(','))
    .order('fecha', { ascending: false })
    .limit(sourceLimit);

  if (error) throw error;

  let skipped_no_fecha = 0;
  const events = [];
  for (const row of data || []) {
    const ev = normalizeReservaEvent(row);
    if (ev) events.push(ev);
    else skipped_no_fecha += 1;
  }
  return { events, skipped_no_fecha };
}

export async function fetchPartidoHistorialEvents(supabaseAdmin, user, { sourceLimit }) {
  const userId = user?.id;
  if (!userId) return { events: [], skipped_no_fecha: 0 };

  const { data: joinRows, error: joinErr } = await supabaseAdmin
    .from('partidos_abiertos_jugadores')
    .select('partido_id')
    .eq('user_id', userId)
    .limit(sourceLimit);

  if (joinErr) throw joinErr;

  const joinedIds = [...new Set((joinRows ?? []).map((r) => r.partido_id).filter(Boolean))];
  const byId = new Map();

  if (joinedIds.length) {
    const { data: joined, error: joinedErr } = await supabaseAdmin
      .from('partidos_abiertos')
      .select(PARTIDO_HISTORIAL_SELECT)
      .in('id', joinedIds)
      .limit(sourceLimit);
    if (joinedErr) throw joinedErr;
    for (const row of joined || []) {
      if (row?.id != null) byId.set(String(row.id), row);
    }
  }

  const { data: captainRows, error: captainErr } = await supabaseAdmin
    .from('partidos_abiertos')
    .select(PARTIDO_HISTORIAL_SELECT)
    .eq('capitan_user_id', userId)
    .order('fecha', { ascending: false })
    .limit(sourceLimit);

  if (captainErr) throw captainErr;
  for (const row of captainRows || []) {
    if (row?.id != null) byId.set(String(row.id), row);
  }

  let skipped_no_fecha = 0;
  const events = [];
  for (const row of byId.values()) {
    const ev = normalizePartidoEvent(row);
    if (ev) events.push(ev);
    else skipped_no_fecha += 1;
  }
  return { events, skipped_no_fecha };
}

export async function fetchPadcoinsHistorialEvents(supabaseAdmin, user, { sourceLimit }) {
  const userId = user?.id;
  if (!userId) return { events: [], skipped_no_fecha: 0 };

  const { data, error } = await supabaseAdmin
    .from('padcoins_movimientos')
    .select(PADCOINS_HISTORIAL_SELECT)
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(sourceLimit);

  if (error) {
    if (isMissingTableError(error)) return { events: [], skipped_no_fecha: 0 };
    throw error;
  }

  let skipped_no_fecha = 0;
  const events = [];
  for (const row of data || []) {
    const ev = normalizePadcoinsEvent(row);
    if (ev) events.push(ev);
    else skipped_no_fecha += 1;
  }
  return { events, skipped_no_fecha };
}

export async function fetchMembresiaHistorialEvents(supabaseAdmin, user, { sourceLimit }) {
  const userId = user?.id;
  if (!userId) return { events: [], skipped_no_fecha: 0 };

  const { data, error } = await supabaseAdmin
    .from('membresias_sede')
    .select(MEMBRESIA_HISTORIAL_SELECT)
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(sourceLimit);

  if (error) {
    if (isMissingTableError(error)) return { events: [], skipped_no_fecha: 0 };
    throw error;
  }

  let skipped_no_fecha = 0;
  const events = [];
  for (const row of data || []) {
    const ev = normalizeMembresiaEvent(row);
    if (ev) events.push(ev);
    else skipped_no_fecha += 1;
  }
  return { events, skipped_no_fecha };
}

export async function fetchLogroHistorialEvents(supabaseAdmin, user, { sourceLimit }) {
  const userId = user?.id;
  if (!userId) return { events: [], skipped_no_fecha: 0 };

  const { data, error } = await supabaseAdmin
    .from('logros_jugador')
    .select(LOGRO_HISTORIAL_SELECT)
    .eq('user_id', userId)
    .order('desbloqueado_en', { ascending: false })
    .limit(sourceLimit);

  if (error) {
    // Columna desbloqueado_en puede no existir en esquema legacy — reintentar.
    if (error.code === '42703' || /desbloqueado_en/i.test(String(error.message || ''))) {
      const retry = await supabaseAdmin
        .from('logros_jugador')
        .select('id, slug, logro_id, created_at, contexto')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(sourceLimit);
      if (retry.error) {
        if (isMissingTableError(retry.error)) return { events: [], skipped_no_fecha: 0 };
        throw retry.error;
      }
      let skipped_no_fecha = 0;
      const events = [];
      for (const row of retry.data || []) {
        const ev = normalizeLogroEvent(row);
        if (ev) events.push(ev);
        else skipped_no_fecha += 1;
      }
      return { events, skipped_no_fecha };
    }
    if (isMissingTableError(error)) return { events: [], skipped_no_fecha: 0 };
    throw error;
  }

  let skipped_no_fecha = 0;
  const events = [];
  for (const row of data || []) {
    const ev = normalizeLogroEvent(row);
    if (ev) events.push(ev);
    else skipped_no_fecha += 1;
  }
  return { events, skipped_no_fecha };
}

function chunkIds(ids, size = 80) {
  const arr = [...ids];
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * Participaciones de torneo deduplicadas por torneo_id (jugadores_torneo ∪ equipos).
 */
export async function fetchTorneoHistorialEvents(supabaseAdmin, user, { sourceLimit }) {
  const userId = user?.id;
  if (!userId) return { events: [], skipped_no_fecha: 0 };

  const byTorneo = new Map();
  let skipped_no_fecha = 0;

  const filters = buildUserEmailOrIdFilters(user);
  if (filters.length) {
    const { data, error } = await supabaseAdmin
      .from('jugadores_torneo')
      .select(`
        torneo_id,
        created_at,
        estado,
        torneos (
          id,
          nombre,
          sede_id,
          fecha_inicio,
          deporte,
          estado
        )
      `)
      .or(filters.join(','))
      .order('created_at', { ascending: false })
      .limit(sourceLimit);

    if (error && !isMissingTableError(error)) throw error;
    for (const row of data || []) {
      const tid = row.torneo_id ?? row.torneos?.id;
      if (tid == null) continue;
      const key = String(tid);
      if (byTorneo.has(key)) continue;
      byTorneo.set(key, {
        torneo_id: tid,
        user_id: userId,
        inscrito_at: row.created_at,
        created_at: row.created_at,
        estado_inscripcion: row.estado ?? null,
        nombre: row.torneos?.nombre ?? null,
        sede_id: row.torneos?.sede_id ?? null,
        fecha_inicio: row.torneos?.fecha_inicio ?? null,
        deporte: row.torneos?.deporte ?? null,
        equipo_id: null,
        equipo_nombre: null,
        posicion: null,
        instancia: null,
      });
    }
  }

  // equipos_jugadores (usuario) → equipos con torneo_id
  const { data: memberRows, error: memberErr } = await supabaseAdmin
    .from('equipos_jugadores')
    .select('equipo_id, estado, created_at, invited_at')
    .eq('user_id', userId)
    .limit(sourceLimit);

  if (memberErr && !isMissingTableError(memberErr)) throw memberErr;

  const acceptedEquipoIds = [...new Set(
    (memberRows || [])
      .filter((m) => !m.estado || ['aceptado', 'confirmado', 'activo'].includes(String(m.estado).toLowerCase()))
      .map((m) => m.equipo_id)
      .filter(Boolean),
  )];

  const memberAtByEquipo = new Map(
    (memberRows || []).map((m) => [String(m.equipo_id), m.created_at || m.invited_at || null]),
  );

  let equiposRows = [];
  for (const ids of chunkIds(acceptedEquipoIds)) {
    if (!ids.length) continue;
    const { data, error } = await supabaseAdmin
      .from('equipos')
      .select('id, nombre, torneo_id, jugadores')
      .in('id', ids)
      .not('torneo_id', 'is', null)
      .limit(sourceLimit);
    if (error && !isMissingTableError(error)) throw error;
    equiposRows.push(...(data || []));
  }

  // También equipos de torneos ya conocidos (JSON jugadores) — una query batch
  const knownTorneoIds = [...byTorneo.keys()].map((k) => Number(k)).filter((n) => Number.isFinite(n));
  for (const ids of chunkIds(knownTorneoIds)) {
    if (!ids.length) continue;
    const { data, error } = await supabaseAdmin
      .from('equipos')
      .select('id, nombre, torneo_id, jugadores')
      .in('torneo_id', ids)
      .limit(sourceLimit);
    if (error && !isMissingTableError(error)) throw error;
    for (const eq of data || []) {
      if (equipoJsonIncludesUser(eq.jugadores, user)) {
        equiposRows.push(eq);
      }
    }
  }

  // Dedup equipos
  const equiposById = new Map();
  for (const eq of equiposRows) {
    if (eq?.id != null) equiposById.set(Number(eq.id), eq);
  }

  for (const eq of equiposById.values()) {
    if (eq.torneo_id == null) continue;
    const key = String(eq.torneo_id);
    const existing = byTorneo.get(key);
    const inscrito_at = memberAtByEquipo.get(String(eq.id)) || existing?.inscrito_at || null;
    if (existing) {
      if (!existing.equipo_id) {
        existing.equipo_id = eq.id;
        existing.equipo_nombre = eq.nombre ?? null;
      }
      if (!existing.inscrito_at && inscrito_at) existing.inscrito_at = inscrito_at;
      continue;
    }
    byTorneo.set(key, {
      torneo_id: eq.torneo_id,
      user_id: userId,
      inscrito_at,
      created_at: inscrito_at,
      estado_inscripcion: 'inscripto',
      nombre: null,
      sede_id: null,
      fecha_inicio: null,
      deporte: null,
      equipo_id: eq.id,
      equipo_nombre: eq.nombre ?? null,
      posicion: null,
      instancia: null,
    });
  }

  // Completar torneos faltantes (nombre/sede) + posiciones en batch
  const missingMeta = [...byTorneo.values()].filter((p) => !p.nombre || p.sede_id == null);
  const missingTorneoIds = missingMeta.map((p) => p.torneo_id);
  for (const ids of chunkIds(missingTorneoIds)) {
    if (!ids.length) continue;
    const { data, error } = await supabaseAdmin
      .from('torneos')
      .select('id, nombre, sede_id, fecha_inicio, deporte')
      .in('id', ids);
    if (error && !isMissingTableError(error)) throw error;
    for (const t of data || []) {
      const p = byTorneo.get(String(t.id));
      if (!p) continue;
      p.nombre = p.nombre || t.nombre || null;
      p.sede_id = p.sede_id ?? t.sede_id ?? null;
      p.fecha_inicio = p.fecha_inicio || t.fecha_inicio || null;
      p.deporte = p.deporte || t.deporte || null;
    }
  }

  const equipoIdsForPos = [...equiposById.keys()];
  for (const ids of chunkIds(equipoIdsForPos)) {
    if (!ids.length) continue;
    const { data, error } = await supabaseAdmin
      .from('tabla_puntos')
      .select('equipo_id, torneo_id, posicion')
      .in('equipo_id', ids)
      .limit(sourceLimit);
    if (error) {
      if (isMissingTableError(error)) break;
      // columna puede variar — ignorar posiciones si falla
      break;
    }
    for (const row of data || []) {
      const p = byTorneo.get(String(row.torneo_id));
      if (!p) continue;
      if (p.equipo_id != null && Number(p.equipo_id) === Number(row.equipo_id)) {
        p.posicion = row.posicion ?? p.posicion;
      }
    }
  }

  const events = [];
  for (const participation of byTorneo.values()) {
    const ev = normalizeTorneoEvent(participation, userId);
    if (ev) events.push(ev);
    else skipped_no_fecha += 1;
  }
  return { events, skipped_no_fecha };
}

async function loadUserCasualPartidoRows(supabaseAdmin, user, sourceLimit, selectCols) {
  const userId = user?.id;
  if (!userId) return [];

  const { data: joinRows, error: joinErr } = await supabaseAdmin
    .from('partidos_abiertos_jugadores')
    .select('partido_id')
    .eq('user_id', userId)
    .limit(sourceLimit);
  if (joinErr) throw joinErr;

  const joinedIds = [...new Set((joinRows ?? []).map((r) => r.partido_id).filter(Boolean))];
  const byId = new Map();

  for (const ids of chunkIds(joinedIds)) {
    if (!ids.length) continue;
    const { data, error } = await supabaseAdmin
      .from('partidos_abiertos')
      .select(selectCols)
      .in('id', ids)
      .limit(sourceLimit);
    if (error) throw error;
    for (const row of data || []) {
      if (row?.id != null) byId.set(String(row.id), row);
    }
  }

  const { data: captainRows, error: captainErr } = await supabaseAdmin
    .from('partidos_abiertos')
    .select(selectCols)
    .eq('capitan_user_id', userId)
    .order('fecha', { ascending: false })
    .limit(sourceLimit);
  if (captainErr) throw captainErr;
  for (const row of captainRows || []) {
    if (row?.id != null) byId.set(String(row.id), row);
  }

  return [...byId.values()];
}

async function loadUserTorneoEquipoIds(supabaseAdmin, user, sourceLimit) {
  const userId = user?.id;
  if (!userId) return { equipoIds: [], equiposById: new Map() };

  const equiposById = new Map();

  const { data: members, error: memErr } = await supabaseAdmin
    .from('equipos_jugadores')
    .select('equipo_id, estado')
    .eq('user_id', userId)
    .limit(sourceLimit);
  if (memErr && !isMissingTableError(memErr)) throw memErr;

  const memberIds = (members || [])
    .filter((m) => !m.estado || ['aceptado', 'confirmado', 'activo'].includes(String(m.estado).toLowerCase()))
    .map((m) => m.equipo_id)
    .filter(Boolean);

  for (const ids of chunkIds(memberIds)) {
    if (!ids.length) continue;
    const { data, error } = await supabaseAdmin
      .from('equipos')
      .select('id, nombre, torneo_id, jugadores')
      .in('id', ids)
      .not('torneo_id', 'is', null);
    if (error && !isMissingTableError(error)) throw error;
    for (const eq of data || []) equiposById.set(Number(eq.id), eq);
  }

  // Fallback JSON vía inscripciones
  const filters = buildUserEmailOrIdFilters(user);
  if (filters.length) {
    const { data: insc, error: inscErr } = await supabaseAdmin
      .from('jugadores_torneo')
      .select('torneo_id')
      .or(filters.join(','))
      .limit(sourceLimit);
    if (inscErr && !isMissingTableError(inscErr)) throw inscErr;
    const torneoIds = [...new Set((insc || []).map((r) => r.torneo_id).filter(Boolean))];
    for (const ids of chunkIds(torneoIds)) {
      if (!ids.length) continue;
      const { data, error } = await supabaseAdmin
        .from('equipos')
        .select('id, nombre, torneo_id, jugadores')
        .in('torneo_id', ids)
        .limit(sourceLimit);
      if (error && !isMissingTableError(error)) throw error;
      for (const eq of data || []) {
        if (equipoJsonIncludesUser(eq.jugadores, user)) {
          equiposById.set(Number(eq.id), eq);
        }
      }
    }
  }

  return { equipoIds: [...equiposById.keys()], equiposById };
}

export async function fetchResultadoHistorialEvents(supabaseAdmin, user, { sourceLimit }) {
  let skipped_no_fecha = 0;
  let skipped_no_ganador = 0;
  let skipped_empate = 0;
  let skipped_no_finalizado = 0;
  const events = [];

  // Casual
  const casualRows = await loadUserCasualPartidoRows(
    supabaseAdmin,
    user,
    sourceLimit,
    PARTIDO_RESULTADO_SELECT,
  );
  for (const row of casualRows) {
    const r = tryNormalizeResultadoCasual(row);
    if (r.ok) {
      events.push(r.event);
      continue;
    }
    if (r.reason === 'sin_fecha') skipped_no_fecha += 1;
    else if (r.reason === 'empate') skipped_empate += 1;
    else if (r.reason === 'sin_ganador' || r.reason === 'sin_marcador') skipped_no_ganador += 1;
    else if (r.reason === 'no_finalizado' || r.reason === 'cancelado') skipped_no_finalizado += 1;
  }

  // Torneo
  const { equipoIds, equiposById } = await loadUserTorneoEquipoIds(supabaseAdmin, user, sourceLimit);
  if (equipoIds.length) {
    const orFilter = `equipo_a_id.in.(${equipoIds.join(',')}),equipo_b_id.in.(${equipoIds.join(',')})`;
    let query = supabaseAdmin
      .from('partidos')
      .select(PARTIDO_TORNEO_RESULTADO_SELECT)
      .eq('estado', 'finalizado')
      .or(orFilter)
      .order('fecha', { ascending: false })
      .limit(sourceLimit);

    let { data: torneoPartidos, error } = await query;
    if (error && (error.code === '42703' || /column|does not exist/i.test(String(error.message || '')))) {
      const retry = await supabaseAdmin
        .from('partidos')
        .select('id, torneo_id, estado, resultado, equipo_a_id, equipo_b_id, fecha_hora, sede_id, created_at, updated_at')
        .eq('estado', 'finalizado')
        .or(orFilter)
        .limit(sourceLimit);
      if (retry.error) {
        if (!isMissingTableError(retry.error)) throw retry.error;
        torneoPartidos = [];
      } else {
        torneoPartidos = retry.data || [];
      }
    } else if (error) {
      if (!isMissingTableError(error)) throw error;
      torneoPartidos = [];
    }

    // sede_id desde torneos (batch)
    const torneoIds = [...new Set((torneoPartidos || []).map((p) => p.torneo_id).filter(Boolean))];
    const sedeByTorneo = new Map();
    const deporteByTorneo = new Map();
    for (const ids of chunkIds(torneoIds)) {
      if (!ids.length) continue;
      const { data } = await supabaseAdmin
        .from('torneos')
        .select('id, sede_id, deporte')
        .in('id', ids);
      for (const t of data || []) {
        sedeByTorneo.set(Number(t.id), t.sede_id ?? null);
        deporteByTorneo.set(Number(t.id), t.deporte ?? null);
      }
    }

    for (const row of torneoPartidos || []) {
      const enriched = {
        ...row,
        sede_id: sedeByTorneo.get(Number(row.torneo_id)) ?? null,
        deporte: deporteByTorneo.get(Number(row.torneo_id)) ?? null,
      };
      const r = tryNormalizeResultadoTorneo(enriched, { equiposById });
      if (r.ok) {
        events.push(r.event);
        continue;
      }
      if (r.reason === 'sin_fecha') skipped_no_fecha += 1;
      else if (r.reason === 'empate') skipped_empate += 1;
      else if (r.reason === 'sin_ganador' || r.reason === 'sin_marcador') skipped_no_ganador += 1;
      else if (r.reason === 'no_finalizado' || r.reason === 'cancelado') skipped_no_finalizado += 1;
    }
  }

  return {
    events,
    skipped_no_fecha,
    skipped_no_ganador,
    skipped_empate,
    skipped_no_finalizado,
  };
}

/**
 * Enriquece sede/deporte/fecha de partidos casuales en batch (sin N+1).
 */
async function loadPartidosAbiertosMetaByIds(supabaseAdmin, matchIds) {
  const meta = new Map();
  const ids = [...new Set((matchIds || []).map((id) => {
    const n = Number(id);
    return Number.isFinite(n) ? n : null;
  }).filter((n) => n != null))];

  for (const chunk of chunkIds(ids)) {
    if (!chunk.length) continue;
    const { data, error } = await supabaseAdmin
      .from('partidos_abiertos')
      .select('id, sede_id, deporte, fecha, hora')
      .in('id', chunk);
    if (error) {
      if (isMissingTableError(error)) break;
      throw error;
    }
    for (const row of data || []) {
      meta.set(String(row.id), {
        sede_id: row.sede_id ?? null,
        deporte: row.deporte ?? null,
        fecha_partido: combineFechaHora(row.fecha, row.hora),
      });
    }
  }
  return meta;
}

export async function fetchRankingCasualHistorialEvents(supabaseAdmin, user, { sourceLimit }) {
  const userId = user?.id;
  if (!userId) {
    return { events: [], skipped_no_fecha: 0, skipped_estado_desconocido: 0 };
  }

  const { data, error } = await supabaseAdmin
    .from('match_reward_events')
    .select(RANKING_CASUAL_SELECT)
    .eq('user_id', userId)
    .eq('reward_type', 'ranking')
    .in('status', ['credited', 'reversed'])
    .order('created_at', { ascending: false })
    .limit(sourceLimit);

  if (error) {
    if (isMissingTableError(error)) {
      return { events: [], skipped_no_fecha: 0, skipped_estado_desconocido: 0 };
    }
    throw error;
  }

  const rows = data || [];
  // Dedup exacto por PK del ledger (misma fila no debe repetirse).
  const byId = new Map();
  for (const row of rows) {
    if (row?.id == null) continue;
    byId.set(String(row.id), row);
  }

  const metaByMatch = await loadPartidosAbiertosMetaByIds(
    supabaseAdmin,
    [...byId.values()].map((r) => r.match_id),
  );

  const events = [];
  let skipped_no_fecha = 0;
  let skipped_estado_desconocido = 0;
  for (const row of byId.values()) {
    const m = metaByMatch.get(String(row.match_id)) || {};
    const r = tryNormalizeRankingCasualEvent(row, {
      sede_id: m.sede_id ?? null,
      deporte: m.deporte ?? null,
    });
    if (r.ok) {
      events.push(r.event);
      continue;
    }
    if (r.reason === 'sin_fecha') skipped_no_fecha += 1;
  }
  return { events, skipped_no_fecha, skipped_estado_desconocido };
}

export async function fetchAsistenciaHistorialEvents(supabaseAdmin, user, { sourceLimit }) {
  const userId = user?.id;
  if (!userId) {
    return { events: [], skipped_no_fecha: 0, skipped_estado_desconocido: 0 };
  }

  const { data, error } = await supabaseAdmin
    .from('match_participants')
    .select(ASISTENCIA_SELECT)
    .eq('user_id', userId)
    .order('updated_at', { ascending: false })
    .limit(sourceLimit);

  if (error) {
    if (isMissingTableError(error)) {
      return { events: [], skipped_no_fecha: 0, skipped_estado_desconocido: 0 };
    }
    throw error;
  }

  const rows = data || [];
  const byId = new Map();
  for (const row of rows) {
    if (row?.id == null) continue;
    byId.set(String(row.id), row);
  }

  const metaByMatch = await loadPartidosAbiertosMetaByIds(
    supabaseAdmin,
    [...byId.values()].map((r) => r.match_id),
  );

  const events = [];
  let skipped_no_fecha = 0;
  let skipped_estado_desconocido = 0;
  for (const row of byId.values()) {
    const m = metaByMatch.get(String(row.match_id)) || {};
    const r = tryNormalizeAsistenciaEvent(row, {
      sede_id: m.sede_id ?? null,
      deporte: m.deporte ?? null,
      fecha_partido: m.fecha_partido ?? null,
    });
    if (r.ok) {
      events.push(r.event);
      continue;
    }
    if (r.reason === 'sin_fecha') skipped_no_fecha += 1;
    else if (r.reason === 'estado_desconocido') skipped_estado_desconocido += 1;
  }
  return { events, skipped_no_fecha, skipped_estado_desconocido };
}

const SOURCE_FETCHERS = {
  reserva: fetchReservaHistorialEvents,
  partido: fetchPartidoHistorialEvents,
  padcoins: fetchPadcoinsHistorialEvents,
  membresia: fetchMembresiaHistorialEvents,
  logro: fetchLogroHistorialEvents,
  torneo: fetchTorneoHistorialEvents,
  resultado: fetchResultadoHistorialEvents,
  ranking_casual: fetchRankingCasualHistorialEvents,
  asistencia: fetchAsistenciaHistorialEvents,
};

export function parseHistorialQuery(query = {}) {
  const limit = parseHistorialLimit(query.limit);
  const tipos = parseHistorialTipos(query.tipos);
  const sede_id = parseHistorialSedeId(query.sede_id);
  const fecha_desde = parseHistorialIsoDate(query.fecha_desde, 'fecha_desde');
  const fecha_hasta = parseHistorialIsoDate(query.fecha_hasta, 'fecha_hasta');
  if (fecha_desde && fecha_hasta && fecha_desde > fecha_hasta) {
    throw httpError(400, 'fecha_desde no puede ser posterior a fecha_hasta', 'FECHA_RANGE_INVALID');
  }
  const cursor = decodeHistorialCursor(query.cursor);
  return { limit, tipos, sede_id, fecha_desde, fecha_hasta, cursor };
}

/**
 * Historial privado del usuario autenticado.
 */
export async function getJugadorHistorial(supabaseAdmin, user, query = {}) {
  if (!user?.id) throw httpError(401, 'No autorizado');

  const parsed = parseHistorialQuery(query);
  const sourceLimit = sourceLimitFor(parsed.limit);
  const tiposToFetch = parsed.tipos?.length
    ? parsed.tipos
    : Object.keys(SOURCE_FETCHERS);

  const results = await Promise.all(
    tiposToFetch.map(async (tipo) => {
      const fetcher = SOURCE_FETCHERS[tipo];
      if (!fetcher) return { tipo, events: [], skipped_no_fecha: 0 };
      try {
        const r = await fetcher(supabaseAdmin, user, { sourceLimit });
        return { tipo, ...r };
      } catch (err) {
        err.source = tipo;
        throw err;
      }
    }),
  );

  const all = [];
  const skipped_by_source = {};
  for (const r of results) {
    all.push(...r.events);
    skipped_by_source[r.tipo] = {
      skipped_no_fecha: r.skipped_no_fecha || 0,
      skipped_no_ganador: r.skipped_no_ganador || 0,
      skipped_empate: r.skipped_empate || 0,
      skipped_no_finalizado: r.skipped_no_finalizado || 0,
      skipped_estado_desconocido: r.skipped_estado_desconocido || 0,
    };
  }

  const filtered = filterHistorialEvents(all, {
    tipos: parsed.tipos,
    fecha_desde: parsed.fecha_desde,
    fecha_hasta: parsed.fecha_hasta,
    sede_id: parsed.sede_id,
    cursor: parsed.cursor,
  });

  const page = paginateHistorialEvents(filtered, parsed.limit);

  return {
    ok: true,
    data: {
      items: page.items,
      pagination: page.pagination,
    },
    // meta interna opcional (no se envía al cliente desde la ruta)
    _meta: { skipped_by_source },
  };
}
