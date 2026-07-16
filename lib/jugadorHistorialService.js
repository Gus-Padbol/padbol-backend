/**
 * Historial unificado del jugador — adapters de lectura + merge (FASE 1).
 * No modifica reglas de negocio de módulos cerrados.
 */

import {
  JUGADOR_HISTORIAL_SOURCE_LIMIT,
  decodeHistorialCursor,
  filterHistorialEvents,
  httpError,
  normalizeLogroEvent,
  normalizeMembresiaEvent,
  normalizePadcoinsEvent,
  normalizePartidoEvent,
  normalizeReservaEvent,
  paginateHistorialEvents,
  parseHistorialIsoDate,
  parseHistorialLimit,
  parseHistorialSedeId,
  parseHistorialTipos,
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

const SOURCE_FETCHERS = {
  reserva: fetchReservaHistorialEvents,
  partido: fetchPartidoHistorialEvents,
  padcoins: fetchPadcoinsHistorialEvents,
  membresia: fetchMembresiaHistorialEvents,
  logro: fetchLogroHistorialEvents,
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
    if (r.skipped_no_fecha) skipped_by_source[r.tipo] = r.skipped_no_fecha;
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
