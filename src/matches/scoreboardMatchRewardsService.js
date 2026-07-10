import {
  ensureOrganizerParticipantFromReserva,
  markAttendance,
  upsertMatchParticipant,
} from './matchParticipantsService.js';
import {
  processCasualMatchRankingAfterScoreboardFinished,
} from '../ranking/casualMatchRankingService.js';
import {
  creditValidatedMatchPadcoins,
} from './matchRewardsService.js';
import { maybeDeferCasualRewardsForAttendance } from './matchAttendanceService.js';
import {
  MATCH_ATTENDANCE_STATUS,
  MATCH_PARTICIPANT_ROLES,
  MATCH_PARTICIPANT_SOURCES,
  MATCH_REWARD_STATUS,
  MATCH_TYPES,
  isValidUserId,
  normalizeMatchId,
} from './matchParticipantsConstants.js';

export function isScoreboardEstadoTerminado(estado) {
  const normalized = String(estado ?? '').trim().toLowerCase();
  return normalized === 'terminado' || normalized === 'finalizado';
}

function parseJsonArray(value) {
  if (Array.isArray(value)) return value;
  if (value == null || value === '') return [];
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

function normalizeTeam(raw) {
  const t = String(raw ?? '').trim().toUpperCase();
  if (t === 'A' || t === 'B') return t;
  const lower = String(raw ?? '').trim().toLowerCase();
  if (lower === 'a') return 'A';
  if (lower === 'b') return 'B';
  return null;
}

function extractUserIdFromJugadorJson(jugador) {
  const uid = jugador?.user_id ?? jugador?.userId ?? null;
  return isValidUserId(uid) ? String(uid).trim() : null;
}

/**
 * Resuelve vínculo casual desde scoreboard (partido_abierto + reserva).
 * Torneos quedan fuera de alcance PadCoins Fase 2.
 */
export async function resolveCasualLinkFromScoreboard(supabaseAdmin, scoreboard = {}) {
  if (scoreboard.partido_torneo_id != null) {
    return {
      partidoId: null,
      reservaId: null,
      capitanUserId: null,
      skipped: true,
      reason: 'torneo_out_of_scope',
    };
  }

  let partidoId = scoreboard.partido_abierto_id != null
    ? Number(scoreboard.partido_abierto_id)
    : null;
  let reservaId = scoreboard.reserva_id != null
    ? Number(scoreboard.reserva_id)
    : null;
  let capitanUserId = null;
  let resolvedVia = null;

  if (Number.isFinite(partidoId) && partidoId > 0) {
    const { data: partido, error } = await supabaseAdmin
      .from('partidos_abiertos')
      .select('id, reserva_id, capitan_user_id')
      .eq('id', partidoId)
      .maybeSingle();

    if (error) throw error;
    if (partido?.reserva_id != null && !reservaId) {
      reservaId = Number(partido.reserva_id);
    }
    capitanUserId = partido?.capitan_user_id ?? null;
    resolvedVia = 'partido_abierto_id';
    return { partidoId, reservaId, capitanUserId, resolvedVia };
  }

  if (Number.isFinite(reservaId) && reservaId > 0) {
    const { data: reserva, error: reservaErr } = await supabaseAdmin
      .from('reservas')
      .select('id, partido_id, user_id')
      .eq('id', reservaId)
      .maybeSingle();

    if (reservaErr) throw reservaErr;

    if (reserva?.partido_id != null) {
      partidoId = Number(reserva.partido_id);
      const { data: partido } = await supabaseAdmin
        .from('partidos_abiertos')
        .select('id, capitan_user_id')
        .eq('id', partidoId)
        .maybeSingle();
      capitanUserId = partido?.capitan_user_id ?? null;
      resolvedVia = 'reserva.partido_id';
      return { partidoId, reservaId, capitanUserId, resolvedVia };
    }

    const { data: partido, error: partidoErr } = await supabaseAdmin
      .from('partidos_abiertos')
      .select('id, capitan_user_id')
      .eq('reserva_id', reservaId)
      .maybeSingle();

    if (partidoErr) throw partidoErr;
    if (partido?.id != null) {
      partidoId = Number(partido.id);
      capitanUserId = partido.capitan_user_id ?? null;
      resolvedVia = 'partidos_abiertos.reserva_id';
      return { partidoId, reservaId, capitanUserId, resolvedVia };
    }

    return {
      partidoId: null,
      reservaId,
      capitanUserId: null,
      reason: 'reserva_sin_partido_abierto',
    };
  }

  return {
    partidoId: null,
    reservaId: null,
    capitanUserId: null,
    reason: 'sin_vinculo_casual',
  };
}

/**
 * Participantes identificables desde scoreboard (solo user_id).
 */
export async function collectScoreboardParticipantCandidates(supabaseAdmin, scoreboard = {}) {
  const byUserId = new Map();
  let skippedNoUserId = 0;

  const addCandidate = (userId, meta = {}) => {
    if (!isValidUserId(userId)) {
      skippedNoUserId += 1;
      return;
    }
    const key = String(userId).trim();
    if (!byUserId.has(key)) {
      byUserId.set(key, {
        user_id: key,
        team: meta.team ?? null,
        email: meta.email ?? null,
        source: meta.source ?? 'scoreboard',
      });
    }
  };

  if (scoreboard.id) {
    const { data: tempRows, error } = await supabaseAdmin
      .from('scoreboard_jugadores_temp')
      .select('user_id, equipo, nombre')
      .eq('partido_id', scoreboard.id);

    if (error) throw error;

    for (const row of tempRows ?? []) {
      if (!isValidUserId(row.user_id)) {
        skippedNoUserId += 1;
        continue;
      }
      addCandidate(row.user_id, {
        team: normalizeTeam(row.equipo),
        source: 'scoreboard_jugadores_temp',
      });
    }
  }

  for (const jugador of parseJsonArray(scoreboard.equipo_a_jugadores)) {
    const uid = extractUserIdFromJugadorJson(jugador);
    if (uid) {
      addCandidate(uid, { team: 'A', email: jugador.email ?? null, source: 'equipo_a_jugadores' });
    } else if (jugador?.nombre || jugador?.name) {
      skippedNoUserId += 1;
    }
  }

  for (const jugador of parseJsonArray(scoreboard.equipo_b_jugadores)) {
    const uid = extractUserIdFromJugadorJson(jugador);
    if (uid) {
      addCandidate(uid, { team: 'B', email: jugador.email ?? null, source: 'equipo_b_jugadores' });
    } else if (jugador?.nombre || jugador?.name) {
      skippedNoUserId += 1;
    }
  }

  const partidoId = scoreboard.partido_abierto_id;
  if (partidoId != null) {
    const { data: jugadores, error } = await supabaseAdmin
      .from('partidos_abiertos_jugadores')
      .select('user_id, email')
      .eq('partido_id', Number(partidoId));

    if (error) throw error;

    for (const jugador of jugadores ?? []) {
      if (!isValidUserId(jugador.user_id)) {
        skippedNoUserId += 1;
        continue;
      }
      addCandidate(jugador.user_id, {
        email: jugador.email ?? null,
        source: 'partidos_abiertos_jugadores',
      });
    }
  }

  return {
    candidates: [...byUserId.values()],
    skipped_no_user_id: skippedNoUserId,
  };
}

export function buildScoreboardResultPayload(scoreboard = {}) {
  const setsA = Number(scoreboard.sets_a) || 0;
  const setsB = Number(scoreboard.sets_b) || 0;
  let ganador = null;
  if (setsA > setsB) ganador = 'A';
  else if (setsB > setsA) ganador = 'B';

  return {
    sets_a: setsA,
    sets_b: setsB,
    games_a: Number(scoreboard.games_a) || 0,
    games_b: Number(scoreboard.games_b) || 0,
    score_a: Number(scoreboard.score_a) || 0,
    score_b: Number(scoreboard.score_b) || 0,
    historial_sets: parseJsonArray(scoreboard.historial_sets),
    ganador,
    estado: scoreboard.estado ?? null,
  };
}

/**
 * Upsert match_participants desde fuentes Smart Score.
 */
export async function syncParticipantsFromScoreboard(supabaseAdmin, {
  scoreboard,
  partidoId,
  reservaId = null,
  capitanUserId = null,
  reservaUserId = null,
} = {}) {
  const matchId = normalizeMatchId(partidoId);
  if (!matchId) {
    return { ok: false, reason: 'invalid_partido_id', synced: [], identified_count: 0 };
  }

  const { candidates, skipped_no_user_id: skippedFromCollect } = await collectScoreboardParticipantCandidates(
    supabaseAdmin,
    scoreboard,
  );

  const confirmedAt = new Date().toISOString();
  const synced = [];
  const seenUserIds = new Set();

  for (const candidate of candidates) {
    const isOrganizer = (
      (capitanUserId && candidate.user_id === capitanUserId)
      || (reservaUserId && candidate.user_id === reservaUserId && !capitanUserId)
    );

    const result = await upsertMatchParticipant(supabaseAdmin, {
      match_type: MATCH_TYPES.CASUAL,
      match_id: matchId,
      reserva_id: reservaId,
      user_id: candidate.user_id,
      email: candidate.email,
      team: candidate.team,
      role: isOrganizer
        ? MATCH_PARTICIPANT_ROLES.ORGANIZER
        : MATCH_PARTICIPANT_ROLES.PARTICIPANT,
      source: MATCH_PARTICIPANT_SOURCES.SCOREBOARD,
      attendance_status: MATCH_ATTENDANCE_STATUS.ADMIN_VALIDATED,
      attendance_confirmed_at: confirmedAt,
      reward_status: MATCH_REWARD_STATUS.ELIGIBLE,
    });

    if (result.ok) {
      synced.push(result.participant);
      seenUserIds.add(candidate.user_id);
    }
  }

  return {
    ok: true,
    synced,
    identified_count: seenUserIds.size,
    skipped_no_user_id: skippedFromCollect,
  };
}

async function fetchReservaForScoreboardPadcoins(supabaseAdmin, reservaId) {
  const { data, error } = await supabaseAdmin
    .from('reservas')
    .select('id, user_id, sede_id, sede, estado, fecha, hora, hora_fin, hora_inicio, partido_id, precio, precio_esperado, monto_pagado, moneda, pago_estado')
    .eq('id', reservaId)
    .maybeSingle();

  if (error) throw error;
  return data ?? null;
}

/**
 * Procesa PadCoins tras scoreboard casual terminado (Smart Score Fase 2).
 */
export async function processScoreboardPadcoinsAfterFinished(supabaseAdmin, scoreboard = {}, deps = {}) {
  const scoreboardId = scoreboard.id ?? null;
  const resultPayload = buildScoreboardResultPayload(scoreboard);

  const link = await resolveCasualLinkFromScoreboard(supabaseAdmin, scoreboard);
  if (link.skipped || link.reason === 'torneo_out_of_scope') {
    console.log(
      `[PadCoins Scoreboard] skip torneo scoreboard=${scoreboardId} partido_torneo_id=${scoreboard.partido_torneo_id ?? 'null'}`,
    );
    return { ok: true, skipped: true, reason: link.reason ?? 'torneo_out_of_scope', scoreboard_id: scoreboardId };
  }

  if (!link.partidoId) {
    console.log(
      `[PadCoins Scoreboard] skip sin partido casual scoreboard=${scoreboardId} reserva_id=${link.reservaId ?? scoreboard.reserva_id ?? 'null'} reason=${link.reason ?? 'sin_partido'}`,
    );
    return {
      ok: true,
      skipped: true,
      reason: link.reason ?? 'sin_partido_casual',
      scoreboard_id: scoreboardId,
      reserva_id: link.reservaId ?? null,
      score_payload: resultPayload,
    };
  }

  const reserva = link.reservaId
    ? await fetchReservaForScoreboardPadcoins(supabaseAdmin, link.reservaId)
    : null;

  if (!reserva?.id || !isValidUserId(reserva.user_id)) {
    console.log(
      `[PadCoins Scoreboard] skip sin reserva acreditable scoreboard=${scoreboardId} partido_abierto_id=${link.partidoId}`,
    );
    return {
      ok: true,
      skipped: true,
      reason: 'sin_reserva_vinculada',
      scoreboard_id: scoreboardId,
      partido_abierto_id: link.partidoId,
      score_payload: resultPayload,
    };
  }

  const partido = { id: link.partidoId, capitan_user_id: link.capitanUserId, reserva_id: reserva.id };

  const { data: partidoAttendance, error: partidoAttendanceErr } = await supabaseAdmin
    .from('partidos_abiertos')
    .select('id, capitan_user_id, reserva_id, estado, equipos_asignacion, attendance_collection_status, attendance_opened_at, attendance_deadline_at, sede_id')
    .eq('id', link.partidoId)
    .maybeSingle();

  if (partidoAttendanceErr) throw partidoAttendanceErr;

  const attendanceDefer = await maybeDeferCasualRewardsForAttendance(supabaseAdmin, link.partidoId, {
    partido: partidoAttendance ?? partido,
    scoreboard,
    source: 'scoreboard',
    reservaId: reserva.id,
  }).catch((err) => {
    console.error(`[Attendance Fase 3.1] scoreboard=${scoreboardId} error:`, err.message);
    return {
      deferred: true,
      attendance_pending: false,
      reason: 'attendance_window_error',
      error: err.message,
    };
  });

  if (attendanceDefer.deferred) {
    console.log(
      `[Attendance Fase 3.1] scoreboard=${scoreboardId} partido=${link.partidoId} rewards deferred reason=${attendanceDefer.reason}`,
    );
    return {
      ok: true,
      acreditado: false,
      attendance_pending: attendanceDefer.attendance_pending === true,
      reason: attendanceDefer.reason ?? 'attendance_pending',
      scoreboard_id: scoreboardId,
      partido_abierto_id: link.partidoId,
      reserva_id: reserva.id,
      score_payload: resultPayload,
      attendance: attendanceDefer.attendance ?? null,
    };
  }

  await ensureOrganizerParticipantFromReserva(supabaseAdmin, { reserva, partido });

  const syncResult = await syncParticipantsFromScoreboard(supabaseAdmin, {
    scoreboard,
    partidoId: link.partidoId,
    reservaId: reserva.id,
    capitanUserId: link.capitanUserId,
    reservaUserId: reserva.user_id,
  });

  if (isValidUserId(link.capitanUserId)) {
    await markAttendance(supabaseAdmin, {
      matchId: normalizeMatchId(link.partidoId),
      userId: link.capitanUserId,
      attendanceStatus: MATCH_ATTENDANCE_STATUS.ADMIN_VALIDATED,
      rewardStatus: MATCH_REWARD_STATUS.ELIGIBLE,
    });
  }

  if (isValidUserId(reserva.user_id)) {
    await markAttendance(supabaseAdmin, {
      matchId: normalizeMatchId(link.partidoId),
      userId: reserva.user_id,
      attendanceStatus: MATCH_ATTENDANCE_STATUS.ADMIN_VALIDATED,
      rewardStatus: MATCH_REWARD_STATUS.ELIGIBLE,
    });
  }

  if (!syncResult.identified_count) {
    console.log(
      `[PadCoins Scoreboard] skip sin participantes user_id scoreboard=${scoreboardId} partido_abierto_id=${link.partidoId} skipped_no_user_id=${syncResult.skipped_no_user_id ?? 0}`,
    );
    return {
      ok: true,
      acreditado: false,
      reason: 'sin_participantes_identificados',
      scoreboard_id: scoreboardId,
      partido_abierto_id: link.partidoId,
      reserva_id: reserva.id,
      sync: syncResult,
      score_payload: resultPayload,
    };
  }

  const creditFn = deps.creditValidatedMatchPadcoins ?? creditValidatedMatchPadcoins;
  const creditResult = await creditFn(supabaseAdmin, {
    matchId: normalizeMatchId(link.partidoId),
    reserva,
    organizerUserId: reserva.user_id,
    ...(deps.creditOptions ?? {}),
  });

  const creditedCount = (creditResult.credits ?? []).filter((c) => c.acreditado).length;
  const totalPadcoins = creditResult.total_padcoins ?? 0;

  console.log(
    `[PadCoins Scoreboard] scoreboard=${scoreboardId} partido_abierto_id=${link.partidoId} reserva_id=${reserva.id} participants=${syncResult.identified_count} credited_users=${creditedCount} total_padcoins=${totalPadcoins} skipped_no_user_id=${syncResult.skipped_no_user_id ?? 0} acreditado=${creditResult.acreditado === true}`,
  );

  const rankingResult = await processCasualMatchRankingAfterScoreboardFinished(supabaseAdmin, {
    scoreboard,
    partidoId: link.partidoId,
    reservaId: reserva.id,
    scorePayload: resultPayload,
  }).catch((err) => {
    console.warn(
      `[Ranking Scoreboard] error scoreboard=${scoreboardId} partido=${link.partidoId}:`,
      err.message,
    );
    return null;
  });

  return {
    ok: true,
    scoreboard_id: scoreboardId,
    partido_abierto_id: link.partidoId,
    reserva_id: reserva.id,
    resolved_via: link.resolvedVia ?? null,
    sync: syncResult,
    score_payload: resultPayload,
    ranking: rankingResult,
    ...creditResult,
  };
}

/**
 * Hook: primera transición a terminado en scoreboard casual (no torneo).
 */
export async function maybeProcessCasualPadcoinsAfterScoreboardTerminated(
  supabaseAdmin,
  saved,
  estadoAntes,
  deps = {},
) {
  if (saved?.partido_torneo_id) {
    return { skipped: true, reason: 'torneo' };
  }
  if (isScoreboardEstadoTerminado(estadoAntes)) return { skipped: true, reason: 'already_terminated' };
  if (!isScoreboardEstadoTerminado(saved?.estado)) return { skipped: true, reason: 'not_terminated' };

  const processFn = deps.processScoreboardPadcoinsAfterFinished ?? processScoreboardPadcoinsAfterFinished;

  try {
    return await processFn(supabaseAdmin, saved);
  } catch (err) {
    console.error(
      `[PadCoins Scoreboard] error scoreboard=${saved?.id ?? 'unknown'}:`,
      err?.message || err,
    );
    return { ok: false, error: err?.message || String(err), scoreboard_id: saved?.id ?? null };
  }
}
