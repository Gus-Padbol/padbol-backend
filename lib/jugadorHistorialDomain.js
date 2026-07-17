/** Historial unificado del jugador — dominio puro (FASE 1 + FASE 2 + FASE 3). */

export const JUGADOR_HISTORIAL_TIPOS = Object.freeze([
  'reserva',
  'partido',
  'padcoins',
  'membresia',
  'logro',
  'torneo',
  'resultado',
  'ranking_casual',
  'asistencia',
]);

/** Estados públicos de asistencia (historial). */
export const HISTORIAL_ASISTENCIA_ESTADOS = Object.freeze([
  'confirmada',
  'rechazada',
  'pendiente',
  'vencida',
  'cancelada',
]);

export const JUGADOR_HISTORIAL_LIMIT_DEFAULT = 20;
export const JUGADOR_HISTORIAL_LIMIT_MAX = 50;
/** Límite por fuente antes del merge (evita cargar historiales completos). */
export const JUGADOR_HISTORIAL_SOURCE_LIMIT = 100;

export function httpError(status, message, code) {
  const err = new Error(message);
  err.status = status;
  if (code) err.code = code;
  return err;
}

export function parseHistorialLimit(raw) {
  if (raw == null || raw === '') return JUGADOR_HISTORIAL_LIMIT_DEFAULT;
  const n = parseInt(String(raw), 10);
  if (!Number.isFinite(n) || n < 1) {
    throw httpError(400, 'limit inválido', 'LIMIT_INVALID');
  }
  return Math.min(n, JUGADOR_HISTORIAL_LIMIT_MAX);
}

export function parseHistorialSedeId(raw) {
  if (raw == null || raw === '') return null;
  const n = parseInt(String(raw).trim(), 10);
  if (!Number.isFinite(n) || n < 1) {
    throw httpError(400, 'sede_id inválido', 'SEDE_ID_INVALID');
  }
  return n;
}

export function parseHistorialTipos(raw) {
  if (raw == null || String(raw).trim() === '') return null;
  const parts = String(raw)
    .split(',')
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
  const valid = [...new Set(parts.filter((t) => JUGADOR_HISTORIAL_TIPOS.includes(t)))];
  const invalid = parts.filter((t) => !JUGADOR_HISTORIAL_TIPOS.includes(t));
  if (parts.length > 0 && valid.length === 0) {
    throw httpError(400, `tipos inválidos: ${invalid.join(', ')}`, 'TIPOS_INVALID');
  }
  return valid;
}

export function parseHistorialIsoDate(raw, fieldName) {
  if (raw == null || String(raw).trim() === '') return null;
  const s = String(raw).trim();
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) {
    throw httpError(400, `${fieldName} inválida`, 'FECHA_INVALID');
  }
  return d.toISOString();
}

/**
 * Cursor estable: occurred_at|id (URL-encoded id).
 */
export function encodeHistorialCursor(event) {
  if (!event?.occurred_at || !event?.id) return null;
  return `${event.occurred_at}|${encodeURIComponent(String(event.id))}`;
}

export function decodeHistorialCursor(raw) {
  if (raw == null || String(raw).trim() === '') return null;
  const s = String(raw).trim();
  const pipe = s.indexOf('|');
  if (pipe <= 0 || pipe === s.length - 1) {
    throw httpError(400, 'cursor inválido', 'CURSOR_INVALID');
  }
  const occurredAt = s.slice(0, pipe);
  const id = decodeURIComponent(s.slice(pipe + 1));
  if (!occurredAt || !id || Number.isNaN(new Date(occurredAt).getTime())) {
    throw httpError(400, 'cursor inválido', 'CURSOR_INVALID');
  }
  return { occurred_at: new Date(occurredAt).toISOString(), id: String(id) };
}

export function compareHistorialEventsDesc(a, b) {
  const ta = String(a.occurred_at || '');
  const tb = String(b.occurred_at || '');
  if (ta !== tb) return tb.localeCompare(ta);
  return String(b.id || '').localeCompare(String(a.id || ''));
}

/** true si `event` es estrictamente anterior al cursor en orden DESC (occurred_at, id). */
export function isHistorialEventAfterCursor(event, cursor) {
  if (!cursor) return true;
  const ta = String(event.occurred_at || '');
  const tc = String(cursor.occurred_at || '');
  if (ta !== tc) return ta < tc;
  return String(event.id || '') < String(cursor.id || '');
}

export function isValidOccurredAt(raw) {
  if (raw == null || raw === '') return false;
  const t = new Date(raw).getTime();
  return Number.isFinite(t);
}

export function toIsoOrNull(raw) {
  if (!isValidOccurredAt(raw)) return null;
  return new Date(raw).toISOString();
}

/** Combina fecha (YYYY-MM-DD) + hora (HH:MM[:SS]) en ISO; null si inválido. */
export function combineFechaHora(fecha, hora) {
  const f = String(fecha || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(f)) return null;
  let h = String(hora || '').trim();
  if (!h) h = '00:00:00';
  if (/^\d{2}:\d{2}$/.test(h)) h = `${h}:00`;
  if (!/^\d{2}:\d{2}:\d{2}/.test(h)) return null;
  // Interpretar como UTC local-agnostic estable (fecha programada).
  const iso = `${f}T${h.slice(0, 8)}.000Z`;
  return toIsoOrNull(iso);
}

export function buildHistorialEvent({
  tipo,
  refId,
  occurred_at,
  sede_id = null,
  titulo,
  resumen,
  payload = {},
  referenciaTipo = null,
  referenciaId, // undefined = usar refId; null = referencia.id nulo explícito
}) {
  if (!JUGADOR_HISTORIAL_TIPOS.includes(tipo)) return null;
  const at = toIsoOrNull(occurred_at);
  if (!at) return null;
  const idPart = String(refId ?? '').trim();
  if (!idPart) return null;
  const sede =
    sede_id == null || sede_id === ''
      ? null
      : (Number.isFinite(Number(sede_id)) ? Number(sede_id) : null);
  const refTipo = referenciaTipo ? String(referenciaTipo) : tipo;
  // undefined → fallback al refId del evento; null/'' → null explícito (p.ej. ranking sin partido)
  const refIdOut = referenciaId === undefined
    ? idPart
    : (referenciaId == null || referenciaId === '' ? null : String(referenciaId));

  return {
    id: `${tipo}:${idPart}`,
    tipo,
    occurred_at: at,
    sede_id: sede,
    titulo: String(titulo || tipo).trim() || tipo,
    resumen: String(resumen || '').trim() || titulo || tipo,
    visibilidad: 'privada',
    referencia: {
      tipo: refTipo,
      id: refIdOut,
    },
    payload: payload && typeof payload === 'object' ? payload : {},
  };
}

export function containsEmpateSignal(value) {
  const s = JSON.stringify(value ?? '').toLowerCase();
  // Solo señales explícitas de empate (evitar falsos positivos por substrings).
  return /\bempate\b|\bempatado\b|\bempataron\b|\bdraw\b/.test(s);
}

export function unwrapJsonValue(val, depth = 0) {
  if (val == null || depth > 4) return null;
  if (typeof val === 'string') {
    const t = val.trim();
    if (!t) return null;
    try {
      return unwrapJsonValue(JSON.parse(t), depth + 1);
    } catch {
      return null;
    }
  }
  if (typeof val === 'object') return val;
  return null;
}

export function normalizeHistorialSets(raw) {
  const arr = Array.isArray(raw) ? raw : unwrapJsonValue(raw);
  if (!Array.isArray(arr) || !arr.length) return [];
  const out = [];
  for (const row of arr) {
    if (!row || typeof row !== 'object') continue;
    if (containsEmpateSignal(row)) continue;
    const a = row.a ?? row.equipo_a ?? row.equipo1 ?? row.games_a ?? row.goles_a ?? row.eq1;
    const b = row.b ?? row.equipo_b ?? row.equipo2 ?? row.games_b ?? row.goles_b ?? row.eq2;
    const na = Number(a);
    const nb = Number(b);
    if (!Number.isFinite(na) || !Number.isFinite(nb)) continue;
    out.push({
      set: row.set ?? row.n ?? (out.length + 1),
      a: na,
      b: nb,
    });
  }
  return out;
}

/**
 * Resuelve occurred_at de torneo: inscripción → inicio pasado → null (excluir futuro).
 */
export function resolveTorneoOccurredAt({
  inscrito_at = null,
  fecha_inicio = null,
  now = new Date(),
} = {}) {
  const insc = toIsoOrNull(inscrito_at);
  if (insc) return insc;
  const inicio = toIsoOrNull(fecha_inicio);
  if (!inicio) return null;
  if (new Date(inicio).getTime() > now.getTime()) return null;
  return inicio;
}

export function equipoJsonIncludesUser(jugadoresRaw, user) {
  const arr = Array.isArray(jugadoresRaw)
    ? jugadoresRaw
    : unwrapJsonValue(jugadoresRaw);
  if (!Array.isArray(arr)) return false;
  const uid = user?.id ? String(user.id) : '';
  const email = String(user?.email || '').trim().toLowerCase();
  return arr.some((elem) => {
    if (!elem || typeof elem !== 'object') return false;
    if (uid && (String(elem.user_id || '') === uid || String(elem.id || '') === uid)) return true;
    if (email && String(elem.email || '').trim().toLowerCase() === email) return true;
    return false;
  });
}

export function normalizeTorneoEvent(participation, userId) {
  const torneoId = participation?.torneo_id ?? participation?.torneo?.id;
  if (torneoId == null || torneoId === '') return null;
  const uid = userId || participation?.user_id;
  if (!uid) return null;

  const occurred_at = resolveTorneoOccurredAt({
    inscrito_at: participation.inscrito_at ?? participation.created_at,
    fecha_inicio: participation.fecha_inicio ?? participation.torneo?.fecha_inicio,
  });
  if (!occurred_at) return null;

  const nombre = participation.nombre ?? participation.torneo?.nombre ?? null;
  const estadoInscripcion = participation.estado_inscripcion
    ?? participation.estado
    ?? null;
  const posicion = participation.posicion != null ? participation.posicion : null;
  const instancia = participation.instancia != null ? String(participation.instancia) : null;
  const equipoNombre = participation.equipo_nombre ?? null;

  let resumen = nombre ? `Torneo: ${nombre}` : 'Torneo';
  if (estadoInscripcion) resumen = `${resumen} (${estadoInscripcion})`;
  if (posicion != null) resumen = `${resumen} · pos. ${posicion}`;

  return buildHistorialEvent({
    tipo: 'torneo',
    refId: `${torneoId}:${uid}`,
    occurred_at,
    sede_id: participation.sede_id ?? participation.torneo?.sede_id ?? null,
    titulo: 'Torneo',
    resumen,
    referenciaTipo: 'torneo',
    referenciaId: String(torneoId),
    payload: {
      torneo_id: String(torneoId),
      nombre: nombre != null ? String(nombre) : null,
      deporte: participation.deporte ?? participation.torneo?.deporte ?? null,
      estado_inscripcion: estadoInscripcion != null ? String(estadoInscripcion) : null,
      equipo_id: participation.equipo_id != null ? String(participation.equipo_id) : null,
      equipo_nombre: equipoNombre != null ? String(equipoNombre) : null,
      posicion,
      instancia,
    },
  });
}

function extractCasualScores(partido) {
  const resultado = unwrapJsonValue(partido?.resultado) || {};
  const resultadoJson = unwrapJsonValue(partido?.resultado_json) || {};
  const cargas = resultadoJson.cargas && typeof resultadoJson.cargas === 'object'
    ? Object.values(resultadoJson.cargas)
    : [];
  const fromCarga = cargas.find((c) => c && (c.equipo1 != null || c.resultado?.equipo1 != null));
  const src = fromCarga?.resultado || fromCarga || resultado;

  let e1 = src.equipo1 != null ? Number(src.equipo1) : null;
  let e2 = src.equipo2 != null ? Number(src.equipo2) : null;
  if (!Number.isFinite(e1) || !Number.isFinite(e2)) {
    e1 = resultadoJson.equipo1 != null ? Number(resultadoJson.equipo1) : e1;
    e2 = resultadoJson.equipo2 != null ? Number(resultadoJson.equipo2) : e2;
  }
  if (!Number.isFinite(e1) || !Number.isFinite(e2)) return null;
  return { equipo1: e1, equipo2: e2 };
}

export function resolveCasualResultadoOccurredAt(partido) {
  const json = unwrapJsonValue(partido?.resultado_json) || {};
  return (
    toIsoOrNull(json.confirmado_at)
    || toIsoOrNull(partido?.finalizado_at)
    || toIsoOrNull(partido?.updated_at)
    || combineFechaHora(partido?.fecha, partido?.hora)
    || toIsoOrNull(partido?.created_at)
  );
}

/**
 * @returns {{ ok: true, event } | { ok: false, reason: string }}
 */
export function tryNormalizeResultadoCasual(partido) {
  if (!partido?.id) return { ok: false, reason: 'sin_id' };
  if (containsEmpateSignal(partido)) return { ok: false, reason: 'empate' };

  const estado = String(partido.estado || '').trim().toLowerCase();
  if (estado === 'cancelado' || estado === 'cancelada') {
    return { ok: false, reason: 'cancelado' };
  }
  if (estado !== 'finalizado' && estado !== 'terminado') {
    return { ok: false, reason: 'no_finalizado' };
  }

  const ganadorRaw = String(partido.ganador || '').trim().toLowerCase();
  if (!ganadorRaw || ganadorRaw === 'empate' || ganadorRaw === 'empatado') {
    return { ok: false, reason: 'sin_ganador' };
  }
  if (ganadorRaw !== 'equipo1' && ganadorRaw !== 'equipo2' && ganadorRaw !== 'a' && ganadorRaw !== 'b') {
    // permitir otros labels solo si hay scores claros
  }

  const scores = extractCasualScores(partido);
  if (!scores) return { ok: false, reason: 'sin_marcador' };
  if (scores.equipo1 === scores.equipo2) return { ok: false, reason: 'empate' };

  let ganador = ganadorRaw;
  if (ganador === 'a') ganador = 'equipo1';
  if (ganador === 'b') ganador = 'equipo2';
  if (ganador !== 'equipo1' && ganador !== 'equipo2') {
    ganador = scores.equipo1 > scores.equipo2 ? 'equipo1' : 'equipo2';
  }
  // coherencia scores vs ganador
  const inferred = scores.equipo1 > scores.equipo2 ? 'equipo1' : 'equipo2';
  if (ganador !== inferred) return { ok: false, reason: 'sin_ganador' };

  const occurred_at = resolveCasualResultadoOccurredAt(partido);
  if (!occurred_at) return { ok: false, reason: 'sin_fecha' };

  const json = unwrapJsonValue(partido.resultado_json) || {};
  const sets = normalizeHistorialSets(
    json.historial_sets
    || partido.resultado?.historial_sets
    || partido.resultado?.sets
    || json.sets,
  );

  const marcador = `${scores.equipo1}-${scores.equipo2}`;
  const resumen = `Resultado ${marcador} · ganó ${ganador}`;

  const event = buildHistorialEvent({
    tipo: 'resultado',
    refId: `casual:${partido.id}`,
    occurred_at,
    sede_id: partido.sede_id ?? null,
    titulo: 'Resultado',
    resumen,
    referenciaTipo: 'partido',
    referenciaId: String(partido.id),
    payload: {
      origen: 'casual',
      partido_id: String(partido.id),
      torneo_id: null,
      deporte: partido.deporte ?? null,
      estado: 'finalizado',
      ganador,
      equipo_local: 'equipo1',
      equipo_visitante: 'equipo2',
      marcador: { equipo1: scores.equipo1, equipo2: scores.equipo2, texto: marcador },
      sets,
    },
  });
  if (!event) return { ok: false, reason: 'sin_fecha' };
  return { ok: true, event };
}

export function resolveTorneoResultadoOccurredAt(partido) {
  return (
    toIsoOrNull(partido?.finalizado_at)
    || toIsoOrNull(partido?.fecha_hora)
    || toIsoOrNull(partido?.updated_at)
    || combineFechaHora(partido?.fecha, partido?.hora)
    || toIsoOrNull(partido?.created_at)
  );
}

/**
 * Marcador de partido de torneo: goles_a/b, o sets ganados desde parciales confiables.
 * @returns {{ a: number, b: number, fuente: 'goles'|'sets' } | null}
 */
export function extractTorneoScores(resultado) {
  const res = unwrapJsonValue(resultado) || {};
  const golesA = Number(res.goles_a ?? res.equipo_a ?? res.sets_a);
  const golesB = Number(res.goles_b ?? res.equipo_b ?? res.sets_b);
  if (Number.isFinite(golesA) && Number.isFinite(golesB)) {
    return { a: golesA, b: golesB, fuente: 'goles' };
  }
  const sets = normalizeHistorialSets(res.historial_sets || res.sets);
  if (!sets.length) return null;
  let wonA = 0;
  let wonB = 0;
  for (const s of sets) {
    if (s.a === s.b) continue;
    if (s.a > s.b) wonA += 1;
    else wonB += 1;
  }
  if (wonA === 0 && wonB === 0) return null;
  return { a: wonA, b: wonB, fuente: 'sets' };
}

/**
 * @returns {{ ok: true, event } | { ok: false, reason: string }}
 */
export function tryNormalizeResultadoTorneo(partido, { equiposById = new Map() } = {}) {
  if (!partido?.id) return { ok: false, reason: 'sin_id' };
  if (containsEmpateSignal(partido)) return { ok: false, reason: 'empate' };

  const estado = String(partido.estado || '').trim().toLowerCase();
  if (estado === 'cancelado' || estado === 'cancelada') {
    return { ok: false, reason: 'cancelado' };
  }
  if (estado !== 'finalizado' && estado !== 'terminado') {
    return { ok: false, reason: 'no_finalizado' };
  }

  const res = unwrapJsonValue(partido.resultado) || {};
  const scores = extractTorneoScores(res);
  if (!scores) return { ok: false, reason: 'sin_marcador' };
  if (scores.a === scores.b) return { ok: false, reason: 'empate' };

  let ganadorEquipoId = partido.ganador_equipo_id != null
    ? Number(partido.ganador_equipo_id)
    : null;
  if (!Number.isFinite(ganadorEquipoId)) {
    ganadorEquipoId = res.ganador_id != null
      ? Number(res.ganador_id)
      : (res.ganador_equipo_id != null ? Number(res.ganador_equipo_id) : null);
  }
  if (!Number.isFinite(ganadorEquipoId)) {
    ganadorEquipoId = scores.a > scores.b
      ? Number(partido.equipo_a_id)
      : Number(partido.equipo_b_id);
  }
  if (!Number.isFinite(ganadorEquipoId)) return { ok: false, reason: 'sin_ganador' };

  const inferred = scores.a > scores.b
    ? Number(partido.equipo_a_id)
    : Number(partido.equipo_b_id);
  if (Number(ganadorEquipoId) !== Number(inferred)) {
    return { ok: false, reason: 'sin_ganador' };
  }

  const occurred_at = resolveTorneoResultadoOccurredAt(partido);
  if (!occurred_at) return { ok: false, reason: 'sin_fecha' };

  const sets = normalizeHistorialSets(res.historial_sets || res.sets);
  const eqA = equiposById.get(Number(partido.equipo_a_id));
  const eqB = equiposById.get(Number(partido.equipo_b_id));
  const marcadorTexto = `${scores.a}-${scores.b}`;
  const ganadorNombre = equiposById.get(Number(ganadorEquipoId))?.nombre || null;

  const marcador = scores.fuente === 'goles'
    ? { goles_a: scores.a, goles_b: scores.b, texto: marcadorTexto }
    : { sets_a: scores.a, sets_b: scores.b, texto: marcadorTexto };

  const event = buildHistorialEvent({
    tipo: 'resultado',
    refId: `torneo:${partido.id}`,
    occurred_at,
    sede_id: partido.sede_id ?? null,
    titulo: 'Resultado',
    resumen: ganadorNombre
      ? `Resultado ${marcadorTexto} · ganó ${ganadorNombre}`
      : `Resultado ${marcadorTexto}`,
    referenciaTipo: 'partido',
    referenciaId: String(partido.id),
    payload: {
      origen: 'torneo',
      partido_id: String(partido.id),
      torneo_id: partido.torneo_id != null ? String(partido.torneo_id) : null,
      deporte: partido.deporte ?? null,
      estado: 'finalizado',
      ganador: {
        equipo_id: String(ganadorEquipoId),
        nombre: ganadorNombre,
      },
      equipo_local: {
        equipo_id: partido.equipo_a_id != null ? String(partido.equipo_a_id) : null,
        nombre: eqA?.nombre ?? null,
      },
      equipo_visitante: {
        equipo_id: partido.equipo_b_id != null ? String(partido.equipo_b_id) : null,
        nombre: eqB?.nombre ?? null,
      },
      marcador,
      sets,
    },
  });
  if (!event) return { ok: false, reason: 'sin_fecha' };
  return { ok: true, event };
}

/**
 * Mapea attendance_status interno → estado público del historial.
 * @returns {string|null} null si no se puede mapear de forma confiable
 */
export function mapAsistenciaEstadoPublico(row) {
  const raw = String(row?.attendance_status ?? row?.estado ?? '').trim().toLowerCase();
  if (!raw) return null;
  if (raw === 'confirmed' || raw === 'confirmada' || raw === 'admin_validated') {
    return 'confirmada';
  }
  if (raw === 'denied' || raw === 'rechazada' || raw === 'rejected') {
    return 'rechazada';
  }
  if (raw === 'pending' || raw === 'pendiente') {
    return 'pendiente';
  }
  if (raw === 'expired' || raw === 'vencida' || raw === 'vencido') {
    return 'vencida';
  }
  if (raw === 'cancelled' || raw === 'canceled' || raw === 'cancelada' || raw === 'cancelado') {
    return 'cancelada';
  }
  if (raw === 'excluded') {
    const src = String(row?.attendance_response_source ?? '').trim().toLowerCase();
    if (src === 'system_timeout') return 'vencida';
    return 'cancelada';
  }
  return null;
}

export function resolveAsistenciaOccurredAt(row) {
  return (
    toIsoOrNull(row?.attendance_responded_at)
    || toIsoOrNull(row?.attendance_confirmed_at)
    || toIsoOrNull(row?.respondido_en)
    || toIsoOrNull(row?.confirmado_en)
    || toIsoOrNull(row?.expirado_en)
    || toIsoOrNull(row?.expired_at)
    || toIsoOrNull(row?.updated_at)
    || toIsoOrNull(row?.created_at)
  );
}

/**
 * @returns {{ ok: true, event } | { ok: false, reason: string }}
 */
export function tryNormalizeAsistenciaEvent(row, { sede_id = null, deporte = null, fecha_partido = null } = {}) {
  if (row?.id == null && row?.match_id == null && row?.partido_id == null) {
    return { ok: false, reason: 'sin_id' };
  }
  const partidoId = row.match_id ?? row.partido_id;
  if (partidoId == null || partidoId === '') return { ok: false, reason: 'sin_partido' };

  const estado = mapAsistenciaEstadoPublico(row);
  if (!estado || !HISTORIAL_ASISTENCIA_ESTADOS.includes(estado)) {
    return { ok: false, reason: 'estado_desconocido' };
  }

  let occurred_at = resolveAsistenciaOccurredAt(row);
  const fechaPartidoIso = toIsoOrNull(fecha_partido) || toIsoOrNull(row.fecha_partido);
  // No usar fecha futura del partido como occurred_at de una respuesta no realizada.
  if (
    estado === 'pendiente'
    && fechaPartidoIso
    && occurred_at
    && occurred_at === fechaPartidoIso
    && new Date(fechaPartidoIso).getTime() > Date.now()
  ) {
    occurred_at = toIsoOrNull(row.created_at);
  }
  if (!occurred_at) return { ok: false, reason: 'sin_fecha' };

  const confirmado_en = toIsoOrNull(row.attendance_confirmed_at) || toIsoOrNull(row.confirmado_en);
  const respondido_en = toIsoOrNull(row.attendance_responded_at) || toIsoOrNull(row.respondido_en);
  let expirado_en = toIsoOrNull(row.expirado_en) || toIsoOrNull(row.expired_at);
  if (!expirado_en && estado === 'vencida') {
    expirado_en = respondido_en || toIsoOrNull(row.updated_at);
  }

  const resumenByEstado = {
    confirmada: 'Asistencia confirmada',
    rechazada: 'Asistencia rechazada',
    pendiente: 'Asistencia pendiente',
    vencida: 'Asistencia vencida',
    cancelada: 'Asistencia cancelada',
  };

  const refId = row.id != null ? String(row.id) : `match:${partidoId}`;
  const event = buildHistorialEvent({
    tipo: 'asistencia',
    refId,
    occurred_at,
    sede_id: sede_id ?? row.sede_id ?? null,
    titulo: 'Asistencia',
    resumen: resumenByEstado[estado],
    referenciaTipo: 'partido',
    referenciaId: String(partidoId),
    payload: {
      participante_id: row.id != null ? String(row.id) : null,
      partido_id: String(partidoId),
      estado,
      confirmado_en,
      respondido_en,
      expirado_en,
      deporte: deporte ?? row.deporte ?? null,
      fecha_partido: fechaPartidoIso,
    },
  });
  if (!event) return { ok: false, reason: 'sin_fecha' };
  return { ok: true, event };
}

export function resolveRankingCasualOccurredAt(row) {
  return (
    toIsoOrNull(row?.occurred_at)
    || toIsoOrNull(row?.awarded_at)
    || toIsoOrNull(row?.created_at)
    || toIsoOrNull(row?.updated_at)
  );
}

function mapRankingOutcome(meta, status) {
  const raw = String(meta?.outcome ?? meta?.resultado ?? '').trim().toLowerCase();
  if (!raw) return null;
  if (raw === 'win' || raw === 'victoria' || raw === 'ganado' || raw === 'ganador') {
    return 'victoria';
  }
  if (raw === 'loss' || raw === 'derrota' || raw === 'perdido' || raw === 'perdedor') {
    return 'derrota';
  }
  if (raw === 'draw' || raw === 'empate' || raw === 'empatado' || raw === 'tie') {
    return null; // Padbol: no usar empate; el caller excluye si hace falta
  }
  if (status === 'reversed') return null;
  return null;
}

/**
 * @returns {{ ok: true, event } | { ok: false, reason: string }}
 */
export function tryNormalizeRankingCasualEvent(row, { sede_id = null, deporte = null } = {}) {
  if (row?.id == null) return { ok: false, reason: 'sin_id' };
  if (String(row.reward_type || '').toLowerCase() !== 'ranking') {
    return { ok: false, reason: 'no_ranking' };
  }

  const status = String(row.status || '').trim().toLowerCase();
  // Solo movimientos con efecto real en el historial del jugador.
  if (status !== 'credited' && status !== 'reversed') {
    return { ok: false, reason: 'sin_efecto' };
  }

  if (containsEmpateSignal({
    outcome: row.metadata?.outcome,
    resultado: row.metadata?.resultado,
    motivo: row.metadata?.motivo,
  })) {
    return { ok: false, reason: 'empate' };
  }

  const occurred_at = resolveRankingCasualOccurredAt(row);
  if (!occurred_at) return { ok: false, reason: 'sin_fecha' };

  const meta = unwrapJsonValue(row.metadata) || {};
  const absAmount = Number(meta.rp != null ? meta.rp : row.amount);
  if (!Number.isFinite(absAmount)) {
    return { ok: false, reason: 'sin_delta' };
  }

  let rp_delta = absAmount;
  if (status === 'reversed') {
    rp_delta = absAmount > 0 ? -absAmount : absAmount;
  } else if (Number.isFinite(Number(row.amount)) && Number(row.amount) < 0) {
    rp_delta = Number(row.amount);
  }

  const rp_anterior = Number.isFinite(Number(meta.rp_anterior ?? meta.rp_before))
    ? Number(meta.rp_anterior ?? meta.rp_before)
    : null;
  const rp_nuevo = Number.isFinite(Number(meta.rp_nuevo ?? meta.rp_after))
    ? Number(meta.rp_nuevo ?? meta.rp_after)
    : null;
  // No usar puntos_totales como rp_nuevo: no es el par anterior/nuevo del ledger.

  const resultado = mapRankingOutcome(meta, status);
  if (
    String(meta.outcome || '').toLowerCase() === 'draw'
    || String(meta.outcome || '').toLowerCase() === 'empate'
  ) {
    return { ok: false, reason: 'empate' };
  }

  const partidoId = row.match_id != null ? String(row.match_id) : null;
  let motivo = null;
  if (status === 'reversed') motivo = 'reversion';
  else if (meta.mode != null) motivo = String(meta.mode);
  else if (meta.motivo != null) motivo = String(meta.motivo);

  let resumen = 'Ranking Casual';
  if (status === 'reversed') {
    resumen = `Reversión Ranking Casual · RP ${rp_delta}`;
  } else if (resultado === 'victoria') {
    resumen = `Ranking Casual · victoria · RP ${rp_delta > 0 ? `+${rp_delta}` : rp_delta}`;
  } else if (resultado === 'derrota') {
    resumen = `Ranking Casual · derrota · RP ${rp_delta > 0 ? `+${rp_delta}` : rp_delta}`;
  } else {
    resumen = `Ranking Casual · RP ${rp_delta > 0 ? `+${rp_delta}` : rp_delta}`;
  }

  const event = buildHistorialEvent({
    tipo: 'ranking_casual',
    refId: String(row.id),
    occurred_at,
    sede_id: sede_id ?? row.sede_id ?? null,
    titulo: 'Ranking Casual',
    resumen,
    referenciaTipo: 'partido',
    referenciaId: partidoId,
    payload: {
      evento_id: String(row.id),
      partido_id: partidoId,
      deporte: deporte ?? meta.deporte ?? row.deporte ?? null,
      rp_delta,
      rp_anterior,
      rp_nuevo,
      motivo,
      resultado,
    },
  });
  if (!event) return { ok: false, reason: 'sin_fecha' };
  return { ok: true, event };
}

export function filterHistorialEvents(events, {
  tipos = null,
  fecha_desde = null,
  fecha_hasta = null,
  sede_id = null,
  cursor = null,
} = {}) {
  let out = Array.isArray(events) ? [...events] : [];

  if (tipos && tipos.length) {
    const set = new Set(tipos);
    out = out.filter((e) => set.has(e.tipo));
  }
  if (fecha_desde) {
    out = out.filter((e) => String(e.occurred_at) >= fecha_desde);
  }
  if (fecha_hasta) {
    out = out.filter((e) => String(e.occurred_at) <= fecha_hasta);
  }
  if (sede_id != null) {
    out = out.filter((e) => e.sede_id != null && Number(e.sede_id) === Number(sede_id));
  }
  if (cursor) {
    out = out.filter((e) => isHistorialEventAfterCursor(e, cursor));
  }

  out.sort(compareHistorialEventsDesc);
  return out;
}

export function paginateHistorialEvents(events, limit) {
  const lim = Math.min(
    Math.max(1, Number(limit) || JUGADOR_HISTORIAL_LIMIT_DEFAULT),
    JUGADOR_HISTORIAL_LIMIT_MAX,
  );
  const has_more = events.length > lim;
  const items = events.slice(0, lim);
  const last = items[items.length - 1] || null;
  return {
    items,
    pagination: {
      limit: lim,
      next_cursor: has_more && last ? encodeHistorialCursor(last) : null,
      has_more,
    },
  };
}

export function normalizeReservaEvent(row) {
  if (!row?.id) return null;
  const scheduled = combineFechaHora(row.fecha, row.hora_inicio || row.hora);
  const occurred_at = scheduled || toIsoOrNull(row.created_at);
  if (!occurred_at) return null;
  const estado = String(row.estado || '').trim() || null;
  return buildHistorialEvent({
    tipo: 'reserva',
    refId: row.id,
    occurred_at,
    sede_id: row.sede_id ?? null,
    titulo: 'Reserva',
    resumen: estado ? `Reserva ${estado}` : 'Reserva',
    payload: {
      fecha: row.fecha ?? null,
      hora: row.hora ?? row.hora_inicio ?? null,
      cancha: row.cancha ?? null,
      estado,
      sede_nombre: row.sede ?? row.sede_nombre ?? null,
    },
  });
}

export function normalizePartidoEvent(row) {
  if (!row?.id) return null;
  const scheduled = combineFechaHora(row.fecha, row.hora);
  const occurred_at = scheduled || toIsoOrNull(row.created_at);
  if (!occurred_at) return null;
  const estado = String(row.estado || '').trim() || null;
  return buildHistorialEvent({
    tipo: 'partido',
    refId: row.id,
    occurred_at,
    sede_id: row.sede_id ?? null,
    titulo: 'Partido',
    resumen: estado ? `Partido ${estado}` : 'Partido',
    payload: {
      fecha: row.fecha ?? null,
      hora: row.hora ?? null,
      estado,
      deporte: row.deporte ?? null,
      sede_nombre: row.sede_nombre ?? row.sedes?.nombre ?? null,
      nivel: row.nivel ?? null,
    },
  });
}

export function normalizePadcoinsEvent(row) {
  if (!row?.id) return null;
  const occurred_at = toIsoOrNull(row.created_at);
  if (!occurred_at) return null;
  const monto = row.monto != null ? Number(row.monto) : null;
  const tipoMov = String(row.tipo || '').trim() || null;
  const sign = monto != null && monto >= 0 ? '+' : '';
  const resumen = tipoMov
    ? (monto != null && Number.isFinite(monto) ? `${tipoMov} (${sign}${monto})` : tipoMov)
    : 'Movimiento PadCoins';
  return buildHistorialEvent({
    tipo: 'padcoins',
    refId: row.id,
    occurred_at,
    sede_id: row.sede_id ?? null,
    titulo: 'PadCoins',
    resumen,
    payload: {
      tipo: tipoMov,
      monto: Number.isFinite(monto) ? monto : null,
      referencia_tipo: row.referencia_tipo ?? null,
      referencia_id: row.referencia_id != null ? String(row.referencia_id) : null,
      saldo_despues: row.saldo_despues != null ? Number(row.saldo_despues) : null,
    },
  });
}

export function normalizeMembresiaEvent(row) {
  if (!row?.id) return null;
  // Un evento por fila: preferir inicio (alta), luego created_at, luego vencimiento.
  const occurred_at =
    toIsoOrNull(row.inicio)
    || toIsoOrNull(row.created_at)
    || toIsoOrNull(row.vencimiento);
  if (!occurred_at) return null;
  const estado = String(row.estado || '').trim() || null;
  return buildHistorialEvent({
    tipo: 'membresia',
    refId: row.id,
    occurred_at,
    sede_id: row.sede_id ?? null,
    titulo: 'Membresía',
    resumen: estado ? `Membresía ${estado}` : 'Membresía',
    payload: {
      estado,
      plan_id: row.plan_id ?? null,
      inicio: row.inicio ?? null,
      vencimiento: row.vencimiento ?? null,
      origen: row.origen ?? null,
    },
  });
}

export function normalizeLogroEvent(row) {
  const slug = row?.slug || row?.logros?.codigo || null;
  const refId = row?.id != null ? row.id : (slug || null);
  if (refId == null || refId === '') return null;
  const occurred_at =
    toIsoOrNull(row.desbloqueado_en)
    || toIsoOrNull(row.contexto?.desbloqueado_en)
    || toIsoOrNull(row.created_at);
  if (!occurred_at) return null;
  const label = slug ? String(slug) : String(refId);
  return buildHistorialEvent({
    tipo: 'logro',
    refId,
    occurred_at,
    sede_id: null,
    titulo: 'Logro',
    resumen: `Logro desbloqueado: ${label}`,
    payload: {
      slug: slug ? String(slug) : null,
      logro_id: row.logro_id ?? null,
    },
  });
}

export function assertNoPrivateLeak(event) {
  const forbidden = [
    'email', 'telefono', 'whatsapp', 'documento', 'dni', 'password',
    'token', 'qr_token', 'access_token', 'refresh_token', 'role', 'rol',
    'mp_payment_id', 'mp_preference_id', 'notas', 'created_by',
  ];
  const blob = JSON.stringify(event);
  return !forbidden.some((k) => {
    const re = new RegExp(`"${k}"\\s*:`, 'i');
    return re.test(blob);
  });
}
