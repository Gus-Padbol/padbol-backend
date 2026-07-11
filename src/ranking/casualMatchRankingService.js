import {
  createMatchRewardEvent,
  preventDuplicateRewardBySourceKey,
} from '../matches/matchRewardsService.js';
import {
  listMatchParticipants,
  resolveEligibleParticipantsForRewards,
} from '../matches/matchParticipantsService.js';
import { isMissingRankingsStatsColumnError } from '../../lib/rankingsLeaderboardPublic.js';
import {
  isEquiposAsignacionValida,
  normalizeEquipoUserIds,
} from '../partidos/equiposService.js';
import {
  MATCH_REWARD_EVENT_STATUS,
  MATCH_REWARD_TYPES,
  MATCH_TYPES,
  isValidUserId,
  normalizeMatchId,
} from '../matches/matchParticipantsConstants.js';

/** Ranking points (RP) — Fase 1 casual. Padbol no admite empates. */
export const CASUAL_RANKING_RP = Object.freeze({
  WIN: 3,
  LOSS: 1,
});

export const CASUAL_RANKING_DEFAULT_NIVEL = 'club';
export const CASUAL_RANKING_DEFAULT_DEPORTE = 'padbol';

const MANUAL_WINNER_SIDES = new Set(['equipo1', 'equipo2']);
const SCOREBOARD_WINNER_SIDES = new Set(['A', 'B']);

function isMissingRankingsLeaderboardTable(error) {
  if (isMissingRankingsStatsColumnError(error)) return false;
  const message = String(error?.message ?? '').toLowerCase();
  return (
    error?.code === '42P01'
    || error?.code === 'PGRST205'
    || (message.includes('rankings_leaderboard') && message.includes('does not exist'))
    || message.includes('could not find the table')
  );
}

export function buildCasualMatchRankingSourceKey(matchId, userId) {
  return `user|match|${MATCH_TYPES.CASUAL}|${normalizeMatchId(matchId)}|ranking|${userId}`;
}

function buildScoreboardResultPayloadFromRow(scoreboard = {}) {
  const setsA = Number(scoreboard.sets_a) || 0;
  const setsB = Number(scoreboard.sets_b) || 0;
  let ganador = null;
  if (setsA > setsB) ganador = 'A';
  else if (setsB > setsA) ganador = 'B';

  return {
    sets_a: setsA,
    sets_b: setsB,
    ganador,
    estado: scoreboard.estado ?? null,
  };
}

function normalizeParticipantTeam(team) {
  const raw = String(team ?? '').trim();
  if (!raw) return null;

  const upper = raw.toUpperCase();
  if (upper === 'A') return 'A';
  if (upper === 'B') return 'B';

  const lower = raw.toLowerCase();
  if (lower === 'equipo1' || lower === 'equipo_1' || lower === 'team1') return 'equipo1';
  if (lower === 'equipo2' || lower === 'equipo_2' || lower === 'team2') return 'equipo2';

  return null;
}

function normalizeManualGanador(ganador) {
  const value = String(ganador ?? '').trim().toLowerCase();
  if (value === 'equipo1' || value === 'equipo_1') return 'equipo1';
  if (value === 'equipo2' || value === 'equipo_2') return 'equipo2';
  return null;
}

function normalizeScoreboardGanador(ganador) {
  const value = String(ganador ?? '').trim().toUpperCase();
  if (value === 'A' || value === 'B') return value;
  return null;
}

function rejectTiedManualScores(resultado = {}) {
  if (
    Number.isFinite(Number(resultado.equipo1))
    && Number.isFinite(Number(resultado.equipo2))
    && Number(resultado.equipo1) === Number(resultado.equipo2)
  ) {
    return { ok: false, reason: 'empate_no_permitido' };
  }

  if (
    Number.isFinite(Number(resultado.equipo1_sets))
    && Number.isFinite(Number(resultado.equipo2_sets))
    && Number(resultado.equipo1_sets) === Number(resultado.equipo2_sets)
  ) {
    return { ok: false, reason: 'empate_no_permitido' };
  }

  return null;
}

function hasManualResult(partido = {}) {
  const ganador = normalizeManualGanador(partido.ganador);
  if (!ganador) return false;

  const resultado = partido.resultado;
  if (resultado && typeof resultado === 'object') {
    if (Number.isFinite(Number(resultado.equipo1_sets)) && Number.isFinite(Number(resultado.equipo2_sets))) {
      return true;
    }
    if (Number.isFinite(Number(resultado.equipo1)) && Number.isFinite(Number(resultado.equipo2))) {
      return true;
    }
  }

  return partido.estado === 'finalizado';
}

/**
 * Resuelve ganador/perdedor desde resultado manual o Smart Score.
 */
export function resolveCasualMatchRankingResult({
  partido = null,
  scorePayload = null,
  scoreboard = null,
} = {}) {
  if (scoreboard?.partido_torneo_id != null) {
    return { ok: false, reason: 'torneo_out_of_scope' };
  }

  const payload = scorePayload ?? (scoreboard ? buildScoreboardResultPayloadFromRow(scoreboard) : null);

  if (
    payload
    && Number.isFinite(Number(payload.sets_a))
    && Number.isFinite(Number(payload.sets_b))
    && Number(payload.sets_a) === Number(payload.sets_b)
  ) {
    return { ok: false, reason: 'empate_no_permitido' };
  }

  if (payload?.ganador) {
    const ganador = normalizeScoreboardGanador(payload.ganador);
    if (!ganador) {
      return { ok: false, reason: 'ganador_scoreboard_invalido' };
    }
    return {
      ok: true,
      source: 'scoreboard',
      mode: 'scoreboard',
      ganadorSide: ganador,
      scorePayload: payload,
    };
  }

  if (partido && hasManualResult(partido)) {
    const ganador = normalizeManualGanador(partido.ganador);
    if (!ganador || !MANUAL_WINNER_SIDES.has(ganador)) {
      return { ok: false, reason: 'ganador_manual_invalido' };
    }

    const resultado = partido.resultado ?? {};
    const tiedManual = rejectTiedManualScores(resultado);
    if (tiedManual) {
      return {
        ...tiedManual,
        source: 'manual',
        mode: 'manual',
        scorePayload: resultado,
      };
    }

    return {
      ok: true,
      source: 'manual',
      mode: 'manual',
      ganadorSide: ganador,
      scorePayload: resultado,
    };
  }

  return { ok: false, reason: 'sin_resultado_claro' };
}

function mapManualSideFromEquiposAsignacion(equiposAsignacion) {
  if (!equiposAsignacion || typeof equiposAsignacion !== 'object') {
    return null;
  }

  const map = new Map();
  for (const userId of normalizeEquipoUserIds(equiposAsignacion.equipo1)) {
    map.set(userId, 'equipo1');
  }
  for (const userId of normalizeEquipoUserIds(equiposAsignacion.equipo2)) {
    map.set(userId, 'equipo2');
  }

  if (map.size) {
    return map;
  }

  return null;
}

function mapManualSideFromCapitanes(capitanUserId, capitanes) {
  const caps = capitanes ?? {};
  const capitan1 = caps.capitan1 ?? capitanUserId ?? null;
  const capitan2 = caps.capitan2 ?? null;
  if (!isValidUserId(capitan1) || !isValidUserId(capitan2)) {
    return null;
  }

  return new Map([
    [capitan1, 'equipo1'],
    [capitan2, 'equipo2'],
  ]);
}

function mapScoreboardSideFromParticipants(participants = []) {
  const map = new Map();
  for (const participant of participants) {
    if (!isValidUserId(participant?.user_id)) continue;
    const team = normalizeParticipantTeam(participant.team);
    if (team === 'A' || team === 'B') {
      map.set(participant.user_id, team);
    }
  }
  return map.size ? map : null;
}

function mapScoreboardSideFromJson(scoreboard = {}) {
  const map = new Map();

  const addFromArray = (items, side) => {
    for (const item of items ?? []) {
      const uid = item?.user_id ?? item?.userId ?? null;
      if (isValidUserId(uid)) {
        map.set(String(uid).trim(), side);
      }
    }
  };

  addFromArray(Array.isArray(scoreboard.equipo_a_jugadores) ? scoreboard.equipo_a_jugadores : [], 'A');
  addFromArray(Array.isArray(scoreboard.equipo_b_jugadores) ? scoreboard.equipo_b_jugadores : [], 'B');

  return map.size ? map : null;
}

/**
 * Determina el lado (equipo1/equipo2 o A/B) de cada participante elegible.
 */
export function buildParticipantSideMap({
  mode,
  participants = [],
  partido = null,
  scoreboard = null,
  capitanes = null,
} = {}) {
  if (mode === 'scoreboard') {
    return mapScoreboardSideFromParticipants(participants)
      ?? mapScoreboardSideFromJson(scoreboard)
      ?? new Map();
  }

  return mapManualSideFromEquiposAsignacion(partido?.equipos_asignacion)
    ?? mapManualSideFromCapitanes(partido?.capitan_user_id, capitanes)
    ?? mapScoreboardSideFromParticipants(participants)
    ?? new Map();
}

export function resolveParticipantRankingPoints({
  participant,
  userSideMap,
  mode,
  ganadorSide,
} = {}) {
  if (!participant || !isValidUserId(participant.user_id)) {
    return null;
  }

  const side = userSideMap.get(participant.user_id)
    ?? normalizeParticipantTeam(participant.team);

  if (!side) {
    return null;
  }

  if (mode === 'scoreboard') {
    const winner = normalizeScoreboardGanador(ganadorSide);
    if (!winner || !SCOREBOARD_WINNER_SIDES.has(winner)) return null;
    return side === winner ? CASUAL_RANKING_RP.WIN : CASUAL_RANKING_RP.LOSS;
  }

  const winner = normalizeManualGanador(ganadorSide);
  if (!winner || !MANUAL_WINNER_SIDES.has(winner)) return null;
  return side === winner ? CASUAL_RANKING_RP.WIN : CASUAL_RANKING_RP.LOSS;
}

export async function preventDuplicateRankingBySourceKey(supabaseAdmin, sourceKey) {
  return preventDuplicateRewardBySourceKey(supabaseAdmin, sourceKey);
}

export async function createRankingRewardEvent(supabaseAdmin, payload = {}) {
  return createMatchRewardEvent(supabaseAdmin, {
    ...payload,
    reward_type: MATCH_REWARD_TYPES.RANKING,
  });
}

const RANKINGS_STATS_SELECT =
  'id, puntos, partidos_jugados, ganados, perdidos, empatados, racha_actual, mejor_racha';

export function computeStatsDeltaForOutcome(outcome) {
  switch (String(outcome ?? '').trim().toLowerCase()) {
    case 'win':
      return {
        partidos_jugados: 1,
        ganados: 1,
        perdidos: 0,
        empatados: 0,
        reset_racha: false,
      };
    case 'loss':
      return {
        partidos_jugados: 1,
        ganados: 0,
        perdidos: 1,
        empatados: 0,
        reset_racha: true,
      };
    default:
      return null;
  }
}

export function applyStatsDeltaToRow(existing = {}, outcome) {
  const delta = computeStatsDeltaForOutcome(outcome);
  if (!delta) return null;

  const partidos_jugados = (Number(existing.partidos_jugados) || 0) + delta.partidos_jugados;
  const ganados = (Number(existing.ganados) || 0) + delta.ganados;
  const perdidos = (Number(existing.perdidos) || 0) + delta.perdidos;
  const empatados = (Number(existing.empatados) || 0) + delta.empatados;

  let racha_actual;
  if (delta.reset_racha) {
    racha_actual = 0;
  } else {
    racha_actual = (Number(existing.racha_actual) || 0) + 1;
  }

  const mejor_racha = Math.max(Number(existing.mejor_racha) || 0, racha_actual);

  return {
    stats_delta: {
      partidos_jugados: delta.partidos_jugados,
      ganados: delta.ganados,
      perdidos: delta.perdidos,
      empatados: delta.empatados,
    },
    partidos_jugados,
    ganados,
    perdidos,
    empatados,
    racha_actual,
    mejor_racha,
  };
}

async function fetchRankingLeaderboardRow(supabaseAdmin, {
  userId,
  deporte,
  nivel,
  includeStats = true,
} = {}) {
  const selectCols = includeStats ? RANKINGS_STATS_SELECT : 'id, puntos';
  const { data, error } = await supabaseAdmin
    .from('rankings_leaderboard')
    .select(selectCols)
    .eq('user_id', userId)
    .eq('deporte', deporte)
    .eq('nivel', nivel)
    .maybeSingle();

  if (error) {
    if (isMissingRankingsLeaderboardTable(error)) {
      return { row: null, error: null, tableMissing: true };
    }
    if (includeStats && isMissingRankingsStatsColumnError(error)) {
      return fetchRankingLeaderboardRow(supabaseAdmin, {
        userId, deporte, nivel, includeStats: false,
      });
    }
    throw error;
  }

  return {
    row: data ?? null,
    error: null,
    tableMissing: false,
    statsAvailable: includeStats,
  };
}

async function persistRankingLeaderboardRow(supabaseAdmin, {
  userId,
  deporte,
  nivel,
  existing,
  puntos,
  statsPayload = null,
  statsAvailable = true,
} = {}) {
  const now = new Date().toISOString();
  const updatePayload = {
    puntos,
    updated_at: now,
  };

  if (statsPayload && statsAvailable) {
    Object.assign(updatePayload, {
      partidos_jugados: statsPayload.partidos_jugados,
      ganados: statsPayload.ganados,
      perdidos: statsPayload.perdidos,
      empatados: statsPayload.empatados,
      racha_actual: statsPayload.racha_actual,
      mejor_racha: statsPayload.mejor_racha,
    });
  }

  const resultSelectCols = statsAvailable && statsPayload
    ? RANKINGS_STATS_SELECT
    : 'id, puntos';

  let data;
  let error;

  if (existing?.id != null) {
    ({ data, error } = await supabaseAdmin
      .from('rankings_leaderboard')
      .update(updatePayload)
      .eq('id', existing.id)
      .select(resultSelectCols)
      .maybeSingle());

    if (error && isMissingRankingsStatsColumnError(error)) {
      const puntosOnly = { puntos, updated_at: now };
      ({ data, error } = await supabaseAdmin
        .from('rankings_leaderboard')
        .update(puntosOnly)
        .eq('id', existing.id)
        .select('id, puntos')
        .maybeSingle());
      if (!error) {
        return {
          ok: true,
          row: data,
          statsApplied: false,
          statsOmittedReason: 'stats_columns_missing',
        };
      }
    }
  } else {
    const insertPayload = {
      user_id: userId,
      deporte,
      nivel,
      ...updatePayload,
    };

    ({ data, error } = await supabaseAdmin
      .from('rankings_leaderboard')
      .insert(insertPayload)
      .select(resultSelectCols)
      .maybeSingle());

    if (error?.code === '23505') {
      const retry = await fetchRankingLeaderboardRow(supabaseAdmin, {
        userId, deporte, nivel, includeStats: statsAvailable,
      });
      if (retry.row?.id != null) {
        return persistRankingLeaderboardRow(supabaseAdmin, {
          userId,
          deporte,
          nivel,
          existing: retry.row,
          puntos,
          statsPayload,
          statsAvailable: retry.statsAvailable !== false && statsAvailable,
        });
      }
    }

    if (error && isMissingRankingsStatsColumnError(error)) {
      ({ data, error } = await supabaseAdmin
        .from('rankings_leaderboard')
        .insert({
          user_id: userId,
          deporte,
          nivel,
          puntos,
          updated_at: now,
        })
        .select('id, puntos')
        .maybeSingle());
      if (!error) {
        return {
          ok: true,
          row: data,
          statsApplied: false,
          statsOmittedReason: 'stats_columns_missing',
        };
      }
    }
  }

  if (error) {
    if (isMissingRankingsStatsColumnError(error)) {
      if (existing?.id != null) {
        const puntosOnly = { puntos, updated_at: now };
        ({ data, error } = await supabaseAdmin
          .from('rankings_leaderboard')
          .update(puntosOnly)
          .eq('id', existing.id)
          .select('id, puntos')
          .maybeSingle());
        if (!error) {
          return {
            ok: true,
            row: data,
            statsApplied: false,
            statsOmittedReason: 'stats_columns_missing',
          };
        }
      } else {
        ({ data, error } = await supabaseAdmin
          .from('rankings_leaderboard')
          .insert({
            user_id: userId,
            deporte,
            nivel,
            puntos,
            updated_at: now,
          })
          .select('id, puntos')
          .maybeSingle());
        if (!error) {
          return {
            ok: true,
            row: data,
            statsApplied: false,
            statsOmittedReason: 'stats_columns_missing',
          };
        }
      }
    }
    if (isMissingRankingsLeaderboardTable(error)) {
      return { ok: false, reason: 'rankings_leaderboard_missing', skipped: true };
    }
    throw error;
  }

  return {
    ok: true,
    row: data,
    statsApplied: Boolean(statsPayload && statsAvailable),
    statsOmittedReason: statsPayload && !statsAvailable ? 'stats_columns_missing' : null,
  };
}

/**
 * Actualiza RP y estadísticas en una sola lectura/escritura por jugador.
 */
export async function updatePlayerRanking(supabaseAdmin, {
  userId,
  deporte = CASUAL_RANKING_DEFAULT_DEPORTE,
  nivel = CASUAL_RANKING_DEFAULT_NIVEL,
  rpDelta,
  outcome = null,
} = {}) {
  if (!isValidUserId(userId) || !Number.isFinite(rpDelta) || rpDelta <= 0) {
    return { ok: false, reason: 'invalid_ranking_delta' };
  }

  const normalizedDeporte = String(deporte ?? CASUAL_RANKING_DEFAULT_DEPORTE).trim().toLowerCase()
    || CASUAL_RANKING_DEFAULT_DEPORTE;
  const normalizedNivel = String(nivel ?? CASUAL_RANKING_DEFAULT_NIVEL).trim().toLowerCase()
    || CASUAL_RANKING_DEFAULT_NIVEL;

  const fetched = await fetchRankingLeaderboardRow(supabaseAdmin, {
    userId,
    deporte: normalizedDeporte,
    nivel: normalizedNivel,
    includeStats: true,
  });

  if (fetched.tableMissing) {
    return { ok: false, reason: 'rankings_leaderboard_missing', skipped: true };
  }

  const existing = fetched.row ?? {};
  const nextPuntos = (Number(existing.puntos) || 0) + rpDelta;
  const statsPayload = outcome ? applyStatsDeltaToRow(existing, outcome) : null;
  const statsAvailable = fetched.statsAvailable !== false;

  const persisted = await persistRankingLeaderboardRow(supabaseAdmin, {
    userId,
    deporte: normalizedDeporte,
    nivel: normalizedNivel,
    existing: existing.id != null ? existing : null,
    puntos: nextPuntos,
    statsPayload,
    statsAvailable,
  });

  if (!persisted.ok) {
    return persisted;
  }

  const statsApplied = persisted.statsApplied === true;
  const statsOmittedReason = persisted.statsOmittedReason
    ?? (statsPayload && !statsApplied ? 'stats_columns_missing' : null);

  if (statsOmittedReason) {
    console.warn(
      `[Ranking Casual] stats omitidas user=${userId} deporte=${normalizedDeporte} reason=${statsOmittedReason}`,
    );
  }

  const row = persisted.row ?? {};
  return {
    ok: true,
    userId,
    rpDelta,
    puntos: Number(row.puntos) || nextPuntos,
    outcome,
    stats_applied: statsApplied,
    stats_omitted_reason: statsOmittedReason,
    stats_delta: statsPayload?.stats_delta ?? null,
    partidos_jugados_after: statsApplied ? (Number(row.partidos_jugados) || statsPayload?.partidos_jugados) : null,
    ganados_after: statsApplied ? (Number(row.ganados) || statsPayload?.ganados) : null,
    perdidos_after: statsApplied ? (Number(row.perdidos) || statsPayload?.perdidos) : null,
    empatados_after: statsApplied ? (Number(row.empatados) || statsPayload?.empatados) : null,
    racha_actual_after: statsApplied ? (Number(row.racha_actual) ?? statsPayload?.racha_actual) : null,
    mejor_racha_after: statsApplied ? (Number(row.mejor_racha) ?? statsPayload?.mejor_racha) : null,
  };
}

async function markRankingRewardEventCredited(supabaseAdmin, eventId, metadata = {}) {
  if (!eventId) return;
  await supabaseAdmin
    .from('match_reward_events')
    .update({
      status: MATCH_REWARD_EVENT_STATUS.CREDITED,
      updated_at: new Date().toISOString(),
      metadata,
    })
    .eq('id', eventId);
}

async function resolvePendingRankingEvent(supabaseAdmin, {
  duplicateCheck,
  createPayload,
} = {}) {
  if (duplicateCheck.duplicate && duplicateCheck.event?.status === MATCH_REWARD_EVENT_STATUS.CREDITED) {
    return {
      reuse: false,
      credited: true,
      event: duplicateCheck.event,
    };
  }

  if (duplicateCheck.duplicate && duplicateCheck.event) {
    return {
      reuse: true,
      credited: false,
      event: duplicateCheck.event,
    };
  }

  const created = await createRankingRewardEvent(supabaseAdmin, createPayload);
  if (created.duplicate && created.event) {
    if (created.event.status === MATCH_REWARD_EVENT_STATUS.CREDITED) {
      return { reuse: false, credited: true, event: created.event };
    }
    return { reuse: true, credited: false, event: created.event };
  }

  return {
    reuse: false,
    credited: false,
    event: created.event ?? null,
    createFailed: !created.ok,
    reason: created.reason ?? null,
  };
}

async function creditSingleUserRanking(supabaseAdmin, {
  matchId,
  reservaId = null,
  userId,
  rp,
  outcome,
  deporte,
  nivel,
  metadata = {},
} = {}) {
  const sourceKey = buildCasualMatchRankingSourceKey(matchId, userId);
  const duplicateCheck = await preventDuplicateRankingBySourceKey(supabaseAdmin, sourceKey);

  const eventResolution = await resolvePendingRankingEvent(supabaseAdmin, {
    duplicateCheck,
    createPayload: {
      match_type: MATCH_TYPES.CASUAL,
      match_id: matchId,
      reserva_id: reservaId,
      user_id: userId,
      amount: rp,
      status: MATCH_REWARD_EVENT_STATUS.PENDING,
      source_key: sourceKey,
      metadata: {
        outcome,
        rp,
        ...metadata,
      },
    },
  });

  if (eventResolution.credited) {
    return {
      acreditado: false,
      reason: 'ya_acreditado_event',
      userId,
      sourceKey,
      event: eventResolution.event,
    };
  }

  const pendingEvent = eventResolution.event;
  if (!pendingEvent?.id) {
    return {
      acreditado: false,
      reason: eventResolution.reason ?? 'event_create_failed',
      userId,
      sourceKey,
    };
  }

  let rankingUpdate;
  try {
    rankingUpdate = await updatePlayerRanking(supabaseAdmin, {
      userId,
      deporte,
      nivel,
      rpDelta: rp,
      outcome,
    });
  } catch (err) {
    console.error(`[Ranking Casual] ranking update error user=${userId} match=${matchId}:`, err?.message ?? err);
    return {
      acreditado: false,
      reason: 'ranking_update_failed',
      userId,
      sourceKey,
      pendingEvent,
      recoverable: true,
    };
  }

  if (!rankingUpdate.ok) {
    return {
      acreditado: false,
      reason: rankingUpdate.reason ?? 'ranking_update_failed',
      userId,
      sourceKey,
      pendingEvent,
      rankingUpdate,
      recoverable: rankingUpdate.reason !== 'rankings_leaderboard_missing',
    };
  }

  const eventMetadata = {
    ...(pendingEvent.metadata ?? {}),
    outcome,
    rp,
    participant_side: metadata.participant_side ?? null,
    mode: metadata.mode ?? null,
    puntos_totales: rankingUpdate.puntos,
    stats_applied: rankingUpdate.stats_applied === true,
    stats_omitted_reason: rankingUpdate.stats_omitted_reason ?? null,
    stats_delta: rankingUpdate.stats_delta ?? null,
    partidos_jugados_after: rankingUpdate.partidos_jugados_after,
    ganados_after: rankingUpdate.ganados_after,
    perdidos_after: rankingUpdate.perdidos_after,
    empatados_after: rankingUpdate.empatados_after,
    racha_actual_after: rankingUpdate.racha_actual_after,
    mejor_racha_after: rankingUpdate.mejor_racha_after,
  };

  await markRankingRewardEventCredited(supabaseAdmin, pendingEvent.id, eventMetadata);

  return {
    acreditado: true,
    userId,
    rp,
    outcome,
    sourceKey,
    puntos: rankingUpdate.puntos,
    stats_applied: rankingUpdate.stats_applied === true,
    stats_omitted_reason: rankingUpdate.stats_omitted_reason ?? null,
    stats: {
      partidos_jugados: rankingUpdate.partidos_jugados_after,
      ganados: rankingUpdate.ganados_after,
      perdidos: rankingUpdate.perdidos_after,
      empatados: rankingUpdate.empatados_after,
      racha_actual: rankingUpdate.racha_actual_after,
      mejor_racha: rankingUpdate.mejor_racha_after,
    },
  };
}

/**
 * Acredita ranking casual idempotente para un partido validado.
 */
export async function creditCasualMatchRanking(supabaseAdmin, {
  matchId,
  partido = null,
  scoreboard = null,
  scorePayload = null,
  reservaId = null,
  deporte = null,
  nivel = CASUAL_RANKING_DEFAULT_NIVEL,
  participants = null,
  capitanes = null,
} = {}) {
  const normalizedMatchId = normalizeMatchId(matchId);
  if (!normalizedMatchId) {
    return { ok: false, reason: 'invalid_match_id' };
  }

  if (scoreboard?.partido_torneo_id != null) {
    return { ok: true, acreditado: false, skipped: true, reason: 'torneo_out_of_scope' };
  }

  const resolved = resolveCasualMatchRankingResult({ partido, scorePayload, scoreboard });
  if (!resolved.ok) {
    return { ok: true, acreditado: false, reason: resolved.reason ?? 'sin_resultado_claro' };
  }

  const matchParticipants = participants ?? await listMatchParticipants(supabaseAdmin, {
    matchType: MATCH_TYPES.CASUAL,
    matchId: normalizedMatchId,
  });

  const eligible = resolveEligibleParticipantsForRewards(matchParticipants);
  if (!eligible.length) {
    return { ok: true, acreditado: false, reason: 'sin_participantes_elegibles' };
  }

  const userSideMap = buildParticipantSideMap({
    mode: resolved.mode,
    participants: eligible,
    partido,
    scoreboard,
    capitanes: capitanes ?? null,
  });

  const resolvedDeporte = String(
    deporte
    ?? partido?.deporte
    ?? scoreboard?.deporte
    ?? CASUAL_RANKING_DEFAULT_DEPORTE,
  ).trim().toLowerCase() || CASUAL_RANKING_DEFAULT_DEPORTE;

  const credits = [];
  for (const participant of eligible) {
    const rp = resolveParticipantRankingPoints({
      participant,
      userSideMap,
      mode: resolved.mode,
      ganadorSide: resolved.ganadorSide,
    });

    if (!Number.isFinite(rp) || rp <= 0) {
      credits.push({
        acreditado: false,
        userId: participant.user_id,
        reason: 'lado_no_determinado',
      });
      continue;
    }

    const outcome = rp === CASUAL_RANKING_RP.WIN ? 'win' : 'loss';

    credits.push(await creditSingleUserRanking(supabaseAdmin, {
      matchId: normalizedMatchId,
      reservaId,
      userId: participant.user_id,
      rp,
      outcome,
      deporte: resolvedDeporte,
      nivel,
      metadata: {
        mode: resolved.mode,
        ganador_side: resolved.ganadorSide,
        participant_side: userSideMap.get(participant.user_id)
          ?? normalizeParticipantTeam(participant.team),
      },
    }));
  }

  const acreditados = credits.filter((c) => c.acreditado);
  const totalRp = acreditados.reduce((sum, c) => sum + (c.rp ?? 0), 0);

  console.log(
    `[Ranking Casual] match=${normalizedMatchId} mode=${resolved.mode} ganador=${resolved.ganadorSide ?? 'none'} eligible=${eligible.length} credited=${acreditados.length} total_rp=${totalRp}`,
  );

  return {
    ok: true,
    acreditado: acreditados.length > 0,
    total_rp: totalRp,
    credits,
    resolved,
    eligible_count: eligible.length,
  };
}

async function fetchPartidoForRanking(supabaseAdmin, partidoId) {
  const { data, error } = await supabaseAdmin
    .from('partidos_abiertos')
    .select('id, estado, ganador, resultado, deporte, capitan_user_id, equipos_asignacion, reserva_id')
    .eq('id', Number(partidoId))
    .maybeSingle();

  if (error) throw error;
  return data ?? null;
}

async function resolveCapitanesForRanking(supabaseAdmin, partido) {
  if (!partido?.id) return null;

  const { data: jugadores, error } = await supabaseAdmin
    .from('partidos_abiertos_jugadores')
    .select('user_id, joined_at')
    .eq('partido_id', partido.id)
    .order('joined_at', { ascending: true });

  if (error) throw error;

  const capitan1 = partido.capitan_user_id ?? null;
  let capitan2 = null;

  if (isEquiposAsignacionValida(partido.equipos_asignacion)) {
    const equipo2Ids = normalizeEquipoUserIds(partido.equipos_asignacion.equipo2);
    capitan2 = equipo2Ids[0] ?? null;
  } else if ((jugadores ?? []).length >= 2) {
    capitan2 = jugadores.find((j) => j.user_id && j.user_id !== capitan1)?.user_id ?? null;
  }

  return { capitan1, capitan2 };
}

/**
 * Ranking tras confirmación manual de resultado casual.
 */
export async function processCasualMatchRankingAfterResultConfirmed(supabaseAdmin, partidoId, {
  partido: partidoRow = null,
  reservaId = null,
} = {}) {
  const partido = partidoRow ?? await fetchPartidoForRanking(supabaseAdmin, partidoId);
  if (!partido) {
    return { ok: false, reason: 'partido_no_encontrado' };
  }

  if (partido.estado !== 'finalizado') {
    return { ok: true, acreditado: false, reason: 'partido_no_finalizado' };
  }

  const capitanes = await resolveCapitanesForRanking(supabaseAdmin, partido);

  return creditCasualMatchRanking(supabaseAdmin, {
    matchId: partidoId,
    partido,
    reservaId: reservaId ?? partido.reserva_id ?? null,
    capitanes,
  });
}

/**
 * Ranking tras Smart Score casual terminado (después de PadCoins).
 */
export async function processCasualMatchRankingAfterScoreboardFinished(supabaseAdmin, {
  scoreboard = {},
  partidoId = null,
  reservaId = null,
  scorePayload = null,
} = {}) {
  if (scoreboard?.partido_torneo_id != null) {
    return { ok: true, acreditado: false, skipped: true, reason: 'torneo_out_of_scope' };
  }

  const normalizedPartidoId = partidoId ?? scoreboard.partido_abierto_id ?? null;
  if (!normalizedPartidoId) {
    return { ok: true, acreditado: false, reason: 'sin_partido_casual' };
  }

  const partido = await fetchPartidoForRanking(supabaseAdmin, normalizedPartidoId);

  return creditCasualMatchRanking(supabaseAdmin, {
    matchId: normalizedPartidoId,
    partido,
    scoreboard,
    scorePayload: scorePayload ?? buildScoreboardResultPayloadFromRow(scoreboard),
    reservaId: reservaId ?? scoreboard.reserva_id ?? partido?.reserva_id ?? null,
  });
}
