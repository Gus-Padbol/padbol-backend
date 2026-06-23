import express from 'express';
import { notifyPartidoJugadorUnido, sendPushToUser } from '../utils/push.js';
import { createNotificacion } from '../utils/notificaciones.js';
import { MatchSummaryPayloadError } from '../src/partidos/matchSummaryPayload.js';
import {
  MatchSummaryServiceError,
  generateMatchSummaryForPartido,
} from '../src/partidos/matchSummaryService.js';
import { procesarResultadoPartidoCasual } from '../src/partidos/resultadoService.js';
import {
  EquiposPartidoError,
  procesarActualizarNombresEquiposPartido,
  procesarDefinirEquiposPartido,
  resolveEquiposPartido,
} from '../src/partidos/equiposService.js';
import { generarIniciosMinutosSlotReserva, generarIniciosSmartSlots, minutosAHoraReserva } from '../lib/reservaSlotsHorarios.js';
import {
  normalizeHoraInicioReserva,
  computeHoraFinDesdeDuracion,
  resolveHoraInicioYFinReserva,
  reservaLegacyHoraText,
} from '../utils/reservasTime.js';
import { reservaHoraInicioFromRow } from '../utils/reservasColumns.js';
import { toPartidoPublicDto } from '../lib/dto/legacyPublic.js';
import { sendHttpError } from '../lib/httpErrors.js';

export {
  normalizeHoraInicioReserva,
  computeHoraFinDesdeDuracion,
  resolveHoraInicioYFinReserva,
  reservaLegacyHoraText,
} from '../utils/reservasTime.js';

function getTodayArgentinaDate() {
  const nowAR = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Argentina/Buenos_Aires' }));
  const year = nowAR.getFullYear();
  const month = String(nowAR.getMonth() + 1).padStart(2, '0');
  const day = String(nowAR.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** Fecha YYYY-MM-DD con offset manual UTC-3 (Argentina). */
function getTodayArgentinaDateUtcOffset() {
  const today = new Date();
  today.setHours(today.getHours() - 3);
  return today.toISOString().split('T')[0];
}

function formatHora(hora) {
  if (!hora) return null;
  return String(hora).slice(0, 5);
}

function parsePartidoId(id) {
  const partidoId = parseInt(id, 10);
  if (Number.isNaN(partidoId)) return null;
  return partidoId;
}

function isMatchPast(fecha, hora) {
  if (!fecha) return false;
  const time = hora ? String(hora).slice(0, 5) : '23:59';
  const matchDate = new Date(`${fecha}T${time}:00`);
  return !Number.isNaN(matchDate.getTime()) && matchDate.getTime() <= Date.now();
}

const OPEN_JOIN_STATES = ['abierto'];

const ACTIVE_PARTIDO_CREATION_STATES = ['abierto', 'completo'];
const ACTIVE_PARTIDO_LIMIT = 2;

// TODO: Reputation score — track cancellations per user per month; if > 2, restrict partido creation for 7 days
// TODO: No-show penalty — if partido expires without filling, count as cancellation for reputation
// TODO: Progressive bans — warning → 7 day suspension → permanent ban
// TODO: Prepago — require capitán to pay cancha upfront when creating partido

async function countActiveCapitanPartidos(supabaseAdmin, userId) {
  const today = getTodayArgentinaDate();
  const { data, error } = await supabaseAdmin
    .from('partidos_abiertos')
    .select('id')
    .eq('capitan_user_id', userId)
    .in('estado', ACTIVE_PARTIDO_CREATION_STATES)
    .gte('fecha', today);

  if (error) throw error;
  return (data ?? []).length;
}

function activePartidoLimitResponse(res) {
  return res.status(400).json({
    error: 'limite_partidos_activos',
    message: 'Máximo 2 partidos activos simultáneos',
  });
}

const PARTIDO_SELECT = `
  id,
  sede_id,
  sede_nombre,
  cancha,
  reserva_id,
  capitan_user_id,
  capitan_email,
  capitan_nombre,
  capitan_foto_url,
  fecha,
  hora,
  nivel,
  estado,
  jugadores_confirmados,
  jugadores_requeridos,
  deadline_cancel,
  pago_url,
  ganador,
  resultado,
  equipos_asignacion,
  deporte,
  created_at,
  sedes ( nombre, direccion, ciudad, pais ),
  partidos_abiertos_jugadores ( user_id, email, joined_at )
`;

function getCapitanUserId(partido) {
  return partido.capitan_user_id ?? partido.host_user_id ?? null;
}

function getCapitanEmail(partido) {
  return partido.capitan_email ?? partido.host_email ?? null;
}

function getJugadoresConfirmados(partido, fallback = null) {
  return partido.jugadores_confirmados ?? partido.jugadores_actuales ?? fallback;
}

function getJugadoresRequeridos(partido) {
  return partido.jugadores_requeridos ?? partido.jugadores_necesarios ?? 4;
}

function emailLocalPart(email) {
  if (!email) return null;
  const localPart = String(email).split('@')[0]?.trim();
  return localPart || null;
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function resolveCapitanNombreFromPerfil(perfil, email) {
  if (perfil) {
    const fromProfile =
      perfil.nombre_saludo
      ?? perfil.apodo
      ?? perfil.nombre
      ?? null;

    if (fromProfile && String(fromProfile).trim()) {
      return String(fromProfile).trim();
    }
  }

  return emailLocalPart(email) ?? 'Capitán';
}

async function fetchCapitanPerfil(supabaseAdmin, userId, email) {
  const filters = [];
  if (userId) {
    filters.push(`user_id.eq.${userId}`);
  }
  if (email) {
    filters.push(`email.eq."${String(email).replace(/"/g, '\\"')}"`);
  }

  if (filters.length === 0) return null;

  const { data, error } = await supabaseAdmin
    .from('jugadores_perfil')
    .select('nombre_saludo, apodo, nombre, apellido, email, foto_url')
    .or(filters.join(','))
    .maybeSingle();

  if (error) throw error;
  return data;
}

export async function buildCapitanFields(supabaseAdmin, user, { email } = {}) {
  const capitanEmail = email ?? user?.email ?? null;
  const perfil = await fetchCapitanPerfil(supabaseAdmin, user?.id, capitanEmail);
  const metadata = user?.user_metadata ?? {};

  return {
    capitan_user_id: user.id,
    capitan_email: capitanEmail,
    capitan_nombre: resolveCapitanNombreFromPerfil(perfil, capitanEmail),
    capitan_foto_url: perfil?.foto_url ?? metadata.avatar_url ?? metadata.picture ?? null,
  };
}

function computeDeadlineCancel(fecha, hora) {
  const time = hora ? String(hora).slice(0, 5) : '00:00';
  const matchDate = new Date(`${fecha}T${time}:00-03:00`);
  if (Number.isNaN(matchDate.getTime())) {
    return new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  }
  return new Date(matchDate.getTime() - 8 * 60 * 60 * 1000).toISOString();
}

function normalizeReservaCancha(cancha) {
  if (cancha == null || cancha === '') return null;
  return String(cancha);
}

export function parsePositiveInt(value) {
  if (value == null || value === '') return null;
  const parsed = parseInt(value, 10);
  return Number.isNaN(parsed) ? null : parsed;
}

export function logPartidoCanchaBody(body = {}, label = 'partido') {
  console.log(`[${label}] cancha body:`, {
    cancha: body.cancha ?? null,
    cancha_id: body.cancha_id ?? null,
    cancha_nombre: body.cancha_nombre ?? null,
    canchaSeleccionada: body.canchaSeleccionada ?? null,
    sede_id: body.sede_id ?? null,
    sede: body.sede ?? null,
  });
}

export function resolvePartidoCanchaId(body = {}) {
  const fromId = parsePositiveInt(body.cancha_id);
  if (fromId != null) return fromId;

  const textRaw = body.cancha ?? body.cancha_nombre ?? body.canchaSeleccionada;
  if (textRaw == null || String(textRaw).trim() === '') return null;

  const str = String(textRaw).trim();
  const labeled = str.match(/^cancha\s*(\d+)$/i);
  if (labeled) return parsePositiveInt(labeled[1]);
  if (/^\d+$/.test(str)) return parsePositiveInt(str);
  return null;
}

export function resolvePartidoCanchaNombre(body = {}) {
  const textRaw = body.cancha ?? body.cancha_nombre ?? body.canchaSeleccionada;
  if (textRaw != null && String(textRaw).trim() !== '') {
    const str = String(textRaw).trim();
    if (/^\d+$/.test(str)) return `Cancha ${str}`;
    return str;
  }

  const canchaId = resolvePartidoCanchaId(body);
  if (canchaId != null) return `Cancha ${canchaId}`;
  return 'Cancha 1';
}

export function resolveReservaCanchaText(body = {}) {
  return resolvePartidoCanchaNombre(body);
}

/** Numeric court id as text for reservas.cancha queries and inserts ("1", "2"). */
export function resolveReservaCanchaQueryText(canchaInput) {
  if (canchaInput == null || canchaInput === '') return '1';
  if (typeof canchaInput === 'number' && !Number.isNaN(canchaInput)) {
    return String(canchaInput);
  }
  if (typeof canchaInput === 'object') {
    const numeric = resolvePartidoCanchaId(canchaInput);
    return numeric != null ? String(numeric) : '1';
  }

  const str = String(canchaInput).trim();
  const numeric = resolvePartidoCanchaId({ cancha: str, cancha_id: str });
  return numeric != null ? String(numeric) : '1';
}

export function resolveReservaCanchaStorageText(body = {}) {
  return resolveReservaCanchaQueryText(body);
}

function asText(value, fallback = null) {
  if (value == null || value === '') return fallback;
  return String(value);
}

export function buildReservaInsertRow({
  sedeNombre,
  sedeId,
  fecha,
  hora,
  hora_inicio,
  hora_fin,
  canchaText,
  cancha_id,
  nombre,
  email,
  telefono,
  whatsapp,
  nivel,
  precio,
  estado,
  pago_estado,
  duracion_minutos,
  user_id,
}) {
  const horas = resolveHoraInicioYFinReserva({
    hora,
    hora_inicio,
    hora_fin,
    duracion_minutos,
  });

  const row = {
    sede: asText(sedeNombre),
    fecha: asText(fecha),
    hora: reservaLegacyHoraText(horas.hora_inicio, horas.hora_fin) ?? asText(horas.hora_inicio ?? hora),
    hora_inicio: horas.hora_inicio,
    hora_fin: horas.hora_fin,
    cancha: asText(canchaText),
    nombre: asText(nombre),
    email: asText(email),
    telefono: asText(telefono ?? whatsapp ?? '', ''),
    whatsapp: asText(whatsapp ?? telefono ?? '', ''),
    nivel: asText(nivel),
    precio: parsePositiveInt(precio) ?? 0,
    estado: asText(estado),
    duracion_minutos: horas.duracion_minutos,
    user_id: user_id ?? null,
  };

  const sid = parsePositiveInt(sedeId);
  if (sid != null) row.sede_id = sid;

  const cid = parsePositiveInt(cancha_id);
  if (cid != null) row.cancha_id = cid;

  if (pago_estado != null && pago_estado !== undefined) {
    row.pago_estado = asText(pago_estado);
  }

  delete row.canchaSeleccionada;
  delete row.cancha_nombre;

  return row;
}

export async function resolveSedeRow(supabaseAdmin, { sede_id, sede, sede_nombre }) {
  const byId = parsePositiveInt(sede_id);
  if (byId != null) {
    const { data, error } = await supabaseAdmin
      .from('sedes')
      .select('id, nombre')
      .eq('id', byId)
      .maybeSingle();
    if (error) throw error;
    if (data) return data;
  }

  const nombre = [sede, sede_nombre].find((value) => value != null && String(value).trim() !== '');
  if (nombre) {
    const { data, error } = await supabaseAdmin
      .from('sedes')
      .select('id, nombre')
      .eq('nombre', String(nombre).trim())
      .maybeSingle();
    if (error) throw error;
    if (data) return data;
  }

  return null;
}

function requirePositiveInt(value, fieldName) {
  const parsed = parsePositiveInt(value);
  if (parsed == null) {
    throw new Error(`${fieldName} inválido para partido abierto: ${JSON.stringify(value)}`);
  }
  return parsed;
}

export function buildPartidoAbiertoInsertRow({
  sedeRow,
  body = {},
  reservaId = null,
  canchaNombre,
  capitanFields = {},
  fecha,
  hora,
  nivel,
  estado = 'abierto',
  jugadoresConfirmados = 1,
  jugadoresRequeridos = 4,
  deadlineCancel = null,
  duracionMinutos = null,
}) {
  const sedeId = requirePositiveInt(sedeRow?.id, 'sede_id');

  const row = {
    ...capitanFields,
    sede_id: sedeId,
    sede_nombre: asText(sedeRow?.nombre),
    cancha: asText(canchaNombre),
    fecha: asText(fecha),
    hora: asText(hora),
    nivel: asText(nivel),
    estado: asText(estado),
    deporte: (body.deporte || 'padbol').toLowerCase(),
    jugadores_confirmados: requirePositiveInt(jugadoresConfirmados ?? 1, 'jugadores_confirmados'),
    jugadores_requeridos: requirePositiveInt(jugadoresRequeridos ?? 4, 'jugadores_requeridos'),
  };

  if (reservaId != null) {
    row.reserva_id = requirePositiveInt(reservaId, 'reserva_id');
  }

  const parsedDuration = parsePositiveInt(duracionMinutos ?? body.duracion_minutos ?? body.duracion);
  if (parsedDuration != null) {
    row.duracion_minutos = parsedDuration;
  }

  if (deadlineCancel) {
    row.deadline_cancel = deadlineCancel;
  }

  delete row.cancha_id;
  delete row.sede;
  delete row.canchaSeleccionada;
  delete row.cancha_nombre;

  return row;
}

async function cancelPartidoWithReserva(supabaseAdmin, partidoId, reservaId, partidoEstado) {
  if (reservaId) {
    await supabaseAdmin
      .from('reservas')
      .update({ estado: 'cancelada', pago_estado: 'no_aplica' })
      .eq('id', reservaId);
  }

  await supabaseAdmin
    .from('partidos_abiertos')
    .update({ estado: partidoEstado })
    .eq('id', partidoId);
}

export const BLOCKING_RESERVA_ESTADOS = ['confirmada', 'pendiente', 'prereserva'];

export function isBlockingReserva(reserva, nowMs = Date.now()) {
  void nowMs;
  if (!reserva?.estado) return false;
  return BLOCKING_RESERVA_ESTADOS.includes(String(reserva.estado).toLowerCase());
}

export function isReservaSlotUniqueViolation(err) {
  if (!err) return false;
  if (String(err.code) === '23505') return true;
  const text = [
    err.message,
    err.details,
    err.hint,
    err.constraint,
  ].filter(Boolean).join(' ').toLowerCase();
  return text.includes('duplicate key')
    || text.includes('idx_reservas_slot_blocking_unique');
}

export function filterBlockingReservas(reservas, nowMs = Date.now()) {
  return (reservas ?? []).filter((reserva) => isBlockingReserva(reserva, nowMs));
}

const PARTIDO_BLOCKING_STATES = ['abierto', 'completo'];

function parseTimeToMinutes(time) {
  const [hours, minutes] = String(time ?? '').slice(0, 5).split(':').map(Number);
  if (Number.isNaN(hours) || Number.isNaN(minutes)) return 0;
  return hours * 60 + minutes;
}

function minutesToTime(totalMinutes) {
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

/** Turnos desde horario_apertura / horario_cierre de la sede (duración por defecto 90 min). */
function generateSlotTimes(sedeOrApertura, cierreOrFecha, duracionMinutos, fechaISO = null) {
  const duration = duracionMinutos > 0 ? duracionMinutos : 90;
  if (sedeOrApertura && typeof sedeOrApertura === 'object' && !Array.isArray(sedeOrApertura)) {
    const sede = sedeOrApertura;
    const fecha = fechaISO || getTodayArgentinaDate();
    const inicios = generarIniciosMinutosSlotReserva(sede, fecha, duration, 30);
    return inicios.map((m) => minutosAHoraReserva(m));
  }
  const start = parseTimeToMinutes(sedeOrApertura || '18:00');
  const end = parseTimeToMinutes(cierreOrFecha || '23:00');
  const slots = [];
  for (let current = start; current + duration <= end; current += 30) {
    slots.push(minutesToTime(current));
  }
  return slots;
}

export function parseCourtNumberFromStorage(cancha) {
  return resolvePartidoCanchaId({ cancha });
}

export function isReservaBlockingSlot(reserva, { hora, canchaNum }, nowMs = Date.now()) {
  if (!isBlockingReserva(reserva, nowMs)) return false;
  if (formatHora(reservaHoraInicioFromRow(reserva)) !== formatHora(hora)) return false;
  const court = resolveReservaCanchaQueryText(reserva.cancha ?? reserva.cancha_id);
  return Number(court) === canchaNum;
}

export function isPartidoBlockingSlot(partido, { hora, canchaNum }) {
  if (!PARTIDO_BLOCKING_STATES.includes(partido?.estado)) return false;
  if (formatHora(partido.hora) !== formatHora(hora)) return false;
  return parseCourtNumberFromStorage(partido.cancha) === canchaNum;
}

function formatPartidoSlotPayload(partido) {
  return {
    id: partido.id,
    jugadores_confirmados: getJugadoresConfirmados(partido, 0) ?? 0,
    jugadores_requeridos: getJugadoresRequeridos(partido),
    nivel: partido.nivel ?? null,
  };
}

function getPartidoLugaresLibres(partido) {
  const requeridos = getJugadoresRequeridos(partido);
  const confirmados = getJugadoresConfirmados(partido, 0) ?? 0;
  return Math.max(0, requeridos - confirmados);
}

function getHoraUnavailableInfo(hora, totalCourts, blockingReservas, blockingPartidos, nowMs) {
  let reservaBlocked = false;
  let bestPartido = null;
  let bestLugares = -1;

  for (let cancha = 1; cancha <= totalCourts; cancha += 1) {
    const partido = (blockingPartidos ?? []).find(
      (row) => isPartidoBlockingSlot(row, { hora, canchaNum: cancha }),
    );
    if (partido) {
      const lugares = getPartidoLugaresLibres(partido);
      if (lugares > bestLugares) {
        bestLugares = lugares;
        bestPartido = partido;
      }
      continue;
    }

    const takenByReserva = (blockingReservas ?? []).some(
      (reserva) => isReservaBlockingSlot(reserva, { hora, canchaNum: cancha }, nowMs),
    );
    if (takenByReserva) reservaBlocked = true;
  }

  if (bestPartido) {
    return {
      blocked: true,
      motivo: 'partido_abierto',
      partido: formatPartidoSlotPayload(bestPartido),
    };
  }

  if (reservaBlocked) {
    return { blocked: true, motivo: 'reservado' };
  }

  return { blocked: true, motivo: 'reservado' };
}

function buildUnavailableSlot(hora, info, cancha = null, canchasLibres = 0) {
  const slot = {
    hora,
    disponible: false,
    cancha,
    canchas_libres: canchasLibres,
    motivo: info.motivo ?? 'reservado',
  };
  if (info.partido) {
    slot.partido = info.partido;
  }
  return slot;
}

function buildAvailableSlot(hora, cancha, canchasLibres) {
  return {
    hora,
    disponible: true,
    cancha,
    canchas_libres: canchasLibres,
  };
}

function evaluateHoraCourts(hora, totalCourts, blockingReservas, blockingPartidos, nowMs) {
  const freeCourts = [];
  const partidoSlots = [];

  for (let cancha = 1; cancha <= totalCourts; cancha += 1) {
    const info = slotBlockingInfo(
      { hora, canchaNum: cancha },
      blockingReservas,
      blockingPartidos,
      nowMs,
    );

    if (!info.blocked) {
      freeCourts.push(cancha);
      continue;
    }

    if (info.motivo === 'partido_abierto' && info.partido) {
      const lugaresLibres = Math.max(
        0,
        (info.partido.jugadores_requeridos ?? 4) - (info.partido.jugadores_confirmados ?? 0),
      );
      if (lugaresLibres > 0) {
        partidoSlots.push({ cancha, partido: info.partido, lugaresLibres });
      }
    }
  }

  return {
    freeCourts,
    partidoSlots,
    canchasLibres: freeCourts.length,
  };
}

function slotBlockingInfo({ hora, canchaNum }, blockingReservas, blockingPartidos, nowMs) {
  const partido = (blockingPartidos ?? []).find(
    (row) => isPartidoBlockingSlot(row, { hora, canchaNum }),
  );
  if (partido) {
    return {
      blocked: true,
      motivo: 'partido_abierto',
      partido: formatPartidoSlotPayload(partido),
    };
  }

  const reservaHit = (blockingReservas ?? []).some(
    (reserva) => isReservaBlockingSlot(reserva, { hora, canchaNum }, nowMs),
  );
  if (reservaHit) {
    return { blocked: true, motivo: 'reservado' };
  }

  return { blocked: false, motivo: null };
}

function compareHoraSort(a, b) {
  return parseTimeToMinutes(a) - parseTimeToMinutes(b);
}

function mergeSlotTimeCandidates(smartTimes, gridTimes, availabilityCtx) {
  const merged = new Set(smartTimes);
  for (const hora of gridTimes) {
    if (merged.has(hora)) continue;
    const { canchasLibres } = evaluateHoraCourts(
      hora,
      availabilityCtx.totalCourts,
      availabilityCtx.blockingReservas,
      availabilityCtx.blockingPartidos,
      availabilityCtx.nowMs,
    );
    if (canchasLibres >= 1) {
      merged.add(hora);
    }
  }
  return [...merged].sort(compareHoraSort);
}

function mergeReservasById(rowsA, rowsB) {
  const map = new Map();
  for (const row of [...(rowsA ?? []), ...(rowsB ?? [])]) {
    if (row?.id != null) map.set(String(row.id), row);
  }
  return [...map.values()];
}

export async function fetchDisponibilidadOccupancy(supabaseAdmin, { sedeId, sedeNombre, fecha }) {
  const selectCols = 'id, hora, hora_inicio, hora_fin, cancha, cancha_id, estado, created_at, sede, sede_id, duracion_minutos';
  const queries = [];

  if (sedeId != null) {
    queries.push(
      supabaseAdmin.from('reservas').select(selectCols).eq('fecha', fecha).eq('sede_id', sedeId),
    );
  }
  if (sedeNombre) {
    queries.push(
      supabaseAdmin.from('reservas').select(selectCols).eq('fecha', fecha).eq('sede', sedeNombre),
    );
  }

  if (!queries.length) {
    return { reservas: [], partidos: [] };
  }

  const results = await Promise.all(queries);
  for (const r of results) {
    if (r.error) throw r.error;
  }

  const reservas = mergeReservasById(
    results.flatMap((r) => r.data ?? []),
  );

  const { data: partidos, error: partidosErr } = await supabaseAdmin
    .from('partidos_abiertos')
    .select('id, hora, cancha, estado, jugadores_confirmados, jugadores_requeridos, nivel')
    .eq('sede_id', sedeId)
    .eq('fecha', fecha)
    .in('estado', PARTIDO_BLOCKING_STATES);

  if (partidosErr) throw partidosErr;

  return {
    reservas: filterBlockingReservas(reservas ?? []),
    partidos: partidos ?? [],
  };
}

export async function buildDisponibilidadSlots(
  supabaseAdmin,
  { sedeId, fecha, duracionMinutos, expandCourts = false },
) {
  const { data: sede, error: sedeErr } = await supabaseAdmin
    .from('sedes')
    .select(
      'id, nombre, horario_apertura, horario_cierre, cantidad_canchas, precio_60min, precio_90min, precio_120min, precio_turno, precio_por_reserva',
    )
    .eq('id', sedeId)
    .maybeSingle();

  if (sedeErr) throw sedeErr;
  if (!sede) return null;

  const { reservas: blockingReservas, partidos: blockingPartidos } = await fetchDisponibilidadOccupancy(
    supabaseAdmin,
    { sedeId, sedeNombre: sede.nombre, fecha },
  );

  const smartInicios = generarIniciosSmartSlots(
    sede,
    fecha,
    duracionMinutos,
    blockingReservas,
    blockingPartidos,
  );
  const smartTimes = smartInicios.length > 0
    ? smartInicios.map((m) => minutosAHoraReserva(m))
    : [];
  const gridTimes = generateSlotTimes(sede, null, duracionMinutos, fecha);
  const totalCourts = sede.cantidad_canchas || 1;
  const nowMs = Date.now();
  const availabilityCtx = {
    totalCourts,
    blockingReservas,
    blockingPartidos,
    nowMs,
  };
  const slotTimes = smartTimes.length > 0
    ? mergeSlotTimeCandidates(smartTimes, gridTimes, availabilityCtx)
    : gridTimes;

  if (expandCourts) {
    return slotTimes.flatMap((hora) => {
      const { freeCourts, partidoSlots, canchasLibres } = evaluateHoraCourts(
        hora,
        totalCourts,
        blockingReservas,
        blockingPartidos,
        nowMs,
      );
      const cards = [];

      for (const cancha of freeCourts) {
        cards.push(buildAvailableSlot(hora, cancha, canchasLibres));
      }

      for (const { cancha, partido } of partidoSlots) {
        cards.push({
          hora,
          disponible: false,
          cancha,
          canchas_libres: canchasLibres,
          motivo: 'partido_abierto',
          partido,
        });
      }

      if (cards.length === 0) {
        const unavailableInfo = getHoraUnavailableInfo(
          hora,
          totalCourts,
          blockingReservas,
          blockingPartidos,
          nowMs,
        );
        return [buildUnavailableSlot(hora, unavailableInfo, null, 0)];
      }

      return cards;
    });
  }

  return slotTimes.map((hora) => {
    const { freeCourts, partidoSlots, canchasLibres } = evaluateHoraCourts(
      hora,
      totalCourts,
      blockingReservas,
      blockingPartidos,
      nowMs,
    );

    if (canchasLibres > 0) {
      return buildAvailableSlot(hora, freeCourts[0], canchasLibres);
    }

    if (partidoSlots.length > 0) {
      const bestPartido = partidoSlots.reduce(
        (best, current) => (current.lugaresLibres > best.lugaresLibres ? current : best),
      );
      return buildUnavailableSlot(
        hora,
        { blocked: true, motivo: 'partido_abierto', partido: bestPartido.partido },
        bestPartido.cancha,
        0,
      );
    }

    const info = getHoraUnavailableInfo(
      hora,
      totalCourts,
      blockingReservas,
      blockingPartidos,
      nowMs,
    );
    return buildUnavailableSlot(hora, info, null, 0);
  });
}

async function resolveSedeIdFromNombre(supabaseAdmin, sedeNombre) {
  if (!sedeNombre) return null;
  const { data, error } = await supabaseAdmin
    .from('sedes')
    .select('id')
    .eq('nombre', sedeNombre)
    .maybeSingle();
  if (error) throw error;
  return data?.id ?? null;
}

async function isCourtBlocked(supabaseAdmin, { sedeNombre, sedeId, fecha, hora, cancha }) {
  if (!sedeNombre && sedeId == null) return false;

  const canchaValue = resolveReservaCanchaQueryText(cancha);
  const canchaNum = Number(canchaValue);
  const horaSlot = formatHora(hora);
  const resolvedSedeId = sedeId ?? await resolveSedeIdFromNombre(supabaseAdmin, sedeNombre);

  if (sedeNombre || resolvedSedeId != null) {
    const selectCols = 'id, hora, hora_inicio, hora_fin, cancha, estado, created_at, sede, sede_id, duracion_minutos';
    const queries = [];
    if (resolvedSedeId != null) {
      queries.push(
        supabaseAdmin.from('reservas').select(selectCols).eq('fecha', fecha).eq('sede_id', resolvedSedeId).in('estado', BLOCKING_RESERVA_ESTADOS),
      );
    }
    if (sedeNombre) {
      queries.push(
        supabaseAdmin.from('reservas').select(selectCols).eq('fecha', fecha).eq('sede', sedeNombre).in('estado', BLOCKING_RESERVA_ESTADOS),
      );
    }

    const results = await Promise.all(queries);
    for (const r of results) {
      if (r.error) throw r.error;
    }

    const merged = mergeReservasById(results.flatMap((r) => r.data ?? []));
    const hit = filterBlockingReservas(merged).some(
      (reserva) => formatHora(reservaHoraInicioFromRow(reserva)) === horaSlot
        && Number(resolveReservaCanchaQueryText(reserva.cancha)) === canchaNum,
    );
    if (hit) return true;
  }

  if (resolvedSedeId == null) return false;

  const { data: partidos, error: partidosErr } = await supabaseAdmin
    .from('partidos_abiertos')
    .select('hora, cancha, estado')
    .eq('sede_id', resolvedSedeId)
    .eq('fecha', fecha)
    .in('estado', PARTIDO_BLOCKING_STATES);

  if (partidosErr) throw partidosErr;

  return (partidos ?? []).some(
    (partido) => isPartidoBlockingSlot(partido, { hora, canchaNum }),
  );
}

export { isCourtBlocked };

export async function cancelExpiredPartidos(supabaseAdmin) {
  const now = new Date().toISOString();
  const { data: partidos, error } = await supabaseAdmin
    .from('partidos_abiertos')
    .select('id, reserva_id, jugadores_confirmados, jugadores_requeridos')
    .eq('estado', 'abierto')
    .lte('deadline_cancel', now);

  if (error) throw error;
  if (!partidos?.length) return 0;

  let cancelled = 0;
  for (const partido of partidos) {
    const needed = getJugadoresRequeridos(partido);
    const current = getJugadoresConfirmados(partido, 0) ?? 0;
    if (current >= needed) continue;

    await cancelPartidoWithReserva(
      supabaseAdmin,
      partido.id,
      partido.reserva_id,
      'cancelado',
    );
    cancelled += 1;
    console.log(`✓ Partido ${partido.id} cancelado por deadline`);
  }

  return cancelled;
}

async function resolveHostName(partido, supabaseAdmin) {
  if (partido.capitan_nombre) return partido.capitan_nombre;

  const capitanUserId = getCapitanUserId(partido);
  const capitanEmail = getCapitanEmail(partido);
  const filters = [];
  if (capitanUserId) {
    filters.push(`user_id.eq.${capitanUserId}`);
  }
  if (capitanEmail) {
    filters.push(`email.eq."${String(capitanEmail).replace(/"/g, '\\"')}"`);
  }

  if (filters.length > 0) {
    const { data: perfil } = await supabaseAdmin
      .from('jugadores_perfil')
      .select('nombre, email')
      .or(filters.join(','))
      .maybeSingle();

    if (perfil?.nombre) return perfil.nombre;
    if (perfil?.email) return perfil.email;
  }

  return capitanEmail ?? 'Anfitrión';
}

async function resolveCapitanFotoUrl(partido, supabaseAdmin) {
  if (isNonEmptyString(partido.capitan_foto_url)) {
    return String(partido.capitan_foto_url).trim();
  }

  const capitanUserId = getCapitanUserId(partido);
  if (!capitanUserId) return null;

  const { data: perfil, error } = await supabaseAdmin
    .from('jugadores_perfil')
    .select('foto_url')
    .eq('user_id', capitanUserId)
    .maybeSingle();

  if (error) throw error;
  return isNonEmptyString(perfil?.foto_url) ? String(perfil.foto_url).trim() : null;
}

async function resolveJugadorName({ user_id: userId, email }, supabaseAdmin) {
  const filters = [];
  if (userId) filters.push(`user_id.eq.${userId}`);
  if (email) filters.push(`email.eq."${String(email).replace(/"/g, '\\"')}"`);

  if (filters.length > 0) {
    const { data: perfil } = await supabaseAdmin
      .from('jugadores_perfil')
      .select('nombre, email')
      .or(filters.join(','))
      .maybeSingle();

    if (perfil?.nombre) return perfil.nombre;
    if (perfil?.email) return perfil.email;
  }

  return email ?? 'Jugador';
}

async function userCanAccessPartido(partidoId, user, supabaseAdmin) {
  const { data: partido, error } = await supabaseAdmin
    .from('partidos_abiertos')
    .select('id, capitan_user_id, estado, fecha, hora')
    .eq('id', partidoId)
    .maybeSingle();

  if (error) throw error;
  if (!partido) return { allowed: false, status: 404, reason: 'Partido no encontrado' };
  if (getCapitanUserId(partido) === user.id) return { allowed: true, partido };

  const { data: joinRow, error: joinErr } = await supabaseAdmin
    .from('partidos_abiertos_jugadores')
    .select('id')
    .eq('partido_id', partidoId)
    .eq('user_id', user.id)
    .maybeSingle();

  if (joinErr) throw joinErr;
  if (!joinRow) {
    return { allowed: false, status: 403, reason: 'No tenés permiso para modificar este partido' };
  }

  return { allowed: true, partido };
}

function mapJugadorRowFromPerfil(row, perfil) {
  const mapped = mapSolicitanteFromPerfil(perfil);

  return {
    user_id: row.user_id,
    email: row.email ?? perfil?.email ?? null,
    joined_at: row.joined_at ?? null,
    nombre: mapped.nombre,
    apodo: mapped.apodo,
    username: mapped.username,
    nombre_saludo: mapped.nombre_saludo,
    foto_url: mapped.foto_url,
  };
}

async function fetchPerfilesByUserIds(supabaseAdmin, userIds) {
  const uniqueIds = [...new Set((userIds ?? []).filter(Boolean))];
  if (uniqueIds.length === 0) return {};

  const { data, error } = await supabaseAdmin
    .from('jugadores_perfil')
    .select('nombre, nombre_saludo, apodo, username, foto_url, nivel, email, user_id')
    .in('user_id', uniqueIds);

  if (error) throw error;

  const map = {};
  (data ?? []).forEach((perfil) => {
    if (perfil?.user_id) map[perfil.user_id] = perfil;
  });
  return map;
}

async function enrichPartidoJugadoresRows(jugadoresRows, supabaseAdmin, { capitanUserId, capitanEmail } = {}) {
  const sorted = [...(jugadoresRows ?? [])].sort(
    (a, b) => new Date(a.joined_at ?? 0) - new Date(b.joined_at ?? 0),
  );

  if (
    capitanUserId
    && !sorted.some((row) => row.user_id && String(row.user_id) === String(capitanUserId))
  ) {
    sorted.unshift({
      user_id: capitanUserId,
      email: capitanEmail ?? null,
      joined_at: null,
    });
  }

  const userIds = sorted.map((row) => row.user_id).filter(Boolean);
  const perfilByUserId = await fetchPerfilesByUserIds(supabaseAdmin, userIds);

  const enriched = await Promise.all(
    sorted.map(async (row) => {
      let perfil = row.user_id ? perfilByUserId[row.user_id] ?? null : null;

      if (!perfil) {
        perfil = await fetchJugadorPerfilPublic(supabaseAdmin, row.user_id, row.email);
      }

      return mapJugadorRowFromPerfil(row, perfil);
    }),
  );

  return enriched;
}

async function mapPartidoRow(partido, supabaseAdmin, user = null) {
  const hostNombre = await resolveHostName(partido, supabaseAdmin);
  const capitanFotoUrl = await resolveCapitanFotoUrl(partido, supabaseAdmin);
  const jugadoresRows = [...(partido.partidos_abiertos_jugadores ?? [])];
  const capitanUserId = getCapitanUserId(partido);
  const capitanEmail = getCapitanEmail(partido);
  const enrichedJugadores = await enrichPartidoJugadoresRows(jugadoresRows, supabaseAdmin, {
    capitanUserId,
    capitanEmail,
  });
  const participantUserIds = enrichedJugadores.map((row) => row.user_id).filter(Boolean);
  const jugadoresActuales = getJugadoresConfirmados(partido, jugadoresRows.length) ?? jugadoresRows.length;
  const maxJugadores = getJugadoresRequeridos(partido);

  return {
    id: partido.id,
    sede_id: partido.sede_id,
    reserva_id: partido.reserva_id ?? null,
    sede_nombre: partido.sede_nombre ?? partido.sedes?.nombre ?? null,
    sede_direccion: partido.sedes?.direccion ?? null,
    sede_ciudad: partido.sedes?.ciudad ?? null,
    sede_pais: partido.sedes?.pais ?? null,
    cancha: partido.cancha ?? null,
    fecha: partido.fecha,
    hora: formatHora(partido.hora),
    nivel: partido.nivel,
    estado: partido.estado ?? 'abierto',
    jugadores_actuales: jugadoresActuales,
    jugadores_count: jugadoresActuales,
    jugadores_necesarios: maxJugadores,
    max_jugadores: maxJugadores,
    lugares_disponibles: Math.max(0, maxJugadores - jugadoresActuales),
    deadline_cancel: partido.deadline_cancel ?? null,
    pago_url: partido.pago_url ?? null,
    capitan_nombre: partido.capitan_nombre ?? hostNombre,
    capitan_user_id: capitanUserId,
    capitan_foto_url: capitanFotoUrl,
    host_nombre: hostNombre,
    host_email: capitanEmail,
    host_user_id: capitanUserId,
    participant_user_ids: participantUserIds,
    partidos_abiertos_jugadores: enrichedJugadores,
    es_anfitrion: user ? capitanUserId === user.id : false,
    soy_participante: user
      ? participantUserIds.includes(user.id) || capitanUserId === user.id
      : false,
    deporte: partido.deporte ?? 'padbol',
    ganador: partido.ganador ?? null,
    resultado: partido.resultado ?? null,
    created_at: partido.created_at,
  };
}

async function mapPartidoPublicRow(partido, supabaseAdmin, user = null) {
  const full = await mapPartidoRow(partido, supabaseAdmin, user);
  return toPartidoPublicDto(full);
}

async function countPartidosJugados(supabaseAdmin, userId) {
  if (!userId) return 0;

  const { count, error } = await supabaseAdmin
    .from('partidos_abiertos_jugadores')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', userId);

  if (error) throw error;
  return count ?? 0;
}

async function fetchJugadorPerfilPublic(supabaseAdmin, userId, email) {
  const filters = [];
  if (userId) filters.push(`user_id.eq.${userId}`);
  if (email) filters.push(`email.eq."${String(email).replace(/"/g, '\\"')}"`);

  if (filters.length === 0) return null;

  const { data, error } = await supabaseAdmin
    .from('jugadores_perfil')
    .select('nombre, nombre_saludo, apodo, username, foto_url, nivel, email, user_id')
    .or(filters.join(','))
    .maybeSingle();

  if (error) throw error;
  return data;
}

function mapSolicitanteFromPerfil(perfil) {
  if (!perfil) {
    return {
      nombre: 'Jugador',
      username: null,
      apodo: null,
      nombre_saludo: null,
      foto_url: null,
      nivel: null,
    };
  }

  return {
    nombre: perfil.nombre ?? perfil.apodo ?? perfil.nombre_saludo ?? perfil.username ?? 'Jugador',
    username: perfil.username ?? null,
    apodo: perfil.apodo ?? null,
    nombre_saludo: perfil.nombre_saludo ?? null,
    foto_url: perfil.foto_url ?? null,
    nivel: perfil.nivel ?? null,
  };
}

function isDeadlinePassed(partido) {
  if (!partido?.deadline_cancel) return false;
  const deadlineMs = new Date(partido.deadline_cancel).getTime();
  return !Number.isNaN(deadlineMs) && deadlineMs <= Date.now();
}

async function isPartidoFull(supabaseAdmin, partido) {
  const { count, error } = await supabaseAdmin
    .from('partidos_abiertos_jugadores')
    .select('*', { count: 'exact', head: true })
    .eq('partido_id', partido.id);

  if (error) throw error;
  return (count ?? 0) >= getJugadoresRequeridos(partido);
}

async function addJugadorToPartido(supabaseAdmin, partido, user, { triggerPayment = true } = {}) {
  const partidoId = partido.id;
  const maxJugadores = getJugadoresRequeridos(partido);

  const { count, error: countErr } = await supabaseAdmin
    .from('partidos_abiertos_jugadores')
    .select('*', { count: 'exact', head: true })
    .eq('partido_id', partidoId);

  if (countErr) throw countErr;
  if ((count ?? 0) >= maxJugadores) {
    return { error: 'El partido ya está completo', status: 409 };
  }

  const { error: insertErr } = await supabaseAdmin
    .from('partidos_abiertos_jugadores')
    .insert([{
      partido_id: partidoId,
      user_id: user.id,
      email: user.email ?? null,
    }]);

  if (insertErr) throw insertErr;

  const newCount = (count ?? 0) + 1;
  await supabaseAdmin
    .from('partidos_abiertos')
    .update({ jugadores_confirmados: newCount })
    .eq('id', partidoId);

  let partidoCompleto = false;
  if (newCount >= maxJugadores) {
    partidoCompleto = true;
    await supabaseAdmin
      .from('partidos_abiertos')
      .update({ estado: 'completo', jugadores_confirmados: newCount })
      .eq('id', partidoId);

    if (triggerPayment) {
      console.log(`[TODO Stripe] Cobrar reserva al capitán — partido ${partidoId} completo`);
    }
  }

  return { ok: true, partidoCompleto, jugadores_actuales: newCount };
}

async function mapPartidoDetail(partido, supabaseAdmin, user) {
  const base = await mapPartidoRow(partido, supabaseAdmin, user);
  const jugadoresRows = [...(partido.partidos_abiertos_jugadores ?? [])];
  const capitanUserId = getCapitanUserId(partido);

  const equiposResueltos = resolveEquiposPartido({
    jugadoresRows,
    capitanUserId,
    capitanEmail: getCapitanEmail(partido),
    equiposAsignacion: partido.equipos_asignacion ?? null,
    jugadoresRequeridos: getJugadoresRequeridos(partido),
  });

  const mapRow = async (row) => ({
    user_id: row.user_id,
    email: row.email ?? null,
    nombre: await resolveJugadorName(row, supabaseAdmin),
  });

  const jugadores = await Promise.all(equiposResueltos.allRows.map(mapRow));
  const equipo1 = await Promise.all(equiposResueltos.equipo1Rows.map(mapRow));
  const equipo2 = await Promise.all(equiposResueltos.equipo2Rows.map(mapRow));

  return {
    ...base,
    jugadores,
    equipo1,
    equipo2,
    equipos_derivacion: equiposResueltos.derivacion,
    equipos_asignacion: equiposResueltos.equipos_asignacion ?? partido.equipos_asignacion ?? null,
  };
}

function validateResultadoPayload(body) {
  const equipo1Sets = Number(body?.equipo1_sets);
  const equipo2Sets = Number(body?.equipo2_sets);
  const setsDetalle = Array.isArray(body?.sets_detalle) ? body.sets_detalle : [];

  if (!Number.isFinite(equipo1Sets) || !Number.isFinite(equipo2Sets)) {
    return { valid: false, error: 'equipo1_sets y equipo2_sets son requeridos' };
  }

  if (equipo1Sets < 0 || equipo2Sets < 0 || equipo1Sets > 3 || equipo2Sets > 3) {
    return { valid: false, error: 'Los sets ganados deben estar entre 0 y 3' };
  }

  if (equipo1Sets === equipo2Sets) {
    return { valid: false, error: 'Debe haber un ganador' };
  }

  const normalizedSets = setsDetalle
    .slice(0, 3)
    .map((set) => ({
      eq1: Number(set?.eq1),
      eq2: Number(set?.eq2),
    }))
    .filter((set) => Number.isFinite(set.eq1) && Number.isFinite(set.eq2));

  if (normalizedSets.length === 0) {
    return { valid: false, error: 'Ingresá al menos un set con puntaje' };
  }

  let countedEq1 = 0;
  let countedEq2 = 0;

  normalizedSets.forEach((set) => {
    if (set.eq1 > set.eq2) countedEq1 += 1;
    if (set.eq2 > set.eq1) countedEq2 += 1;
  });

  if (countedEq1 !== equipo1Sets || countedEq2 !== equipo2Sets) {
    return { valid: false, error: 'Los sets ganados no coinciden con los puntajes ingresados' };
  }

  const ganador = equipo1Sets > equipo2Sets ? 'equipo1' : 'equipo2';

  return {
    valid: true,
    ganador,
    resultado: {
      equipo1_sets: equipo1Sets,
      equipo2_sets: equipo2Sets,
      sets_detalle: normalizedSets,
    },
  };
}

/** Upcoming open partidos for a single sede (sede profile preview). */
export async function fetchSedeUpcomingPartidos(supabaseAdmin, sedeId, user, { limit = 3 } = {}) {
  const todayStr = getTodayArgentinaDateUtcOffset();
  const safeLimit = Math.min(20, Math.max(1, Number(limit) || 3));

  console.log('[fetchSedeUpcomingPartidos] query', {
    table: 'partidos_abiertos',
    sede_id: sedeId,
    fecha_gte: todayStr,
    estado: 'abierto',
    limit: safeLimit,
  });

  const { data, error } = await supabaseAdmin
    .from('partidos_abiertos')
    .select(PARTIDO_SELECT)
    .eq('sede_id', sedeId)
    .eq('estado', 'abierto')
    .gte('fecha', todayStr)
    .order('fecha', { ascending: true })
    .order('hora', { ascending: true })
    .limit(safeLimit);

  if (error) throw error;

  console.log('[fetchSedeUpcomingPartidos] result count:', data?.length ?? 0);

  return Promise.all(
    (data ?? []).map((partido) => mapPartidoPublicRow(partido, supabaseAdmin, user)),
  );
}

export const PARTIDO_RESUMEN_ROUTE_PATH = '/:id/resumen';

export function mapMatchSummaryHttpError(err) {
  if (err instanceof MatchSummaryPayloadError || err instanceof MatchSummaryServiceError) {
    return {
      status: err.status ?? 500,
      body: {
        ok: false,
        error: err.message,
        code: err.code ?? null,
      },
    };
  }

  return null;
}

export async function fetchPartidoResumenPayload({
  partidoId,
  userId,
  pgPool,
  generateSummary = generateMatchSummaryForPartido,
}) {
  if (!pgPool) {
    throw new MatchSummaryPayloadError('Servicio de resumen no disponible', {
      status: 503,
      code: 'PG_POOL_UNAVAILABLE',
    });
  }

  return generateSummary({ partidoId, userId, pgPool });
}

export function createPartidosRouter({
  supabase,
  supabaseAdmin,
  getAuthenticatedUser,
  computePartidoDeadlineCancel,
  triggerPartidoCreatorPayment,
  pgPool = null,
  generateMatchSummary = generateMatchSummaryForPartido,
}) {
  const resolveDeadline = computePartidoDeadlineCancel ?? computeDeadlineCancel;

  const router = express.Router();

  router.post('/crear-con-prereserva', async (req, res) => {
    try {
      const { user, status, error: authError } = await getAuthenticatedUser(req);
      if (!user) {
        return res.status(status).json({ error: authError });
      }

      const activeCount = await countActiveCapitanPartidos(supabaseAdmin, user.id);
      if (activeCount >= ACTIVE_PARTIDO_LIMIT) {
        return activePartidoLimitResponse(res);
      }

      const {
        sede_id,
        sede,
        sede_nombre,
        cancha_id,
        cancha,
        cancha_nombre,
        canchaSeleccionada,
        fecha,
        hora,
        duracion,
        duracion_minutos,
        nivel,
        precio,
        precio_base,
        platform_fee,
        nombre,
        email,
        whatsapp,
      } = req.body;

      logPartidoCanchaBody(req.body, 'POST /api/partidos/crear-con-prereserva');

      const canchaStorage = resolveReservaCanchaStorageText(req.body);
      const canchaDisplay = resolvePartidoCanchaNombre(req.body);
      const durationMinutes = parsePositiveInt(duracion_minutos ?? duracion);

      if (!fecha || !hora || !nivel) {
        return res.status(400).json({ error: 'Faltan campos: sede_id, cancha, fecha, hora, nivel' });
      }

      const sedeRow = await resolveSedeRow(supabaseAdmin, { sede_id, sede, sede_nombre });
      if (!sedeRow) {
        return res.status(404).json({ error: 'Sede no encontrada' });
      }

      const blocked = await isCourtBlocked(supabaseAdmin, {
        sedeNombre: sedeRow.nombre,
        sedeId: sedeRow.id,
        fecha,
        hora,
        cancha: canchaStorage,
      });

      if (blocked) {
        return res.status(409).json({ error: 'Este horario ya está reservado' });
      }

      const metadata = user.user_metadata ?? {};
      const contactNombre = nombre
        ?? metadata.full_name
        ?? metadata.name
        ?? user.email
        ?? 'Jugador';
      const contactEmail = email ?? user.email;
      const contactWhatsapp = whatsapp
        ?? metadata.phone
        ?? metadata.whatsapp
        ?? metadata.telefono
        ?? '';
      const totalPrecio = precio != null ? parsePositiveInt(precio) ?? 0 : 0;
      const deadlineCancel = resolveDeadline(fecha, hora);

      const reservaInsert = buildReservaInsertRow({
        sedeNombre: sedeRow.nombre,
        sedeId: sedeRow.id,
        fecha,
        hora,
        hora_inicio: req.body.hora_inicio,
        hora_fin: req.body.hora_fin,
        canchaText: canchaStorage,
        cancha_id: req.body.cancha_id,
        nombre: contactNombre,
        email: contactEmail,
        telefono: contactWhatsapp,
        whatsapp: contactWhatsapp,
        nivel,
        precio: totalPrecio,
        estado: 'prereserva',
        pago_estado: 'pendiente',
        duracion_minutos: durationMinutes ?? 90,
        user_id: user.id,
      });
      console.log('[DEBUG INSERT reservas]', {
        sede_id: sedeRow.id,
        fecha,
        estado: 'prereserva',
      });

      const { data: reservaRows, error: reservaErr } = await supabaseAdmin
        .from('reservas')
        .insert([reservaInsert])
        .select('*');

      if (reservaErr) {
        if (isReservaSlotUniqueViolation(reservaErr)) {
          return res.status(409).json({ error: 'Este horario ya está reservado' });
        }
        throw reservaErr;
      }

      const reserva = reservaRows?.[0];
      if (!reserva) {
        throw new Error('No se pudo crear la prereserva');
      }

      const partidoInsert = buildPartidoAbiertoInsertRow({
        sedeRow,
        body: req.body,
        reservaId: reserva.id,
        canchaNombre: canchaDisplay,
        capitanFields: await buildCapitanFields(supabaseAdmin, user, { email: contactEmail }),
        fecha,
        hora,
        nivel,
        estado: 'abierto',
        deadlineCancel,
        duracionMinutos: durationMinutes,
      });
      console.log('[DEBUG partidos_abiertos INSERT]', {
        reserva_id: reserva.id,
        sede_id: sedeRow.id,
        estado: 'abierto',
      });

      const { data: partido, error: partidoErr } = await supabaseAdmin
        .from('partidos_abiertos')
        .insert([partidoInsert])
        .select('*')
        .single();

      if (partidoErr) throw partidoErr;

      const { error: hostJoinErr } = await supabaseAdmin
        .from('partidos_abiertos_jugadores')
        .insert([{
          partido_id: partido.id,
          user_id: user.id,
          email: contactEmail,
        }]);

      if (hostJoinErr) throw hostJoinErr;

      console.log(`✓ POST /api/partidos/crear-con-prereserva — partido ${partido.id}, reserva ${reserva.id}`);
      res.status(201).json({
        partido_id: partido.id,
        reserva_id: reserva.id,
        deadline_cancel: deadlineCancel,
        partido_link: `padbolmatch://partido/${partido.id}`,
        sede_nombre: sedeRow.nombre,
        fecha,
        hora: formatHora(hora),
        nivel,
      });
    } catch (err) {
      console.error('❌ Error POST /api/partidos/crear-con-prereserva:', err.message);
      return sendHttpError(res, err);
    }
  });

  router.get('/abiertos', async (req, res) => {
    try {
      const todayStr = getTodayArgentinaDateUtcOffset();
      const sedeId = parsePositiveInt(req.query.sede_id);
      const auth = await getAuthenticatedUser(req);
      const user = auth.user ?? null;

      if (sedeId != null) {
        console.log('[GET /api/partidos/abiertos] query', {
          table: 'partidos_abiertos',
          sede_id: sedeId,
          fecha_gte: todayStr,
          estado: 'abierto',
        });

        const { data: partidos, error } = await supabaseAdmin
          .from('partidos_abiertos')
          .select(PARTIDO_SELECT)
          .eq('sede_id', sedeId)
          .eq('estado', 'abierto')
          .gte('fecha', todayStr)
          .order('fecha', { ascending: true })
          .order('hora', { ascending: true });

        if (error) throw error;

        console.log('[GET /api/partidos/abiertos] result count:', partidos?.length ?? 0);

        const result = await Promise.all(
          (partidos ?? []).map((partido) => mapPartidoPublicRow(partido, supabaseAdmin, user)),
        );
        return res.json(result);
      }

      const { data: partidos, error } = await supabaseAdmin
        .from('partidos_abiertos')
        .select(PARTIDO_SELECT)
        .in('estado', OPEN_JOIN_STATES)
        .gte('fecha', todayStr)
        .order('fecha', { ascending: true })
        .order('hora', { ascending: true });

      if (error) throw error;

      let merged = partidos || [];

      if (user) {
        const { data: completos, error: completosErr } = await supabaseAdmin
          .from('partidos_abiertos')
          .select(PARTIDO_SELECT)
          .eq('estado', 'completo');

        if (completosErr) throw completosErr;

        const userCompletos = (completos || []).filter((partido) => {
          const participantIds = (partido.partidos_abiertos_jugadores ?? [])
            .map((row) => row.user_id);
          const capitanUserId = getCapitanUserId(partido);
          const isMember = capitanUserId === user.id || participantIds.includes(user.id);
          return isMember && isMatchPast(partido.fecha, partido.hora);
        });

        const byId = new Map(merged.map((partido) => [partido.id, partido]));
        userCompletos.forEach((partido) => {
          if (!byId.has(partido.id)) byId.set(partido.id, partido);
        });
        merged = [...byId.values()];
      }

      const result = await Promise.all(
        merged.map((partido) => mapPartidoPublicRow(partido, supabaseAdmin, user)),
      );

      res.json(result);
    } catch (err) {
      console.error('❌ Error GET /api/partidos/abiertos:', err.message);
      return sendHttpError(res, err);
    }
  });

  router.get('/solicitudes-pendientes', async (req, res) => {
    try {
      const { user, status, error: authError } = await getAuthenticatedUser(req);
      if (!user) {
        return res.status(status).json({ error: authError });
      }

      const { data: partidosCapitan, error: capitanErr } = await supabaseAdmin
        .from('partidos_abiertos')
        .select('id, sede_nombre, fecha, hora, estado, deporte')
        .eq('capitan_user_id', user.id)
        .eq('estado', 'abierto');

      if (capitanErr) throw capitanErr;

      const partidoIds = (partidosCapitan ?? []).map((row) => row.id);
      if (partidoIds.length === 0) {
        return res.json([]);
      }

      const { data: solicitudes, error: solErr } = await supabaseAdmin
        .from('solicitudes_partido')
        .select('id, partido_id, solicitante_id, estado, created_at')
        .in('partido_id', partidoIds)
        .eq('estado', 'pendiente')
        .order('created_at', { ascending: false });

      if (solErr) throw solErr;

      const partidoMap = Object.fromEntries((partidosCapitan ?? []).map((row) => [row.id, row]));
      const result = await Promise.all(
        (solicitudes ?? []).map(async (solicitud) => {
          const perfil = await fetchJugadorPerfilPublic(
            supabaseAdmin,
            solicitud.solicitante_id,
            null,
          );
          const partido = partidoMap[solicitud.partido_id] ?? null;
          return {
            solicitud_id: solicitud.id,
            partido_id: solicitud.partido_id,
            solicitante_id: solicitud.solicitante_id,
            created_at: solicitud.created_at,
            sede_nombre: partido?.sede_nombre ?? null,
            fecha: partido?.fecha ?? null,
            hora: formatHora(partido?.hora),
            deporte: partido?.deporte ?? 'padbol',
            solicitante: mapSolicitanteFromPerfil(perfil),
          };
        }),
      );

      res.json(result);
    } catch (err) {
      console.error('❌ Error GET /api/partidos/solicitudes-pendientes:', err.message);
      return sendHttpError(res, err);
    }
  });

  router.get('/mis-partidos', async (req, res) => {
    try {
      const { user, status, error: authError } = await getAuthenticatedUser(req);
      if (!user) {
        return res.status(status).json({ error: authError });
      }

      const { data: joinRows, error: joinErr } = await supabaseAdmin
        .from('partidos_abiertos_jugadores')
        .select('partido_id')
        .eq('user_id', user.id);

      if (joinErr) throw joinErr;

      const joinedIds = [...new Set((joinRows ?? []).map((row) => row.partido_id).filter(Boolean))];
      const partidosById = new Map();

      if (joinedIds.length > 0) {
        const { data: joinedPartidos, error: joinedPartidosErr } = await supabaseAdmin
          .from('partidos_abiertos')
          .select(PARTIDO_SELECT)
          .in('id', joinedIds);

        if (joinedPartidosErr) throw joinedPartidosErr;
        (joinedPartidos ?? []).forEach((partido) => partidosById.set(partido.id, partido));
      }

      const { data: captainPartidos, error: captainErr } = await supabaseAdmin
        .from('partidos_abiertos')
        .select(PARTIDO_SELECT)
        .eq('capitan_user_id', user.id);

      if (captainErr) throw captainErr;
      (captainPartidos ?? []).forEach((partido) => partidosById.set(partido.id, partido));

      const merged = [...partidosById.values()].sort((a, b) => {
        const aKey = `${a.fecha ?? ''} ${a.hora ?? ''}`;
        const bKey = `${b.fecha ?? ''} ${b.hora ?? ''}`;
        return aKey.localeCompare(bKey);
      });

      const result = await Promise.all(
        merged.map((partido) => mapPartidoRow(partido, supabaseAdmin, user)),
      );

      res.json(result);
    } catch (err) {
      console.error('❌ Error GET /api/partidos/mis-partidos:', err.message);
      return sendHttpError(res, err);
    }
  });

  router.get('/:id', async (req, res) => {
    try {
      const { user, status, error: authError } = await getAuthenticatedUser(req);
      if (!user) {
        return res.status(status).json({ error: authError });
      }

      const partidoId = parsePartidoId(req.params.id);
      if (partidoId == null) {
        return res.status(400).json({ error: 'ID de partido inválido' });
      }

      const { data: partido, error } = await supabaseAdmin
        .from('partidos_abiertos')
        .select(PARTIDO_SELECT)
        .eq('id', partidoId)
        .maybeSingle();

      if (error) throw error;
      if (!partido) {
        return res.status(404).json({ error: 'Partido no encontrado' });
      }

      const mapped = await mapPartidoRow(partido, supabaseAdmin, user);

      if (partido.reserva_id) {
        const { data: reserva } = await supabaseAdmin
          .from('reservas')
          .select('precio, moneda')
          .eq('id', partido.reserva_id)
          .maybeSingle();

        if (reserva) {
          mapped.precio = reserva.precio ?? null;
          mapped.moneda = reserva.moneda ?? 'ARS';
        }
      }

      const { data: miSolicitud } = await supabaseAdmin
        .from('solicitudes_partido')
        .select('id, estado')
        .eq('partido_id', partidoId)
        .eq('solicitante_id', user.id)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      res.json({
        ...mapped,
        deporte: partido.deporte ?? 'padbol',
        mi_solicitud_estado: miSolicitud?.estado ?? null,
        mi_solicitud_id: miSolicitud?.id ?? null,
      });
    } catch (err) {
      console.error('❌ Error GET /api/partidos/:id:', err.message);
      return sendHttpError(res, err);
    }
  });

  router.get(PARTIDO_RESUMEN_ROUTE_PATH, async (req, res) => {
    try {
      const { user, status, error: authError } = await getAuthenticatedUser(req);
      if (!user) {
        return res.status(status).json({ ok: false, error: authError });
      }

      const partidoId = parsePartidoId(req.params.id);
      if (partidoId == null) {
        return res.status(400).json({ ok: false, error: 'ID de partido inválido' });
      }

      const result = await fetchPartidoResumenPayload({
        partidoId,
        userId: user.id,
        pgPool,
        generateSummary: generateMatchSummary,
      });

      console.log(
        `✓ GET /api/partidos/${partidoId}/resumen — cached=${result.cached}`,
      );

      return res.status(200).json({
        ok: true,
        resumen: result.summary,
        cached: result.cached,
        generated_at: result.summary.generated_at ?? null,
      });
    } catch (err) {
      const mapped = mapMatchSummaryHttpError(err);
      if (mapped) {
        return res.status(mapped.status).json(mapped.body);
      }

      console.error('❌ Error GET /api/partidos/:id/resumen:', err.message);
      return sendHttpError(res, err);
    }
  });

  router.get('/:id/mi-solicitud', async (req, res) => {
    try {
      const { user, status, error: authError } = await getAuthenticatedUser(req);
      if (!user) {
        return res.status(status).json({ error: authError });
      }

      const partidoId = parsePartidoId(req.params.id);
      if (partidoId == null) {
        return res.status(400).json({ error: 'ID de partido inválido' });
      }

      const { data: solicitud, error } = await supabaseAdmin
        .from('solicitudes_partido')
        .select('id, estado, created_at')
        .eq('partido_id', partidoId)
        .eq('solicitante_id', user.id)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (error) throw error;

      res.json({
        solicitud_id: solicitud?.id ?? null,
        estado: solicitud?.estado ?? null,
      });
    } catch (err) {
      console.error('❌ Error GET /api/partidos/:id/mi-solicitud:', err.message);
      return sendHttpError(res, err);
    }
  });

  router.post('/:id/invitar', async (req, res) => {
    try {
      const { user, status, error: authError } = await getAuthenticatedUser(req);
      if (!user) {
        return res.status(status).json({ error: authError });
      }

      const partidoId = parsePartidoId(req.params.id);
      if (partidoId == null) {
        return res.status(400).json({ error: 'ID de partido inválido' });
      }

      const invitadoId = req.body?.invitado_id ?? req.body?.invitadoId ?? null;
      if (!invitadoId) {
        return res.status(400).json({ error: 'invitado_id es requerido' });
      }

      const { data: partido, error: fetchErr } = await supabaseAdmin
        .from('partidos_abiertos')
        .select('*')
        .eq('id', partidoId)
        .maybeSingle();

      if (fetchErr) throw fetchErr;
      if (!partido) {
        return res.status(404).json({ error: 'Partido no encontrado' });
      }
      if (partido.estado !== 'abierto') {
        return res.status(400).json({ error: 'Este partido ya no acepta jugadores' });
      }
      if (getCapitanUserId(partido) !== user.id) {
        return res.status(403).json({ error: 'Solo el capitán puede invitar jugadores' });
      }
      if (invitadoId === user.id) {
        return res.status(400).json({ error: 'No podés invitarte a tu propio partido' });
      }

      const { data: existingJoin, error: joinErr } = await supabaseAdmin
        .from('partidos_abiertos_jugadores')
        .select('id')
        .eq('partido_id', partidoId)
        .eq('user_id', invitadoId)
        .maybeSingle();

      if (joinErr) throw joinErr;
      if (existingJoin) {
        return res.status(409).json({ error: 'Ese jugador ya está en el partido' });
      }

      if (await isPartidoFull(supabaseAdmin, partido)) {
        return res.status(409).json({ error: 'El partido ya está completo' });
      }

      const { data: existingSolicitud, error: solErr } = await supabaseAdmin
        .from('solicitudes_partido')
        .select('id, estado')
        .eq('partido_id', partidoId)
        .eq('solicitante_id', invitadoId)
        .maybeSingle();

      if (solErr) throw solErr;
      if (existingSolicitud?.estado === 'pendiente' || existingSolicitud?.estado === 'invitado') {
        return res.status(409).json({ error: 'Ese jugador ya tiene una solicitud o invitación pendiente' });
      }
      if (existingSolicitud?.estado === 'aceptado') {
        return res.status(409).json({ error: 'Ese jugador ya está en el partido' });
      }

      if (existingSolicitud) {
        const { error: updateErr } = await supabaseAdmin
          .from('solicitudes_partido')
          .update({ estado: 'invitado', created_at: new Date().toISOString() })
          .eq('id', existingSolicitud.id);

        if (updateErr) throw updateErr;
      } else {
        const { error: insertErr } = await supabaseAdmin
          .from('solicitudes_partido')
          .insert([{
            partido_id: partidoId,
            solicitante_id: invitadoId,
            estado: 'invitado',
          }]);

        if (insertErr) throw insertErr;
      }

      const sedeNombre = partido.sede_nombre ?? 'la sede';
      const horaLabel = formatHora(partido.hora) ?? '';
      await sendPushToUser(supabaseAdmin, invitadoId, {
        title: 'Te invitaron a un partido',
        body: `Te invitaron a un partido de Padbol en ${sedeNombre} el ${partido.fecha}${horaLabel ? ` a las ${horaLabel}` : ''}`,
        data: { tipo: 'invitado', partidoId: String(partidoId) },
      });

      console.log(`✓ POST /api/partidos/${partidoId}/invitar — ${invitadoId}`);
      res.json({ ok: true });
    } catch (err) {
      console.error('❌ Error POST /api/partidos/:id/invitar:', err.message);
      return sendHttpError(res, err);
    }
  });

  router.delete('/:id/salir', async (req, res) => {
    try {
      const { user, status, error: authError } = await getAuthenticatedUser(req);
      if (!user) {
        return res.status(status).json({ error: authError });
      }

      const partidoId = parsePartidoId(req.params.id);
      if (partidoId == null) {
        return res.status(400).json({ error: 'ID de partido inválido' });
      }

      const { data: partido, error: fetchErr } = await supabaseAdmin
        .from('partidos_abiertos')
        .select('*')
        .eq('id', partidoId)
        .maybeSingle();

      if (fetchErr) throw fetchErr;
      if (!partido) {
        return res.status(404).json({ error: 'Partido no encontrado' });
      }

      if (getCapitanUserId(partido) === user.id) {
        return res.status(403).json({
          error: 'Eres el capitán — no puedes salir del partido. Si necesitas cancelarlo, contacta al club.',
        });
      }

      const { data: joinRow, error: joinErr } = await supabaseAdmin
        .from('partidos_abiertos_jugadores')
        .select('id')
        .eq('partido_id', partidoId)
        .eq('user_id', user.id)
        .maybeSingle();

      if (joinErr) throw joinErr;
      if (!joinRow) {
        return res.status(403).json({ error: 'No estás confirmado en este partido' });
      }

      const { error: deleteErr } = await supabaseAdmin
        .from('partidos_abiertos_jugadores')
        .delete()
        .eq('partido_id', partidoId)
        .eq('user_id', user.id);

      if (deleteErr) throw deleteErr;

      const { count, error: countErr } = await supabaseAdmin
        .from('partidos_abiertos_jugadores')
        .select('*', { count: 'exact', head: true })
        .eq('partido_id', partidoId);

      if (countErr) throw countErr;

      const newCount = count ?? 0;
      await supabaseAdmin
        .from('partidos_abiertos')
        .update({
          estado: 'abierto',
          jugadores_confirmados: newCount,
        })
        .eq('id', partidoId);

      const perfil = await fetchJugadorPerfilPublic(supabaseAdmin, user.id, user.email);
      const nombre =
        perfil?.nombre_saludo
        ?? perfil?.apodo
        ?? perfil?.nombre
        ?? emailLocalPart(user.email)
        ?? 'Un jugador';

      const capitanUserId = getCapitanUserId(partido);
      if (capitanUserId) {
        await sendPushToUser(supabaseAdmin, capitanUserId, {
          title: 'Un jugador salió del partido',
          body: `${nombre} salió — falta 1 jugador para completar el equipo`,
          data: { tipo: 'jugador_salio', partidoId: String(partidoId) },
        });
      }

      console.log(`✓ DELETE /api/partidos/${partidoId}/salir — ${user.id}`);
      res.json({ ok: true });
    } catch (err) {
      console.error('❌ Error DELETE /api/partidos/:id/salir:', err.message);
      return sendHttpError(res, err);
    }
  });

  router.post('/:id/solicitar-union', async (req, res) => {
    try {
      const { user, status, error: authError } = await getAuthenticatedUser(req);
      if (!user) {
        return res.status(status).json({ error: authError });
      }

      const partidoId = parsePartidoId(req.params.id);
      if (partidoId == null) {
        return res.status(400).json({ error: 'ID de partido inválido' });
      }

      const { data: partido, error: fetchErr } = await supabaseAdmin
        .from('partidos_abiertos')
        .select('*')
        .eq('id', partidoId)
        .maybeSingle();

      if (fetchErr) throw fetchErr;
      if (!partido) {
        return res.status(404).json({ error: 'Partido no encontrado' });
      }
      if (partido.estado !== 'abierto') {
        return res.status(400).json({ error: 'Este partido ya no acepta jugadores' });
      }
      if (isDeadlinePassed(partido)) {
        return res.status(400).json({ error: 'El plazo para unirse ya venció' });
      }
      if (getCapitanUserId(partido) === user.id) {
        return res.status(400).json({ error: 'Ya sos el capitán de este partido' });
      }

      const { data: existingJoin, error: joinErr } = await supabaseAdmin
        .from('partidos_abiertos_jugadores')
        .select('id')
        .eq('partido_id', partidoId)
        .eq('user_id', user.id)
        .maybeSingle();

      if (joinErr) throw joinErr;
      if (existingJoin) {
        return res.status(409).json({ error: 'Ya estás unido a este partido' });
      }

      if (await isPartidoFull(supabaseAdmin, partido)) {
        return res.status(409).json({ error: 'El partido ya está completo' });
      }

      const { data: existingSolicitud, error: solErr } = await supabaseAdmin
        .from('solicitudes_partido')
        .select('id, estado')
        .eq('partido_id', partidoId)
        .eq('solicitante_id', user.id)
        .maybeSingle();

      if (solErr) throw solErr;
      if (existingSolicitud?.estado === 'pendiente') {
        return res.status(409).json({ error: 'Ya enviaste una solicitud para este partido' });
      }

      if (existingSolicitud?.estado === 'aceptado') {
        return res.status(409).json({ error: 'Ya estás unido a este partido' });
      }

      if (existingSolicitud) {
        const { error: updateErr } = await supabaseAdmin
          .from('solicitudes_partido')
          .update({ estado: 'pendiente', created_at: new Date().toISOString() })
          .eq('id', existingSolicitud.id);

        if (updateErr) throw updateErr;
      } else {
        const { error: insertErr } = await supabaseAdmin
          .from('solicitudes_partido')
          .insert([{
            partido_id: partidoId,
            solicitante_id: user.id,
            estado: 'pendiente',
          }]);

        if (insertErr) throw insertErr;
      }

      const capitanUserId = getCapitanUserId(partido);
      const solicitantePerfil = await fetchJugadorPerfilPublic(supabaseAdmin, user.id, user.email);
      const solicitanteNombre =
        solicitantePerfil?.nombre_saludo
        ?? solicitantePerfil?.apodo
        ?? solicitantePerfil?.nombre
        ?? emailLocalPart(user.email)
        ?? 'Un jugador';

      const horaLabel = formatHora(partido.hora) ?? '';
      const fechaLabel = partido.fecha
        ? new Date(`${partido.fecha}T12:00:00`).toLocaleDateString('es-AR', {
          weekday: 'short',
          day: 'numeric',
          month: 'short',
        })
        : '';

      await sendPushToUser(supabaseAdmin, capitanUserId, {
        title: '¡Alguien quiere unirse!',
        body: `${solicitanteNombre} quiere unirse a tu partido`,
        data: {
          tipo: 'solicitud',
          partidoId: String(partidoId),
        },
      });

      let solicitudId = existingSolicitud?.id ?? null;
      if (!solicitudId) {
        const { data: solicitudFresh } = await supabaseAdmin
          .from('solicitudes_partido')
          .select('id')
          .eq('partido_id', partidoId)
          .eq('solicitante_id', user.id)
          .maybeSingle();
        solicitudId = solicitudFresh?.id ?? null;
      }

      await createNotificacion(supabaseAdmin, {
        user_id: capitanUserId,
        tipo: 'solicitud_partido',
        mensaje: `${solicitanteNombre} quiere unirse a tu partido del ${fechaLabel}${horaLabel ? ` · ${horaLabel}` : ''}`,
        data: {
          partido_id: partidoId,
          solicitud_id: solicitudId,
          solicitante_id: user.id,
          solicitante_nombre: solicitanteNombre,
          solicitante_foto_url: solicitantePerfil?.foto_url ?? null,
          sede_nombre: partido.sede_nombre ?? null,
          fecha: partido.fecha ?? null,
          hora: horaLabel,
        },
      });

      console.log(`✓ POST /api/partidos/${partidoId}/solicitar-union — ${user.id}`);
      res.json({ ok: true });
    } catch (err) {
      console.error('❌ Error POST /api/partidos/:id/solicitar-union:', err.message);
      return sendHttpError(res, err);
    }
  });

  router.get('/:id/solicitudes', async (req, res) => {
    try {
      const { user, status, error: authError } = await getAuthenticatedUser(req);
      if (!user) {
        return res.status(status).json({ error: authError });
      }

      const partidoId = parsePartidoId(req.params.id);
      if (partidoId == null) {
        return res.status(400).json({ error: 'ID de partido inválido' });
      }

      const { data: partido, error: fetchErr } = await supabaseAdmin
        .from('partidos_abiertos')
        .select('id, capitan_user_id, sede_nombre, fecha, hora, estado, jugadores_requeridos')
        .eq('id', partidoId)
        .maybeSingle();

      if (fetchErr) throw fetchErr;
      if (!partido) {
        return res.status(404).json({ error: 'Partido no encontrado' });
      }
      if (getCapitanUserId(partido) !== user.id) {
        return res.status(403).json({ error: 'Solo el capitán puede ver las solicitudes' });
      }

      const { data: solicitudes, error: solErr } = await supabaseAdmin
        .from('solicitudes_partido')
        .select('id, solicitante_id, estado, created_at')
        .eq('partido_id', partidoId)
        .eq('estado', 'pendiente')
        .order('created_at', { ascending: true });

      if (solErr) throw solErr;

      const mapped = await Promise.all(
        (solicitudes ?? []).map(async (solicitud) => {
          const perfil = await fetchJugadorPerfilPublic(
            supabaseAdmin,
            solicitud.solicitante_id,
            null,
          );
          const partidosJugados = await countPartidosJugados(supabaseAdmin, solicitud.solicitante_id);

          return {
            id: solicitud.id,
            solicitante_id: solicitud.solicitante_id,
            estado: solicitud.estado,
            created_at: solicitud.created_at,
            ...mapSolicitanteFromPerfil(perfil),
            nivel: perfil?.nivel ?? 'Intermedio',
            partidos_jugados: partidosJugados,
          };
        }),
      );

      res.json({
        partido: {
          id: partido.id,
          sede_nombre: partido.sede_nombre,
          fecha: partido.fecha,
          hora: formatHora(partido.hora),
          estado: partido.estado,
          completo: await isPartidoFull(supabaseAdmin, partido),
        },
        solicitudes: mapped,
      });
    } catch (err) {
      console.error('❌ Error GET /api/partidos/:id/solicitudes:', err.message);
      return sendHttpError(res, err);
    }
  });

  router.patch('/:id/solicitudes/:solicitudId', async (req, res) => {
    try {
      const { user, status, error: authError } = await getAuthenticatedUser(req);
      if (!user) {
        return res.status(status).json({ error: authError });
      }

      const partidoId = parsePartidoId(req.params.id);
      const solicitudId = req.params.solicitudId;
      const accion = String(req.body?.accion ?? '').trim().toLowerCase();

      if (partidoId == null) {
        return res.status(400).json({ error: 'ID de partido inválido' });
      }
      if (!['aceptar', 'rechazar'].includes(accion)) {
        return res.status(400).json({ error: 'accion debe ser aceptar o rechazar' });
      }

      const { data: partido, error: fetchErr } = await supabaseAdmin
        .from('partidos_abiertos')
        .select('*')
        .eq('id', partidoId)
        .maybeSingle();

      if (fetchErr) throw fetchErr;
      if (!partido) {
        return res.status(404).json({ error: 'Partido no encontrado' });
      }
      if (getCapitanUserId(partido) !== user.id) {
        return res.status(403).json({ error: 'Solo el capitán puede responder solicitudes' });
      }

      const { data: solicitud, error: solErr } = await supabaseAdmin
        .from('solicitudes_partido')
        .select('*')
        .eq('id', solicitudId)
        .eq('partido_id', partidoId)
        .maybeSingle();

      if (solErr) throw solErr;
      if (!solicitud) {
        return res.status(404).json({ error: 'Solicitud no encontrada' });
      }
      const isCapitan = getCapitanUserId(partido) === user.id;
      const isInvitee = solicitud.solicitante_id === user.id;

      if (solicitud.estado === 'invitado' && isInvitee) {
        if (accion === 'rechazar') {
          await supabaseAdmin
            .from('solicitudes_partido')
            .update({ estado: 'rechazado' })
            .eq('id', solicitudId);

          return res.json({ ok: true });
        }

        if (await isPartidoFull(supabaseAdmin, partido)) {
          return res.status(409).json({ error: 'El partido ya está completo' });
        }

        const { data: solicitanteAuth, error: authLookupErr } = await supabaseAdmin.auth.admin.getUserById(
          user.id,
        );

        if (authLookupErr || !solicitanteAuth?.user) {
          return res.status(404).json({ error: 'No encontramos tu perfil' });
        }

        const joinResult = await addJugadorToPartido(supabaseAdmin, partido, solicitanteAuth.user);

        if (joinResult.error) {
          return res.status(joinResult.status ?? 409).json({ error: joinResult.error });
        }

        await supabaseAdmin
          .from('solicitudes_partido')
          .update({ estado: 'aceptado' })
          .eq('id', solicitudId);

        const horaLabel = formatHora(partido.hora) ?? '';
        await sendPushToUser(supabaseAdmin, getCapitanUserId(partido), {
          title: 'Invitación aceptada',
          body: `Un jugador aceptó tu invitación para el ${partido.fecha}${horaLabel ? ` a las ${horaLabel}` : ''}`,
          data: { tipo: 'aceptado', partidoId: String(partidoId) },
        });

        console.log(`✓ PATCH /api/partidos/${partidoId}/solicitudes/${solicitudId} — invitado aceptar`);
        return res.json({ ok: true, partido_completo: joinResult.partidoCompleto });
      }

      if (!isCapitan) {
        return res.status(403).json({ error: 'No tenés permiso para responder esta solicitud' });
      }

      if (solicitud.estado !== 'pendiente') {
        return res.status(400).json({ error: 'Esta solicitud ya fue respondida' });
      }

      if (accion === 'rechazar') {
        await supabaseAdmin
          .from('solicitudes_partido')
          .update({ estado: 'rechazado' })
          .eq('id', solicitudId);

        await sendPushToUser(supabaseAdmin, solicitud.solicitante_id, {
          title: 'El partido está completo',
          body: 'El partido está completo — ¡busca tu próximo partido!',
          data: { tipo: 'rechazado', partidoId: String(partidoId) },
        });

        return res.json({ ok: true });
      }

      if (await isPartidoFull(supabaseAdmin, partido)) {
        return res.status(409).json({ error: 'El partido ya está completo' });
      }

      const { data: solicitanteAuth, error: authLookupErr } = await supabaseAdmin.auth.admin.getUserById(
        solicitud.solicitante_id,
      );

      if (authLookupErr || !solicitanteAuth?.user) {
        return res.status(404).json({ error: 'No encontramos al solicitante' });
      }

      const solicitanteUser = solicitanteAuth.user;
      const joinResult = await addJugadorToPartido(supabaseAdmin, partido, solicitanteUser);

      if (joinResult.error) {
        return res.status(joinResult.status ?? 409).json({ error: joinResult.error });
      }

      await supabaseAdmin
        .from('solicitudes_partido')
        .update({ estado: 'aceptado' })
        .eq('id', solicitudId);

      const horaLabel = formatHora(partido.hora) ?? '';
      const fechaLabel = partido.fecha
        ? new Date(`${partido.fecha}T12:00:00`).toLocaleDateString('es-AR', {
          weekday: 'short',
          day: 'numeric',
          month: 'short',
        })
        : '';

      await sendPushToUser(supabaseAdmin, solicitud.solicitante_id, {
        title: '¡Estás dentro!',
        body: `El partido es el ${partido.fecha} a las ${horaLabel}`,
        data: { tipo: 'aceptado', partidoId: String(partidoId) },
      });

      await createNotificacion(supabaseAdmin, {
        user_id: solicitud.solicitante_id,
        tipo: 'solicitud_aceptada',
        mensaje: `Tu solicitud fue aceptada. ¡Jugás el ${fechaLabel}${horaLabel ? ` a las ${horaLabel}` : ''} en ${partido.sede_nombre ?? 'la sede'}!`,
        data: {
          partido_id: partidoId,
          sede_nombre: partido.sede_nombre ?? null,
          fecha: partido.fecha ?? null,
          hora: horaLabel,
        },
      });

      if (joinResult.partidoCompleto) {
        await createNotificacion(supabaseAdmin, {
          user_id: getCapitanUserId(partido),
          tipo: 'partido_completo',
          mensaje: `¡Tu partido del ${fechaLabel} está completo! 4/4 jugadores confirmados`,
          data: { partido_id: partidoId, jugadores: 4, cupo: 4 },
        });
      }

      console.log(`✓ PATCH /api/partidos/${partidoId}/solicitudes/${solicitudId} — aceptar`);
      res.json({ ok: true, partido_completo: joinResult.partidoCompleto });
    } catch (err) {
      console.error('❌ Error PATCH /api/partidos/:id/solicitudes/:solicitudId:', err.message);
      return sendHttpError(res, err);
    }
  });

  router.post('/:id/unirse', async (req, res) => {
    try {
      const { user, status, error: authError } = await getAuthenticatedUser(req);
      if (!user) {
        return res.status(status).json({ error: authError });
      }

      const partidoId = parsePartidoId(req.params.id);
      if (partidoId == null) {
        return res.status(400).json({ error: 'ID de partido inválido' });
      }

      const { data: partido, error: fetchErr } = await supabaseAdmin
        .from('partidos_abiertos')
        .select('*')
        .eq('id', partidoId)
        .maybeSingle();

      if (fetchErr) throw fetchErr;
      if (!partido) {
        return res.status(404).json({ error: 'Partido no encontrado' });
      }
      if (partido.estado !== 'abierto') {
        return res.status(400).json({ error: 'Este partido ya no acepta jugadores' });
      }

      const { data: existingJoin, error: existingErr } = await supabaseAdmin
        .from('partidos_abiertos_jugadores')
        .select('id')
        .eq('partido_id', partidoId)
        .eq('user_id', user.id)
        .maybeSingle();

      if (existingErr) throw existingErr;
      if (existingJoin) {
        return res.status(409).json({ error: 'Ya estás unido a este partido' });
      }

      const { count, error: countErr } = await supabaseAdmin
        .from('partidos_abiertos_jugadores')
        .select('*', { count: 'exact', head: true })
        .eq('partido_id', partidoId);

      if (countErr) throw countErr;

      const maxJugadores = getJugadoresRequeridos(partido);
      if ((count ?? 0) >= maxJugadores) {
        return res.status(409).json({ error: 'El partido ya está completo' });
      }

      const { error: insertErr } = await supabaseAdmin
        .from('partidos_abiertos_jugadores')
        .insert([{
          partido_id: partidoId,
          user_id: user.id,
          email: user.email ?? null,
        }]);

      if (insertErr) throw insertErr;

      const newCount = (count ?? 0) + 1;
      await supabaseAdmin
        .from('partidos_abiertos')
        .update({ jugadores_confirmados: newCount })
        .eq('id', partidoId);

      let partidoCompleto = false;
      let requierePagoCreador = false;
      let pagoUrl = null;

      if (newCount >= maxJugadores) {
        partidoCompleto = true;
        await supabaseAdmin
          .from('partidos_abiertos')
          .update({ estado: 'completo', jugadores_confirmados: newCount })
          .eq('id', partidoId);

        let reservaId = partido.reserva_id;
        const capitanUserId = getCapitanUserId(partido);
        if (!reservaId && capitanUserId) {
          const { data: candidates } = await supabaseAdmin
            .from('reservas')
            .select('*')
            .eq('user_id', capitanUserId)
            .eq('fecha', partido.fecha)
            .in('estado', ['prereserva', 'confirmada']);
          const linkedReserva = (candidates ?? []).find(
            (r) => formatHora(reservaHoraInicioFromRow(r)) === formatHora(partido.hora),
          );
          if (linkedReserva) {
            reservaId = linkedReserva.id;
            await supabaseAdmin
              .from('partidos_abiertos')
              .update({ reserva_id: reservaId })
              .eq('id', partidoId);
          }
        }

        if (reservaId && triggerPartidoCreatorPayment) {
          const { data: reserva, error: reservaErr } = await supabaseAdmin
            .from('reservas')
            .select('*')
            .eq('id', reservaId)
            .maybeSingle();

          if (!reservaErr && reserva) {
            try {
              const payment = await triggerPartidoCreatorPayment({
                reserva,
                partido: { ...partido, id: partidoId },
                sedeId: partido.sede_id,
              });
              requierePagoCreador = true;
              pagoUrl = payment.init_point ?? null;
              console.log(`✓ Partido ${partidoId} completo — MP preference para creador ${capitanUserId}`);
            } catch (paymentErr) {
              console.warn(`⚠️ Pago creador partido ${partidoId}:`, paymentErr.message);
            }
          }
        }
      }

      const hostNombre = await resolveHostName(partido, supabaseAdmin);
      const jugadorPerfil = await fetchJugadorPerfilPublic(supabaseAdmin, user.id, user.email);
      const jugadorNombre =
        jugadorPerfil?.nombre_saludo
        ?? jugadorPerfil?.apodo
        ?? jugadorPerfil?.nombre
        ?? emailLocalPart(user.email)
        ?? 'Un jugador';

      await notifyPartidoJugadorUnido(
        supabaseAdmin,
        { ...partido, id: partidoId },
        jugadorNombre,
      );

      console.log(`✓ POST /api/partidos/${partidoId}/unirse — user ${user.id}`);
      res.json({
        success: true,
        partido_completo: partidoCompleto,
        requiere_pago_creador: requierePagoCreador,
        pago_url: pagoUrl,
        host_nombre: hostNombre,
        jugadores_actuales: newCount,
      });
    } catch (err) {
      console.error('❌ Error POST /api/partidos/:id/unirse:', err.message);
      return sendHttpError(res, err);
    }
  });

  router.post('/:id/cancelar', async (req, res) => {
    try {
      const { user, status, error: authError } = await getAuthenticatedUser(req);
      if (!user) {
        return res.status(status).json({ error: authError });
      }

      const partidoId = parsePartidoId(req.params.id);
      if (partidoId == null) {
        return res.status(400).json({ error: 'ID de partido inválido' });
      }

      const { data: partido, error: fetchErr } = await supabaseAdmin
        .from('partidos_abiertos')
        .select('*')
        .eq('id', partidoId)
        .maybeSingle();

      if (fetchErr) throw fetchErr;
      if (!partido) {
        return res.status(404).json({ error: 'Partido no encontrado' });
      }

      if (getCapitanUserId(partido) !== user.id) {
        return res.status(403).json({ error: 'Solo el creador puede cancelar el partido' });
      }

      const cancellableStates = ['abierto', 'completo'];
      if (!cancellableStates.includes(partido.estado)) {
        return res.status(400).json({ error: 'Este partido ya no se puede cancelar' });
      }

      await cancelPartidoWithReserva(
        supabaseAdmin,
        partidoId,
        partido.reserva_id,
        'cancelado',
      );

      // TODO: notify all jugadores_partido via push notification when partido is cancelled

      console.log(`✓ POST /api/partidos/${partidoId}/cancelar — user ${user.id}`);
      res.json({ success: true });
    } catch (err) {
      console.error('❌ Error POST /api/partidos/:id/cancelar:', err.message);
      return sendHttpError(res, err);
    }
  });

  router.post('/:id/iniciar-pago', async (req, res) => {
    try {
      const { user, status, error: authError } = await getAuthenticatedUser(req);
      if (!user) {
        return res.status(status).json({ error: authError });
      }

      const partidoId = parsePartidoId(req.params.id);
      if (partidoId == null) {
        return res.status(400).json({ error: 'ID de partido inválido' });
      }

      const { data: partido, error: fetchErr } = await supabaseAdmin
        .from('partidos_abiertos')
        .select('*')
        .eq('id', partidoId)
        .maybeSingle();

      if (fetchErr) throw fetchErr;
      if (!partido) {
        return res.status(404).json({ error: 'Partido no encontrado' });
      }

      if (getCapitanUserId(partido) !== user.id) {
        return res.status(403).json({ error: 'Solo el creador puede pagar la reserva' });
      }

      if (partido.estado !== 'completo') {
        return res.status(400).json({ error: 'El partido aún no está completo' });
      }

      if (partido.pago_url) {
        return res.json({ init_point: partido.pago_url, payment_url: partido.pago_url });
      }

      if (!partido.reserva_id || !triggerPartidoCreatorPayment) {
        return res.status(400).json({ error: 'No hay reserva vinculada para cobrar' });
      }

      const { data: reserva, error: reservaErr } = await supabaseAdmin
        .from('reservas')
        .select('*')
        .eq('id', partido.reserva_id)
        .maybeSingle();

      if (reservaErr) throw reservaErr;
      if (!reserva) {
        return res.status(404).json({ error: 'Reserva no encontrada' });
      }

      const payment = await triggerPartidoCreatorPayment({
        reserva,
        partido,
        sedeId: partido.sede_id,
      });

      res.json({
        init_point: payment.init_point,
        payment_url: payment.init_point,
        preference_id: payment.preference_id,
      });
    } catch (err) {
      console.error('❌ Error POST /api/partidos/:id/iniciar-pago:', err.message);
      return sendHttpError(res, err);
    }
  });

  router.post('/', async (req, res) => {
    try {
      const { torneo_id, equipo_a_id, equipo_b_id, fecha_hora, cancha_id, sede_id, fecha, hora, nivel } = req.body;

      if (torneo_id) {
        const { data, error } = await supabase
          .from('partidos')
          .insert([{
            torneo_id,
            equipo_a_id,
            equipo_b_id,
            fecha_hora,
            cancha_id,
            sede_id,
            estado: 'pendiente',
          }])
          .select();

        if (error) throw error;
        return res.json(data);
      }

      const { user, status, error: authError } = await getAuthenticatedUser(req);
      if (!user) {
        return res.status(status).json({ error: authError });
      }

      const activeCount = await countActiveCapitanPartidos(supabaseAdmin, user.id);
      if (activeCount >= ACTIVE_PARTIDO_LIMIT) {
        return activePartidoLimitResponse(res);
      }

      if (!fecha || !hora || !nivel) {
        return res.status(400).json({ error: 'Faltan campos: sede_id, fecha, hora, nivel' });
      }

      const sedeRow = await resolveSedeRow(supabaseAdmin, { sede_id, sede: req.body.sede, sede_nombre: req.body.sede_nombre });
      if (!sedeRow) {
        return res.status(404).json({ error: 'Sede no encontrada' });
      }

      const partidoInsert = buildPartidoAbiertoInsertRow({
        sedeRow,
        body: req.body,
        canchaNombre: resolvePartidoCanchaNombre(req.body),
        capitanFields: await buildCapitanFields(supabaseAdmin, user),
        fecha,
        hora,
        nivel,
        estado: 'abierto',
      });
      console.log('[DEBUG partidos_abiertos INSERT]', {
        sede_id: sedeRow.id,
        fecha,
        estado: 'abierto',
      });

      const { data: partido, error: insertErr } = await supabaseAdmin
        .from('partidos_abiertos')
        .insert([partidoInsert])
        .select('*')
        .single();

      if (insertErr) throw insertErr;

      const { error: hostJoinErr } = await supabaseAdmin
        .from('partidos_abiertos_jugadores')
        .insert([{
          partido_id: partido.id,
          user_id: user.id,
          email: user.email ?? null,
        }]);

      if (hostJoinErr) throw hostJoinErr;

      const hostNombre = await resolveHostName(partido, supabaseAdmin);

      console.log(`✓ POST /api/partidos — partido abierto ${partido.id} por user ${user.id}`);
      res.status(201).json({
        ...partido,
        hora: formatHora(partido.hora),
        sede_nombre: sedeRow?.nombre ?? null,
        host_nombre: hostNombre,
        jugadores_actuales: 1,
        jugadores_count: 1,
      });
    } catch (err) {
      console.error('❌ Error POST /api/partidos:', err.message);
      return sendHttpError(res, err);
    }
  });

  router.put('/:id/equipos', async (req, res) => {
    try {
      const { user, status, error: authError } = await getAuthenticatedUser(req);
      if (!user) {
        return res.status(status).json({ error: authError });
      }

      const partidoId = parsePartidoId(req.params.id);
      if (partidoId == null) {
        return res.status(400).json({ error: 'ID de partido inválido' });
      }

      const result = await procesarDefinirEquiposPartido({
        supabaseAdmin,
        partidoId,
        user,
        body: req.body,
        pgPool,
      });

      console.log(`✓ PUT /api/partidos/${partidoId}/equipos — ${req.body?.modo ?? 'ok'}`);
      res.status(result.status).json(result.body);
    } catch (err) {
      if (err instanceof EquiposPartidoError) {
        return res.status(err.status ?? 400).json({
          error: err.message,
          code: err.code ?? null,
        });
      }
      console.error('❌ Error PUT /api/partidos/:id/equipos:', err.message);
      return sendHttpError(res, err);
    }
  });

  router.put('/:id/equipos/nombres', async (req, res) => {
    try {
      const { user, status, error: authError } = await getAuthenticatedUser(req);
      if (!user) {
        return res.status(status).json({ error: authError });
      }

      const partidoId = parsePartidoId(req.params.id);
      if (partidoId == null) {
        return res.status(400).json({ error: 'ID de partido inválido' });
      }

      const result = await procesarActualizarNombresEquiposPartido({
        supabaseAdmin,
        partidoId,
        user,
        body: req.body,
        pgPool,
      });

      console.log(`✓ PUT /api/partidos/${partidoId}/equipos/nombres`);
      res.status(result.status).json(result.body);
    } catch (err) {
      if (err instanceof EquiposPartidoError) {
        return res.status(err.status ?? 400).json({
          error: err.message,
          code: err.code ?? null,
        });
      }
      console.error('❌ Error PUT /api/partidos/:id/equipos/nombres:', err.message);
      return sendHttpError(res, err);
    }
  });

  router.post('/:id/resultado', async (req, res) => {
    try {
      const { user, status, error: authError } = await getAuthenticatedUser(req);
      if (!user) {
        return res.status(status).json({ error: authError });
      }

      const partidoId = parsePartidoId(req.params.id);
      if (partidoId == null) {
        return res.status(400).json({ error: 'ID de partido inválido' });
      }

      const result = await procesarResultadoPartidoCasual({
        supabaseAdmin,
        partidoId,
        user,
        body: req.body,
      });

      console.log(
        `✓ POST /api/partidos/${partidoId}/resultado — ${result.body?.estado_confirmacion ?? 'ok'}`,
      );
      res.status(result.status).json(result.body);
    } catch (err) {
      console.error('❌ Error POST /api/partidos/:id/resultado:', err.message);
      return sendHttpError(res, err);
    }
  });

  return router;
}

export function createPartidosAbiertosRouter({ supabaseAdmin, getAuthenticatedUser }) {
  const router = express.Router();

  router.get('/:id', async (req, res) => {
    try {
      const { user, status, error: authError } = await getAuthenticatedUser(req);
      if (!user) {
        return res.status(status).json({ error: authError });
      }

      const partidoId = parsePartidoId(req.params.id);
      if (partidoId == null) {
        return res.status(400).json({ error: 'ID de partido inválido' });
      }

      const access = await userCanAccessPartido(partidoId, user, supabaseAdmin);
      if (!access.allowed) {
        return res.status(access.status ?? 403).json({ error: access.reason });
      }

      const { data: partido, error } = await supabaseAdmin
        .from('partidos_abiertos')
        .select(PARTIDO_SELECT)
        .eq('id', partidoId)
        .maybeSingle();

      if (error) throw error;
      if (!partido) {
        return res.status(404).json({ error: 'Partido no encontrado' });
      }

      res.json(await mapPartidoDetail(partido, supabaseAdmin, user));
    } catch (err) {
      console.error('❌ Error GET /api/partidos-abiertos/:id:', err.message);
      return sendHttpError(res, err);
    }
  });

  router.post('/:id/resultado', async (req, res) => {
    try {
      const { user, status, error: authError } = await getAuthenticatedUser(req);
      if (!user) {
        return res.status(status).json({ error: authError });
      }

      const partidoId = parsePartidoId(req.params.id);
      if (partidoId == null) {
        return res.status(400).json({ error: 'ID de partido inválido' });
      }

      const access = await userCanAccessPartido(partidoId, user, supabaseAdmin);
      if (!access.allowed) {
        return res.status(access.status ?? 403).json({ error: access.reason });
      }

      const { data: partido, error: fetchErr } = await supabaseAdmin
        .from('partidos_abiertos')
        .select('id, estado, fecha, hora')
        .eq('id', partidoId)
        .maybeSingle();

      if (fetchErr) throw fetchErr;
      if (!partido) {
        return res.status(404).json({ error: 'Partido no encontrado' });
      }
      if (partido.estado !== 'completo') {
        return res.status(400).json({ error: 'Solo se puede cargar resultado en partidos completos' });
      }
      if (!isMatchPast(partido.fecha, partido.hora)) {
        return res.status(400).json({ error: 'El partido aún no finalizó' });
      }

      const validation = validateResultadoPayload(req.body);
      if (!validation.valid) {
        return res.status(400).json({ error: validation.error });
      }

      const { error: updateErr } = await supabaseAdmin
        .from('partidos_abiertos')
        .update({
          resultado: validation.resultado,
          ganador: validation.ganador,
          estado: 'finalizado',
        })
        .eq('id', partidoId);

      if (updateErr) throw updateErr;

      console.log(`✓ POST /api/partidos-abiertos/${partidoId}/resultado — ganador ${validation.ganador}`);
      res.json({ success: true, ganador: validation.ganador });
    } catch (err) {
      console.error('❌ Error POST /api/partidos-abiertos/:id/resultado:', err.message);
      return sendHttpError(res, err);
    }
  });

  return router;
}

export default createPartidosRouter;
