import {
  acreditarPadcoinsPorReservaCompletada,
  computePadcoinsAmountForReserva,
  isReservaCancelada,
  isReservaEstadoAcreditable,
  isReservaNoShow,
  yaFueAcreditadaReserva,
} from '../padcoins/padcoinsReservasService.js';
import { isPadcoinsActiveForSede } from '../padcoins/padcoinsSedeConfigService.js';
import { getPadcoinsReservationConfigForSede } from '../padcoins/padcoinsEffectiveConfigService.js';
import {
  applyCampaignToPadcoinsEarn,
  resolveActiveCampaignForReserva,
} from '../padcoins/padcoinsCampaignResolverService.js';
import { addPadcoins } from '../padcoins/padcoinsService.js';
import { PADCOINS_MOVEMENT_TYPES, PADCOINS_ORIGINS } from '../padcoins/padcoinsConfig.js';
import { PADCOINS_SOURCE_ACTIONS } from '../padcoins/padcoinsIdempotencyService.js';
import {
  processCasualMatchRankingAfterResultConfirmed,
} from '../ranking/casualMatchRankingService.js';
import { maybeDeferCasualRewardsForAttendance } from './matchAttendanceService.js';
import {
  ensureOrganizerParticipantFromReserva,
  listMatchParticipants,
  markAttendance,
  resolveEligibleParticipantsForRewards,
  syncParticipantsFromPartidoJugadores,
} from './matchParticipantsService.js';
import {
  MATCH_ATTENDANCE_STATUS,
  MATCH_PARTICIPANT_ROLES,
  MATCH_REWARD_EVENT_STATUS,
  MATCH_REWARD_STATUS,
  MATCH_REWARD_TYPES,
  MATCH_TYPES,
  RESERVATION_REWARD_MODES,
  isValidUserId,
  normalizeMatchId,
} from './matchParticipantsConstants.js';

/** Porcentaje del pool reservado como bonus al organizador cuando hay otros jugadores validados. */
export const MATCH_REWARDS_ORGANIZER_BONUS_PERCENT = 10;

const MATCH_PADCOINS_REFERENCIA_TIPO = 'match_casual';

function resolvePadcoinsMovimientoLink(movimientoId) {
  if (movimientoId == null || String(movimientoId).trim() === '') {
    return { padcoins_movimiento_id: null, movimiento_id: null };
  }
  const idStr = String(movimientoId).trim();
  const asNumber = Number(idStr);
  if (Number.isInteger(asNumber) && asNumber > 0 && String(asNumber) === idStr) {
    return { padcoins_movimiento_id: asNumber, movimiento_id: idStr };
  }
  // padcoins_movimientos.id es UUID en producción; la columna BIGINT queda null y el link va en metadata.
  return { padcoins_movimiento_id: null, movimiento_id: idStr };
}

function isMissingTable(error) {
  const message = String(error?.message ?? '').toLowerCase();
  return (
    error?.code === '42P01'
    || error?.code === 'PGRST205'
    || message.includes('does not exist')
    || message.includes('could not find the table')
  );
}

function isDuplicateRewardEventError(error) {
  return error?.code === '23505'
    && String(error?.message ?? '').toLowerCase().includes('match_reward_events');
}

export function buildReservationOrganizerSourceKey(reservaId) {
  return `user|reservation|${String(reservaId).trim()}|organizer`;
}

export function buildMatchParticipantPadcoinsSourceKey(matchType, matchId, userId) {
  return `user|match|${matchType}|${matchId}|padcoins|participant|${userId}`;
}

export function buildMatchOrganizerBonusSourceKey(matchType, matchId, userId) {
  return `user|match|${matchType}|${matchId}|padcoins|organizer_bonus|${userId}`;
}

/** Idempotencia PadCoins inmediatos al confirmar asistencia (Fase 3.7). */
export function buildAttendanceParticipantPadcoinsSourceKey(matchId, userId) {
  const mid = normalizeMatchId(matchId);
  const uid = String(userId ?? '').trim();
  return `attendance|match|${mid}|user|${uid}|padcoins`;
}

/**
 * Participantes que aún pueden recibir PadCoins para calcular shares al confirmar.
 * Excluye denied/excluded; incluye pending para reparto estable mientras la ventana está open.
 */
export function getParticipantsForPadcoinsShareProjection(participants = []) {
  return (participants ?? []).filter((participant) => {
    if (!isValidUserId(participant?.user_id)) {
      return false;
    }
    const status = String(participant?.attendance_status ?? '').trim();
    return status === MATCH_ATTENDANCE_STATUS.PENDING
      || status === MATCH_ATTENDANCE_STATUS.CONFIRMED
      || status === MATCH_ATTENDANCE_STATUS.ADMIN_VALIDATED;
  });
}

export function buildMatchPadcoinsReferenciaId(matchId, userId, kind = 'participant') {
  return `${matchId}:${kind}:${userId}`;
}

/**
 * Reserva sin partido → acreditar organizador (compat legacy).
 * Reserva con partido vinculado → diferir hasta validación de resultado.
 */
export function evaluateReservationRewardMode(reserva, partido = null) {
  const linkedPartidoId = partido?.id ?? reserva?.partido_id ?? null;
  if (linkedPartidoId != null && String(linkedPartidoId).trim() !== '') {
    return RESERVATION_REWARD_MODES.MATCH_DEFERRED;
  }
  return RESERVATION_REWARD_MODES.ORGANIZER_ONLY;
}

export async function preventDuplicateRewardBySourceKey(supabaseAdmin, sourceKey) {
  const key = String(sourceKey ?? '').trim();
  if (!key) {
    return { duplicate: false, event: null };
  }

  const { data, error } = await supabaseAdmin
    .from('match_reward_events')
    .select('*')
    .eq('source_key', key)
    .maybeSingle();

  if (error) {
    if (isMissingTable(error)) {
      return { duplicate: false, event: null, table_missing: true };
    }
    throw error;
  }

  return { duplicate: Boolean(data?.id), event: data ?? null };
}

export async function createMatchRewardEvent(supabaseAdmin, payload = {}) {
  const sourceKey = String(payload.source_key ?? '').trim();
  if (!sourceKey || !isValidUserId(payload.user_id)) {
    return { ok: false, reason: 'invalid_payload' };
  }

  const duplicateCheck = await preventDuplicateRewardBySourceKey(supabaseAdmin, sourceKey);
  if (duplicateCheck.duplicate) {
    return {
      ok: true,
      created: false,
      duplicate: true,
      event: duplicateCheck.event,
    };
  }

  const row = {
    match_type: payload.match_type ?? MATCH_TYPES.CASUAL,
    match_id: String(payload.match_id ?? '').trim(),
    user_id: payload.user_id,
    reward_type: payload.reward_type ?? MATCH_REWARD_TYPES.PADCOINS,
    amount: Number(payload.amount ?? 0),
    status: payload.status ?? MATCH_REWARD_EVENT_STATUS.PENDING,
    source_key: sourceKey,
    metadata: payload.metadata && typeof payload.metadata === 'object'
      ? payload.metadata
      : {},
  };

  if (payload.reserva_id != null) row.reserva_id = Number(payload.reserva_id);
  const movLink = resolvePadcoinsMovimientoLink(payload.padcoins_movimiento_id);
  if (movLink.padcoins_movimiento_id != null) {
    row.padcoins_movimiento_id = movLink.padcoins_movimiento_id;
  }
  if (movLink.movimiento_id) {
    row.metadata = { ...row.metadata, movimiento_id: movLink.movimiento_id };
  }

  const { data, error } = await supabaseAdmin
    .from('match_reward_events')
    .insert(row)
    .select('*')
    .single();

  if (error) {
    if (isDuplicateRewardEventError(error)) {
      const retry = await preventDuplicateRewardBySourceKey(supabaseAdmin, sourceKey);
      return {
        ok: true,
        created: false,
        duplicate: true,
        event: retry.event,
      };
    }
    if (isMissingTable(error)) {
      return { ok: false, reason: 'table_missing', skipped: true };
    }
    throw error;
  }

  return { ok: true, created: true, duplicate: false, event: data };
}

async function updateMatchRewardEventStatus(supabaseAdmin, eventId, {
  status,
  padcoinsMovimientoId = null,
  metadata = null,
} = {}) {
  if (!eventId) return;

  const updatePayload = {
    status,
    updated_at: new Date().toISOString(),
  };
  if (padcoinsMovimientoId != null) {
    const movLink = resolvePadcoinsMovimientoLink(padcoinsMovimientoId);
    if (movLink.padcoins_movimiento_id != null) {
      updatePayload.padcoins_movimiento_id = movLink.padcoins_movimiento_id;
    }
    if (movLink.movimiento_id) {
      updatePayload.metadata = {
        ...(metadata && typeof metadata === 'object' ? metadata : {}),
        movimiento_id: movLink.movimiento_id,
      };
    }
  } else if (metadata && typeof metadata === 'object') {
    updatePayload.metadata = metadata;
  }

  await supabaseAdmin
    .from('match_reward_events')
    .update(updatePayload)
    .eq('id', eventId)
    .then(({ error }) => {
      if (error && !isMissingTable(error)) throw error;
    });
}

async function computePadcoinsPoolForReserva(supabaseAdmin, reserva, options = {}) {
  const sedeId = Number.parseInt(String(reserva?.sede_id ?? ''), 10);
  if (!Number.isFinite(sedeId) || sedeId <= 0) {
    return { ok: false, reason: 'sede_id_invalido' };
  }

  const reservationConfig = options.reservationConfig
    ?? await getPadcoinsReservationConfigForSede(supabaseAdmin, sedeId);

  const amountResult = computePadcoinsAmountForReserva(reserva, {
    configMap: {
      reserva_confirmada: reservationConfig.reserva_confirmada_fallback,
      porcentaje_devolucion_reserva: reservationConfig.porcentaje_devolucion_reserva,
      padcoins_por_usd_equivalente: reservationConfig.padcoins_por_usd_equivalente,
    },
    configTextMap: {
      modo_calculo_reserva: reservationConfig.modo_calculo_reserva,
    },
    fallbackFixed: reservationConfig.reserva_confirmada_fallback,
  });

  const padcoinsBase = Number(amountResult.padcoins);
  if (!Number.isInteger(padcoinsBase) || padcoinsBase <= 0) {
    return { ok: true, padcoins: 0, reason: 'monto_cero', amountResult };
  }

  const activeCampaign = options.campaign ?? await resolveActiveCampaignForReserva(supabaseAdmin, {
    sedeId,
    userId: reserva.user_id,
    reservaId: String(reserva.id),
    now: options.now,
  });

  const campaignResult = await applyCampaignToPadcoinsEarn(supabaseAdmin, {
    basePadcoins: padcoinsBase,
    baseAmountResult: amountResult,
    campaign: activeCampaign,
    reserva,
    reservationConfig,
  });

  return {
    ok: true,
    padcoins: campaignResult.final_padcoins,
    padcoins_base: campaignResult.base_padcoins,
    amountResult,
    campaignResult,
    sedeId,
    reservationConfig,
  };
}

/**
 * Mantiene acreditación legacy al organizador cuando no hay partido vinculado.
 */
export async function creditOrganizerOnlyReservationReward(supabaseAdmin, reservaId, options = {}) {
  const result = await acreditarPadcoinsPorReservaCompletada(supabaseAdmin, reservaId, options);

  if (result.acreditado) {
    await createMatchRewardEvent(supabaseAdmin, {
      match_type: MATCH_TYPES.CASUAL,
      match_id: `reserva:${reservaId}`,
      reserva_id: reservaId,
      user_id: result.movimiento?.user_id ?? options.reserva?.user_id,
      reward_type: MATCH_REWARD_TYPES.PADCOINS,
      amount: result.padcoins ?? 0,
      status: MATCH_REWARD_EVENT_STATUS.CREDITED,
      source_key: buildReservationOrganizerSourceKey(reservaId),
      padcoins_movimiento_id: result.movimiento?.id ?? null,
      metadata: {
        mode: RESERVATION_REWARD_MODES.ORGANIZER_ONLY,
        method: result.method ?? null,
      },
    }).catch(() => null);
  }

  return {
    ...result,
    mode: RESERVATION_REWARD_MODES.ORGANIZER_ONLY,
  };
}

export function splitMatchPadcoinsPool(totalPadcoins, eligibleParticipants, organizerUserId) {
  const total = Number(totalPadcoins);
  if (!Number.isInteger(total) || total <= 0) {
    return [];
  }

  const eligible = (eligibleParticipants ?? []).filter((p) => isValidUserId(p?.user_id));
  if (!eligible.length) {
    return [];
  }

  const nonOrganizer = eligible.filter(
    (p) => p.role !== MATCH_PARTICIPANT_ROLES.ORGANIZER
      && String(p.user_id) !== String(organizerUserId ?? ''),
  );

  if (nonOrganizer.length === 0) {
    const organizer = eligible.find(
      (p) => p.role === MATCH_PARTICIPANT_ROLES.ORGANIZER
        || String(p.user_id) === String(organizerUserId ?? ''),
    ) ?? eligible[0];

    return [{
      userId: organizer.user_id,
      amount: total,
      kind: 'organizer_only',
      sourceKey: null,
    }];
  }

  const bonusPct = MATCH_REWARDS_ORGANIZER_BONUS_PERCENT;
  const organizerBonus = Math.max(0, Math.floor((total * bonusPct) / 100));
  const participantPool = total - organizerBonus;
  const perHead = Math.floor(participantPool / eligible.length);
  let remainder = participantPool - (perHead * eligible.length);

  const shares = eligible.map((participant) => {
    const extra = remainder > 0 ? 1 : 0;
    if (remainder > 0) remainder -= 1;
    return {
      userId: participant.user_id,
      amount: perHead + extra,
      kind: 'participant',
      participant,
    };
  });

  const organizerShare = shares.find(
    (share) => String(share.userId) === String(organizerUserId ?? ''),
  );

  if (organizerBonus > 0) {
    if (organizerShare) {
      organizerShare.amount += organizerBonus;
      organizerShare.kind = 'participant_with_organizer_bonus';
      organizerShare.bonusAmount = organizerBonus;
    } else if (isValidUserId(organizerUserId)) {
      shares.push({
        userId: organizerUserId,
        amount: organizerBonus,
        kind: 'organizer_bonus',
        bonusAmount: organizerBonus,
      });
    }
  }

  return shares.filter((share) => share.amount > 0);
}

async function creditSingleMatchPadcoinsShare(supabaseAdmin, {
  share,
  matchType,
  matchId,
  reservaId,
  reserva,
  sedeId,
  poolMeta,
  sourceKeyOverride = null,
} = {}) {
  const userId = share.userId;
  const amount = share.amount;

  const isOrganizerBonus = share.kind === 'organizer_bonus'
    || (share.bonusAmount > 0 && share.kind === 'participant_with_organizer_bonus');

  const participantSourceKey = buildMatchParticipantPadcoinsSourceKey(matchType, matchId, userId);
  const bonusSourceKey = buildMatchOrganizerBonusSourceKey(matchType, matchId, userId);

  let sourceKey = sourceKeyOverride ?? participantSourceKey;
  let referenciaKind = 'participant';

  if (!sourceKeyOverride && share.kind === 'organizer_only') {
    sourceKey = buildReservationOrganizerSourceKey(reservaId);
    referenciaKind = 'organizer';
  } else if (!sourceKeyOverride && isOrganizerBonus && share.kind === 'organizer_bonus') {
    sourceKey = bonusSourceKey;
    referenciaKind = 'organizer_bonus';
  }

  const duplicateCheck = await preventDuplicateRewardBySourceKey(supabaseAdmin, sourceKey);
  if (duplicateCheck.duplicate && duplicateCheck.event?.status === MATCH_REWARD_EVENT_STATUS.CREDITED) {
    return {
      acreditado: false,
      reason: 'ya_acreditado_event',
      userId,
      sourceKey,
      event: duplicateCheck.event,
    };
  }

  const pendingEvent = duplicateCheck.event ?? (await createMatchRewardEvent(supabaseAdmin, {
    match_type: matchType,
    match_id: matchId,
    reserva_id: reservaId,
    user_id: userId,
    reward_type: MATCH_REWARD_TYPES.PADCOINS,
    amount,
    status: MATCH_REWARD_EVENT_STATUS.PENDING,
    source_key: sourceKey,
    metadata: {
      kind: share.kind,
      pool: poolMeta,
    },
  })).event;

  const descripcion = share.kind === 'organizer_only'
    ? `PadCoins por reserva completada (partido validado, solo organizador) #${matchId}`
    : `PadCoins por partido casual validado #${matchId}`;

  const padcoinsResult = await addPadcoins(supabaseAdmin, userId, amount, {
    tipo: PADCOINS_MOVEMENT_TYPES.EARN,
    referencia_tipo: share.kind === 'organizer_only'
      ? 'reserva'
      : MATCH_PADCOINS_REFERENCIA_TIPO,
    referencia_id: share.kind === 'organizer_only'
      ? String(reservaId)
      : buildMatchPadcoinsReferenciaId(matchId, userId, referenciaKind),
    sede_id: sedeId,
    descripcion,
    enforceIdempotency: true,
    action: PADCOINS_SOURCE_ACTIONS.EARN,
    metadata: {
      source_key: sourceKey,
      source_type: share.kind === 'organizer_only'
        ? PADCOINS_ORIGINS.RESERVA_COMPLETADA
        : PADCOINS_ORIGINS.PARTIDO_JUGADO,
      source_id: matchId,
      match_type: matchType,
      reserva_id: String(reservaId),
      reward_kind: share.kind,
    },
    skipEarnCaps: false,
  });

  if (padcoinsResult.skipped) {
    await updateMatchRewardEventStatus(supabaseAdmin, pendingEvent?.id, {
      status: MATCH_REWARD_EVENT_STATUS.SKIPPED,
      metadata: { reason: padcoinsResult.reason ?? 'skipped' },
    });

    return {
      acreditado: false,
      reason: padcoinsResult.reason ?? 'skipped',
      userId,
      sourceKey,
      padcoinsResult,
    };
  }

  await updateMatchRewardEventStatus(supabaseAdmin, pendingEvent?.id, {
    status: MATCH_REWARD_EVENT_STATUS.CREDITED,
    padcoinsMovimientoId: padcoinsResult.movimiento?.id ?? null,
    metadata: {
      kind: share.kind,
      pool: poolMeta,
      movimiento_id: padcoinsResult.movimiento?.id ?? null,
    },
  });

  await markAttendance(supabaseAdmin, {
    matchType,
    matchId,
    userId,
    rewardStatus: MATCH_REWARD_STATUS.CREDITED,
  }).catch(() => null);

  return {
    acreditado: true,
    userId,
    padcoins: padcoinsResult.monto_aplicado ?? amount,
    sourceKey,
    movimiento: padcoinsResult.movimiento ?? null,
    reserva,
  };
}

/**
 * Acredita PadCoins de un participante al confirmar asistencia (inmediato, idempotente).
 * No procesa Ranking.
 */
export async function creditIndividualAttendancePadcoins(supabaseAdmin, {
  matchType = MATCH_TYPES.CASUAL,
  matchId,
  userId,
  reserva,
  organizerUserId = null,
  participants = null,
  reservationConfig = null,
  campaign = null,
  now = undefined,
} = {}) {
  const normalizedMatchId = normalizeMatchId(matchId);
  const normalizedUserId = String(userId ?? '').trim();

  if (!normalizedMatchId || !isValidUserId(normalizedUserId)) {
    return {
      ok: false,
      processed: true,
      acreditado: false,
      reason: 'invalid_payload',
      padcoins: 0,
      amount: 0,
    };
  }

  const sourceKey = buildAttendanceParticipantPadcoinsSourceKey(normalizedMatchId, normalizedUserId);
  const duplicateCheck = await preventDuplicateRewardBySourceKey(supabaseAdmin, sourceKey);
  if (duplicateCheck.duplicate && duplicateCheck.event?.status === MATCH_REWARD_EVENT_STATUS.CREDITED) {
    return {
      ok: true,
      processed: true,
      acreditado: false,
      reason: 'ya_acreditado_event',
      padcoins: Number(duplicateCheck.event?.amount ?? 0),
      amount: Number(duplicateCheck.event?.amount ?? 0),
      sourceKey,
      event: duplicateCheck.event,
    };
  }

  const reservaId = reserva?.id;
  if (!reservaId || !isValidUserId(reserva?.user_id)) {
    return {
      ok: false,
      processed: true,
      acreditado: false,
      reason: 'invalid_match_or_reserva',
      padcoins: 0,
      amount: 0,
    };
  }

  if (isReservaCancelada(reserva) || isReservaNoShow(reserva)) {
    return {
      ok: true,
      processed: true,
      acreditado: false,
      reason: 'reserva_no_acreditable',
      padcoins: 0,
      amount: 0,
    };
  }

  if (!isReservaEstadoAcreditable(reserva.estado) && reserva.estado !== 'confirmada') {
    return {
      ok: true,
      processed: true,
      acreditado: false,
      reason: 'estado_no_acreditable',
      estado: reserva.estado,
      padcoins: 0,
      amount: 0,
    };
  }

  const sedeId = Number.parseInt(String(reserva.sede_id ?? ''), 10);
  if (!Number.isFinite(sedeId) || sedeId <= 0) {
    return {
      ok: false,
      processed: true,
      acreditado: false,
      reason: 'sede_id_invalido',
      padcoins: 0,
      amount: 0,
    };
  }

  const sedeActiva = await isPadcoinsActiveForSede(supabaseAdmin, sedeId);
  if (!sedeActiva) {
    return {
      ok: true,
      processed: true,
      acreditado: false,
      reason: 'sede_no_participa',
      sede_id: sedeId,
      padcoins: 0,
      amount: 0,
    };
  }

  if (await yaFueAcreditadaReserva(supabaseAdmin, reservaId)) {
    return {
      ok: true,
      processed: true,
      acreditado: false,
      reason: 'reserva_ya_acreditada_legacy',
      reserva_id: reservaId,
      padcoins: 0,
      amount: 0,
    };
  }

  const allParticipants = participants ?? await listMatchParticipants(supabaseAdmin, {
    matchType,
    matchId: normalizedMatchId,
  });

  const participantRow = (allParticipants ?? []).find(
    (row) => String(row.user_id) === normalizedUserId,
  );
  const participantStatus = String(participantRow?.attendance_status ?? '').trim();
  if (
    participantStatus !== MATCH_ATTENDANCE_STATUS.CONFIRMED
    && participantStatus !== MATCH_ATTENDANCE_STATUS.ADMIN_VALIDATED
  ) {
    return {
      ok: true,
      processed: true,
      acreditado: false,
      reason: 'not_eligible',
      padcoins: 0,
      amount: 0,
    };
  }

  const projection = getParticipantsForPadcoinsShareProjection(allParticipants);
  if (!projection.some((row) => String(row.user_id) === normalizedUserId)) {
    return {
      ok: true,
      processed: true,
      acreditado: false,
      reason: 'not_in_projection',
      padcoins: 0,
      amount: 0,
    };
  }

  const pool = await computePadcoinsPoolForReserva(supabaseAdmin, reserva, {
    reservationConfig,
    campaign,
    now,
  });
  if (!pool.ok || !pool.padcoins) {
    return {
      ok: true,
      processed: true,
      acreditado: false,
      reason: pool.reason ?? 'monto_cero',
      padcoins: 0,
      amount: 0,
      pool,
    };
  }

  const organizerId = organizerUserId ?? reserva.user_id;
  const shares = splitMatchPadcoinsPool(pool.padcoins, projection, organizerId);
  const share = shares.find((row) => String(row.userId) === normalizedUserId);
  if (!share || share.amount <= 0) {
    return {
      ok: true,
      processed: true,
      acreditado: false,
      reason: 'sin_share',
      padcoins: 0,
      amount: 0,
    };
  }

  const poolMeta = {
    total: pool.padcoins,
    method: pool.amountResult?.method ?? null,
    eligible_count: projection.length,
    individual_attendance: true,
  };

  const creditResult = await creditSingleMatchPadcoinsShare(supabaseAdmin, {
    share,
    matchType,
    matchId: normalizedMatchId,
    reservaId,
    reserva,
    sedeId,
    poolMeta,
    sourceKeyOverride: sourceKey,
  });

  const amount = creditResult.acreditado === true
    ? (creditResult.padcoins ?? share.amount)
    : 0;

  return {
    ok: true,
    processed: true,
    acreditado: creditResult.acreditado === true,
    reason: creditResult.reason ?? (creditResult.acreditado ? 'credited' : 'not_credited'),
    padcoins: amount,
    amount,
    sourceKey,
    movimiento: creditResult.movimiento ?? null,
    event: creditResult.event ?? null,
  };
}

/**
 * Acredita PadCoins tras validación de partido (confirmación dual Fase 1).
 * No escribe ranking casual.
 */
export async function creditValidatedMatchPadcoins(supabaseAdmin, {
  matchType = MATCH_TYPES.CASUAL,
  matchId,
  reserva,
  organizerUserId = null,
  reservationConfig = null,
  campaign = null,
  now = undefined,
} = {}) {
  const normalizedMatchId = normalizeMatchId(matchId);
  const reservaId = reserva?.id;

  if (!normalizedMatchId || !reservaId || !isValidUserId(reserva?.user_id)) {
    return { ok: false, reason: 'invalid_match_or_reserva' };
  }

  if (isReservaCancelada(reserva) || isReservaNoShow(reserva)) {
    return { ok: true, acreditado: false, reason: 'reserva_no_acreditable' };
  }

  if (!isReservaEstadoAcreditable(reserva.estado) && reserva.estado !== 'confirmada') {
    return { ok: true, acreditado: false, reason: 'estado_no_acreditable', estado: reserva.estado };
  }

  const sedeId = Number.parseInt(String(reserva.sede_id ?? ''), 10);
  if (!Number.isFinite(sedeId) || sedeId <= 0) {
    return { ok: false, reason: 'sede_id_invalido' };
  }

  const sedeActiva = await isPadcoinsActiveForSede(supabaseAdmin, sedeId);
  if (!sedeActiva) {
    return { ok: true, acreditado: false, reason: 'sede_no_participa', sede_id: sedeId };
  }

  if (await yaFueAcreditadaReserva(supabaseAdmin, reservaId)) {
    return {
      ok: true,
      acreditado: false,
      reason: 'reserva_ya_acreditada_legacy',
      reserva_id: reservaId,
    };
  }

  const participants = await listMatchParticipants(supabaseAdmin, {
    matchType,
    matchId: normalizedMatchId,
  });

  const eligible = resolveEligibleParticipantsForRewards(participants);
  if (!eligible.length) {
    return { ok: true, acreditado: false, reason: 'sin_participantes_elegibles' };
  }

  const pool = await computePadcoinsPoolForReserva(supabaseAdmin, reserva, {
    reservationConfig,
    campaign,
    now,
  });
  if (!pool.ok || !pool.padcoins) {
    return { ok: true, acreditado: false, reason: pool.reason ?? 'monto_cero', pool };
  }

  const organizerId = organizerUserId ?? reserva.user_id;
  const shares = splitMatchPadcoinsPool(pool.padcoins, eligible, organizerId);
  if (!shares.length) {
    return { ok: true, acreditado: false, reason: 'sin_shares' };
  }

  const poolMeta = {
    total: pool.padcoins,
    method: pool.amountResult?.method ?? null,
    eligible_count: eligible.length,
  };

  const credits = [];
  for (const share of shares) {
    const attendanceSourceKey = buildAttendanceParticipantPadcoinsSourceKey(
      normalizedMatchId,
      share.userId,
    );
    const attendanceDup = await preventDuplicateRewardBySourceKey(supabaseAdmin, attendanceSourceKey);
    if (attendanceDup.duplicate && attendanceDup.event?.status === MATCH_REWARD_EVENT_STATUS.CREDITED) {
      credits.push({
        acreditado: false,
        reason: 'ya_acreditado_event',
        userId: share.userId,
        sourceKey: attendanceSourceKey,
        event: attendanceDup.event,
      });
      continue;
    }

    const creditResult = await creditSingleMatchPadcoinsShare(supabaseAdmin, {
      share,
      matchType,
      matchId: normalizedMatchId,
      reservaId,
      reserva,
      sedeId,
      poolMeta,
    });
    credits.push(creditResult);
  }

  const acreditados = credits.filter((c) => c.acreditado);
  return {
    ok: true,
    acreditado: acreditados.length > 0,
    total_padcoins: acreditados.reduce((sum, c) => sum + (c.padcoins ?? 0), 0),
    credits,
    pool: poolMeta,
    eligible_count: eligible.length,
  };
}

/**
 * Punto de entrada del cron: compat legacy vs partido vinculado.
 */
export async function processReservationPadcoinsOnComplete(supabaseAdmin, reserva, partido = null) {
  const mode = evaluateReservationRewardMode(reserva, partido);

  if (mode === RESERVATION_REWARD_MODES.MATCH_DEFERRED) {
    const organizerResult = await ensureOrganizerParticipantFromReserva(supabaseAdmin, {
      reserva,
      partido,
    });

    return {
      ok: true,
      mode,
      acreditado: false,
      reason: 'match_linked_padcoins_deferred',
      organizer_participant: organizerResult,
    };
  }

  return creditOrganizerOnlyReservationReward(supabaseAdmin, reserva.id, { reserva });
}

async function resolveReservaForPartido(supabaseAdmin, partido) {
  if (partido?.reserva_id != null) {
    const reserva = await fetchReservaForPadcoins(supabaseAdmin, partido.reserva_id);
    if (reserva) return reserva;
  }

  const { data, error } = await supabaseAdmin
    .from('reservas')
    .select('id, user_id, sede_id, sede, estado, fecha, hora, hora_fin, hora_inicio, partido_id, precio, precio_esperado, monto_pagado, moneda, pago_estado')
    .eq('partido_id', partido.id)
    .maybeSingle();

  if (error) throw error;
  return data ?? null;
}

async function fetchReservaForPadcoins(supabaseAdmin, reservaId) {
  const { data, error } = await supabaseAdmin
    .from('reservas')
    .select('id, user_id, sede_id, sede, estado, fecha, hora, hora_fin, hora_inicio, partido_id, precio, precio_esperado, monto_pagado, moneda, pago_estado')
    .eq('id', reservaId)
    .maybeSingle();

  if (error) throw error;
  return data ?? null;
}

/**
 * Tras confirmación dual de resultado casual: sync participantes + PadCoins idempotente.
 */
export async function processCasualMatchPadcoinsAfterResultConfirmed(supabaseAdmin, partidoId) {
  const normalizedPartidoId = normalizeMatchId(partidoId);
  if (!normalizedPartidoId) {
    return { ok: false, reason: 'invalid_partido_id' };
  }

  const { data: partido, error: partidoErr } = await supabaseAdmin
    .from('partidos_abiertos')
    .select('id, capitan_user_id, reserva_id, estado, ganador, resultado, deporte, equipos_asignacion, attendance_collection_status, attendance_opened_at, attendance_deadline_at, sede_id')
    .eq('id', Number(partidoId))
    .maybeSingle();

  if (partidoErr) throw partidoErr;
  if (!partido) {
    return { ok: false, reason: 'partido_no_encontrado' };
  }

  const reserva = await resolveReservaForPartido(supabaseAdmin, partido);
  if (!reserva?.id) {
    return { ok: true, acreditado: false, reason: 'sin_reserva_vinculada' };
  }

  const attendanceDefer = await maybeDeferCasualRewardsForAttendance(supabaseAdmin, partidoId, {
    partido,
    source: 'manual',
    reservaId: reserva.id,
  }).catch((err) => {
    console.error(`[Attendance Fase 3.1] error partido=${partidoId}:`, err.message);
    return {
      deferred: true,
      attendance_pending: false,
      reason: 'attendance_window_error',
      error: err.message,
    };
  });

  if (attendanceDefer.deferred) {
    console.log(
      `[Attendance Fase 3.1] partido=${partidoId} rewards deferred reason=${attendanceDefer.reason}`,
    );
    return {
      ok: true,
      acreditado: false,
      attendance_pending: attendanceDefer.attendance_pending === true,
      reason: attendanceDefer.reason ?? 'attendance_pending',
      attendance: attendanceDefer.attendance ?? null,
    };
  }

  await ensureOrganizerParticipantFromReserva(supabaseAdmin, {
    reserva,
    partido,
  });

  await syncParticipantsFromPartidoJugadores(supabaseAdmin, {
    partidoId: partido.id,
    reservaId: reserva.id,
    capitanUserId: partido.capitan_user_id,
    markValidated: true,
  });

  if (isValidUserId(partido.capitan_user_id)) {
    await markAttendance(supabaseAdmin, {
      matchId: normalizedPartidoId,
      userId: partido.capitan_user_id,
      attendanceStatus: MATCH_ATTENDANCE_STATUS.ADMIN_VALIDATED,
      rewardStatus: MATCH_REWARD_STATUS.ELIGIBLE,
    });
  }

  if (isValidUserId(reserva.user_id)) {
    await markAttendance(supabaseAdmin, {
      matchId: normalizedPartidoId,
      userId: reserva.user_id,
      attendanceStatus: MATCH_ATTENDANCE_STATUS.ADMIN_VALIDATED,
      rewardStatus: MATCH_REWARD_STATUS.ELIGIBLE,
    });
  }

  const padcoinsResult = await creditValidatedMatchPadcoins(supabaseAdmin, {
    matchId: normalizedPartidoId,
    reserva,
    organizerUserId: reserva.user_id,
  });

  await processCasualMatchRankingAfterResultConfirmed(supabaseAdmin, partidoId, {
    partido,
    reservaId: reserva.id,
  }).catch((err) => {
    console.warn(`⚠️ Ranking casual partido ${partidoId}:`, err.message);
  });

  return padcoinsResult;
}
