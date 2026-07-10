import {
  createMatchRewardEvent,
  preventDuplicateRewardBySourceKey,
} from '../matches/matchRewardsService.js';
import {
  listMatchParticipants,
  resolveEligibleParticipantsForRewards,
} from '../matches/matchParticipantsService.js';
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

/** Ranking points (RP) — Fase 1 casual. */
export const CASUAL_RANKING_RP = Object.freeze({
  WIN: 3,
  LOSS: 1,
  DRAW: 2,
});

export const CASUAL_RANKING_DEFAULT_NIVEL = 'club';
export const CASUAL_RANKING_DEFAULT_DEPORTE = 'padbol';

const MANUAL_WINNER_SIDES = new Set(['equipo1', 'equipo2']);
const SCOREBOARD_WINNER_SIDES = new Set(['A', 'B']);

function isMissingRankingsLeaderboardTable(error) {
  const message = String(error?.message ?? '').toLowerCase();
  return (
    error?.code === '42P01'
    || error?.code === 'PGRST205'
    || message.includes('rankings_leaderboard')
    || message.includes('does not exist')
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

function hasManualResult(partido = {}) {
  const ganador = normalizeManualGanador(partido.ganador);
  if (!ganador) return false;

  const resultado = partido.resultado;
  if (resultado && typeof resultado === 'object') {
    if (Number.isFinite(Number(resultado.equipo1_sets)) && Number.isFinite(Number(resultado.equipo2_sets))) {
      return true;
    }
    if (Number.isFinite(Number(resultado.equipo1)) && Number.isFinite(Number(resultado.equipo2))) {
      return Number(resultado.equipo1) !== Number(resultado.equipo2);
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

  if (payload?.ganador) {
    const ganador = normalizeScoreboardGanador(payload.ganador);
    if (!ganador) {
      return { ok: false, reason: 'ganador_scoreboard_invalido' };
    }
    if (payload.sets_a === payload.sets_b) {
      return { ok: false, reason: 'empate_scoreboard_no_soportado_fase1' };
    }
    return {
      ok: true,
      source: 'scoreboard',
      mode: 'scoreboard',
      ganadorSide: ganador,
      isDraw: false,
      scorePayload: payload,
    };
  }

  if (partido && hasManualResult(partido)) {
    const ganador = normalizeManualGanador(partido.ganador);
    if (!ganador || !MANUAL_WINNER_SIDES.has(ganador)) {
      return { ok: false, reason: 'ganador_manual_invalido' };
    }

    const resultado = partido.resultado ?? {};
    if (
      Number.isFinite(Number(resultado.equipo1))
      && Number.isFinite(Number(resultado.equipo2))
      && Number(resultado.equipo1) === Number(resultado.equipo2)
    ) {
      return {
        ok: true,
        source: 'manual',
        mode: 'manual',
        ganadorSide: null,
        isDraw: true,
        scorePayload: resultado,
      };
    }

    return {
      ok: true,
      source: 'manual',
      mode: 'manual',
      ganadorSide: ganador,
      isDraw: false,
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
  isDraw,
} = {}) {
  if (!participant || !isValidUserId(participant.user_id)) {
    return null;
  }

  if (isDraw) {
    return CASUAL_RANKING_RP.DRAW;
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

  const { data: existing, error: fetchErr } = await supabaseAdmin
    .from('rankings_leaderboard')
    .select('id, puntos')
    .eq('user_id', userId)
    .eq('deporte', normalizedDeporte)
    .eq('nivel', normalizedNivel)
    .maybeSingle();

  if (fetchErr) {
    if (isMissingRankingsLeaderboardTable(fetchErr)) {
      return { ok: false, reason: 'rankings_leaderboard_missing', skipped: true };
    }
    throw fetchErr;
  }

  const nextPuntos = (Number(existing?.puntos) || 0) + rpDelta;
  const now = new Date().toISOString();

  const { data, error } = await supabaseAdmin
    .from('rankings_leaderboard')
    .upsert({
      user_id: userId,
      deporte: normalizedDeporte,
      nivel: normalizedNivel,
      puntos: nextPuntos,
      updated_at: now,
    }, { onConflict: 'user_id,deporte,nivel' })
    .select('id, puntos')
    .single();

  if (error) {
    if (isMissingRankingsLeaderboardTable(error)) {
      return { ok: false, reason: 'rankings_leaderboard_missing', skipped: true };
    }
    throw error;
  }

  return {
    ok: true,
    userId,
    rpDelta,
    puntos: data?.puntos ?? nextPuntos,
    outcome,
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

  if (duplicateCheck.duplicate && duplicateCheck.event?.status === MATCH_REWARD_EVENT_STATUS.CREDITED) {
    return {
      acreditado: false,
      reason: 'ya_acreditado_event',
      userId,
      sourceKey,
      event: duplicateCheck.event,
    };
  }

  const pendingEvent = duplicateCheck.event ?? (await createRankingRewardEvent(supabaseAdmin, {
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
  })).event;

  const rankingUpdate = await updatePlayerRanking(supabaseAdmin, {
    userId,
    deporte,
    nivel,
    rpDelta: rp,
    outcome,
  });

  if (!rankingUpdate.ok) {
    return {
      acreditado: false,
      reason: rankingUpdate.reason ?? 'ranking_update_failed',
      userId,
      sourceKey,
      pendingEvent,
      rankingUpdate,
    };
  }

  if (pendingEvent?.id) {
    await supabaseAdmin
      .from('match_reward_events')
      .update({
        status: MATCH_REWARD_EVENT_STATUS.CREDITED,
        updated_at: new Date().toISOString(),
        metadata: {
          ...(pendingEvent.metadata ?? {}),
          outcome,
          rp,
          puntos_totales: rankingUpdate.puntos,
        },
      })
      .eq('id', pendingEvent.id);
  }

  return {
    acreditado: true,
    userId,
    rp,
    outcome,
    sourceKey,
    puntos: rankingUpdate.puntos,
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
      isDraw: resolved.isDraw,
    });

    if (!Number.isFinite(rp) || rp <= 0) {
      credits.push({
        acreditado: false,
        userId: participant.user_id,
        reason: 'lado_no_determinado',
      });
      continue;
    }

    const outcome = resolved.isDraw
      ? 'draw'
      : (rp === CASUAL_RANKING_RP.WIN ? 'win' : 'loss');

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
    `[Ranking Casual] match=${normalizedMatchId} mode=${resolved.mode} ganador=${resolved.ganadorSide ?? 'draw'} eligible=${eligible.length} credited=${acreditados.length} total_rp=${totalRp}`,
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
