import { resolveAuthRoleForUser } from '../../lib/authAccess.js';
import { formatRankingsDisplayName } from '../../lib/rankingsLeaderboardPublic.js';
import {
  MATCH_ATTENDANCE_AUDIT_ACTIONS,
  appendMatchAttendanceAuditLog,
} from './matchAttendanceAuditService.js';
import {
  ATTENDANCE_DENIAL_REASON_MAX_LENGTH,
  MATCH_ATTENDANCE_COLLECTION_STATUS,
  MATCH_ATTENDANCE_RESOLUTION_REASON,
  MATCH_ATTENDANCE_RESPONSE_SOURCE,
  MATCH_ATTENDANCE_STATUS,
  MATCH_TYPES,
  isValidUserId,
  normalizeMatchId,
} from './matchParticipantsConstants.js';
import {
  PARTICIPANTS_ATTENDANCE_SELECT,
  buildAttendanceRewardsResponse,
  evaluateAttendanceCollectionState,
  getMatchAttendanceState,
  maybeFinalizeRewardsAfterAttendanceEvaluation,
  normalizeAttendanceDenialReason,
  normalizeParticipantAttendanceFields,
  tryFinalizeMatchAttendanceRewards,
} from './matchAttendanceService.js';

const PERFIL_DISPLAY_SELECT = 'user_id, nombre, apodo, username, alias';

function buildHttpError(message, status = 400) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function parsePartidoId(raw) {
  const id = Number.parseInt(String(raw ?? '').trim(), 10);
  return Number.isFinite(id) && id > 0 ? id : null;
}

export async function userCanManageMatchAttendance(user, partido, {
  fetchUserRoleRowForAuthUser,
  legacySuperAdminEmails = [],
} = {}) {
  if (!user?.id || !partido) return false;

  const role = await resolveAuthRoleForUser(user, {
    fetchUserRoleRowForAuthUser,
    legacySuperAdminEmails,
  });

  if (role?.rol === 'super_admin') {
    return true;
  }

  if (
    role?.rol === 'admin_club'
    && partido.sede_id != null
    && Number(role.sede_id) === Number(partido.sede_id)
  ) {
    return true;
  }

  return false;
}

function validateAdminAttendanceMatchContext(state) {
  if (!state.ok) {
    return { ok: false, httpStatus: 404, reason: 'partido_no_encontrado' };
  }

  const { partido, partidoFields } = state;

  if (partidoFields.schema_attendance_columns_available !== true) {
    return { ok: false, httpStatus: 503, reason: 'schema_missing' };
  }

  if (partido.partido_torneo_id != null || partido.torneo_id != null) {
    return { ok: false, httpStatus: 400, reason: 'torneo_out_of_scope' };
  }

  if (String(partido.estado ?? '').trim().toLowerCase() === 'cancelado') {
    return { ok: false, httpStatus: 400, reason: 'partido_cancelado' };
  }

  return {
    ok: true,
    partido,
    partidoFields,
    participants: state.participants ?? [],
    summary: state.summary,
  };
}

function isCreditedLocked(partidoFields = {}) {
  return partidoFields.collection_status === MATCH_ATTENDANCE_COLLECTION_STATUS.CREDITED
    || Boolean(partidoFields.rewards_processed_at);
}

async function fetchParticipantDisplayNames(supabaseAdmin, userIds = []) {
  const uniqueIds = [...new Set((userIds ?? []).filter(isValidUserId))];
  if (!uniqueIds.length || !supabaseAdmin) {
    return new Map();
  }

  const { data, error } = await supabaseAdmin
    .from('jugadores_perfil')
    .select(PERFIL_DISPLAY_SELECT)
    .in('user_id', uniqueIds);

  if (error) {
    return new Map();
  }

  const map = new Map();
  for (const row of data ?? []) {
    if (row?.user_id) {
      map.set(String(row.user_id), formatRankingsDisplayName(row));
    }
  }
  return map;
}

export function mapAdminAttendanceParticipant(participant, displayNameByUserId = new Map()) {
  const fields = normalizeParticipantAttendanceFields(participant);
  const userId = fields.user_id;

  return {
    user_id: userId,
    display_name: displayNameByUserId.get(String(userId)) ?? 'Jugador',
    role: participant?.role ?? null,
    team: participant?.team ?? null,
    attendance_status: fields.attendance_status,
    attendance_requested_at: fields.attendance_requested_at,
    attendance_responded_at: fields.attendance_responded_at,
    attendance_response_source: fields.attendance_response_source,
    attendance_denial_reason: fields.attendance_denial_reason,
    reward_status: fields.reward_status,
  };
}

export function buildAdminAttendanceDetailPayload(state, participants = [], displayNameByUserId = new Map()) {
  const { partidoFields, summary } = state;

  return {
    ok: true,
    match_id: partidoFields.match_id,
    window: {
      collection_status: partidoFields.collection_status,
      deadline_at: partidoFields.deadline_at,
      resolved_at: partidoFields.resolved_at,
      resolution_reason: partidoFields.resolution_reason,
      rewards_processed_at: partidoFields.rewards_processed_at,
      feature_enabled: partidoFields.feature_enabled === true,
    },
    summary,
    participants: participants
      .filter((row) => isValidUserId(row?.user_id))
      .map((row) => mapAdminAttendanceParticipant(row, displayNameByUserId)),
  };
}

export async function getAdminMatchAttendanceDetail(supabaseAdmin, matchId) {
  const state = await getMatchAttendanceState(supabaseAdmin, matchId);
  const validated = validateAdminAttendanceMatchContext(state);
  if (!validated.ok) {
    return validated;
  }

  const displayNameByUserId = await fetchParticipantDisplayNames(
    supabaseAdmin,
    validated.participants.map((row) => row.user_id),
  );

  return buildAdminAttendanceDetailPayload(
    validated,
    validated.participants,
    displayNameByUserId,
  );
}

export function parseAdminParticipantOverrideBody(body = {}) {
  const status = String(body?.status ?? '').trim().toLowerCase();
  if (status !== MATCH_ATTENDANCE_STATUS.ADMIN_VALIDATED && status !== MATCH_ATTENDANCE_STATUS.EXCLUDED) {
    return { ok: false, reason: 'invalid_status' };
  }

  return {
    ok: true,
    status,
    reason: normalizeAttendanceDenialReason(body?.reason),
  };
}

export function parseAdminForceCloseBody(body = {}) {
  const action = String(body?.action ?? '').trim().toLowerCase();
  if (action !== 'ready' && action !== 'blocked') {
    return { ok: false, reason: 'invalid_action' };
  }

  const reason = String(body?.reason ?? '').replace(/\s+/g, ' ').trim();
  if (!reason) {
    return { ok: false, reason: 'reason_required' };
  }

  return {
    ok: true,
    action,
    reason: reason.slice(0, ATTENDANCE_DENIAL_REASON_MAX_LENGTH),
  };
}

function buildAdminOverrideParticipantPayload(status, reason, now = new Date()) {
  const respondedAt = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
  const normalizedReason = normalizeAttendanceDenialReason(reason);

  if (status === MATCH_ATTENDANCE_STATUS.ADMIN_VALIDATED) {
    return {
      attendance_status: MATCH_ATTENDANCE_STATUS.ADMIN_VALIDATED,
      attendance_confirmed_at: respondedAt,
      attendance_responded_at: respondedAt,
      attendance_response_source: MATCH_ATTENDANCE_RESPONSE_SOURCE.ADMIN,
      attendance_denial_reason: normalizedReason,
      updated_at: respondedAt,
    };
  }

  return {
    attendance_status: MATCH_ATTENDANCE_STATUS.EXCLUDED,
    attendance_confirmed_at: null,
    attendance_responded_at: respondedAt,
    attendance_response_source: MATCH_ATTENDANCE_RESPONSE_SOURCE.ADMIN,
    attendance_denial_reason: normalizedReason,
    updated_at: respondedAt,
  };
}

function buildAdminOverrideResponsePayload(matchId, participant, partidoFields, summary, rewards) {
  const playerFields = normalizeParticipantAttendanceFields(participant);

  return {
    ok: true,
    match_id: Number(matchId),
    participant: {
      user_id: playerFields.user_id,
      attendance_status: playerFields.attendance_status,
      attendance_responded_at: playerFields.attendance_responded_at,
      attendance_response_source: playerFields.attendance_response_source,
      attendance_denial_reason: playerFields.attendance_denial_reason,
      reward_status: playerFields.reward_status,
    },
    match: {
      collection_status: partidoFields.collection_status,
      resolved_at: partidoFields.resolved_at,
      resolution_reason: partidoFields.resolution_reason,
      rewards_processed_at: partidoFields.rewards_processed_at,
    },
    summary,
    rewards: rewards ?? buildAttendanceRewardsResponse({
      padcoins: { ok: false, reason: 'not_attempted' },
      ranking: { ok: false, reason: 'not_attempted' },
    }),
  };
}

export async function adminOverrideParticipantAttendance(supabaseAdmin, matchId, targetUserId, {
  status,
  reason = null,
  actor = {},
  now = new Date(),
  deps = {},
} = {}) {
  const normalizedMatchId = parsePartidoId(matchId);
  if (!normalizedMatchId) {
    return { ok: false, httpStatus: 400, reason: 'invalid_match_id' };
  }

  if (!isValidUserId(targetUserId)) {
    return { ok: false, httpStatus: 400, reason: 'invalid_user_id' };
  }

  const state = await getMatchAttendanceState(supabaseAdmin, normalizedMatchId);
  const validated = validateAdminAttendanceMatchContext(state);
  if (!validated.ok) {
    return validated;
  }

  if (isCreditedLocked(validated.partidoFields)) {
    return { ok: false, httpStatus: 409, reason: 'credited_locked' };
  }

  const participant = validated.participants.find(
    (row) => String(row.user_id) === String(targetUserId),
  );
  if (!participant) {
    return { ok: false, httpStatus: 404, reason: 'participant_not_found' };
  }

  const previousStatus = participant.attendance_status ?? null;
  const updatePayload = buildAdminOverrideParticipantPayload(status, reason, now);

  const { data: updatedParticipant, error } = await supabaseAdmin
    .from('match_participants')
    .update(updatePayload)
    .eq('match_type', MATCH_TYPES.CASUAL)
    .eq('match_id', normalizeMatchId(normalizedMatchId))
    .eq('user_id', String(targetUserId))
    .select(PARTICIPANTS_ATTENDANCE_SELECT)
    .maybeSingle();

  if (error) throw error;
  if (!updatedParticipant) {
    return { ok: false, httpStatus: 409, reason: 'concurrent_update_conflict' };
  }

  await appendMatchAttendanceAuditLog(supabaseAdmin, {
    match_id: normalizedMatchId,
    actor_user_id: actor.user_id ?? null,
    actor_role: actor.role ?? null,
    action: MATCH_ATTENDANCE_AUDIT_ACTIONS.PARTICIPANT_OVERRIDE,
    target_user_id: String(targetUserId),
    previous_status: previousStatus,
    new_status: updatePayload.attendance_status,
    reason: updatePayload.attendance_denial_reason,
    metadata: {
      collection_status_before: validated.partidoFields.collection_status,
    },
  });

  const evaluation = await evaluateAttendanceCollectionState(supabaseAdmin, normalizedMatchId, { now });
  const partidoFieldsAfter = evaluation.partidoFields ?? validated.partidoFields;
  const summaryAfter = evaluation.summary ?? validated.summary;

  let finalize = {
    partidoFields: partidoFieldsAfter,
    summary: summaryAfter,
    rewards: buildAttendanceRewardsResponse({
      padcoins: { ok: false, reason: partidoFieldsAfter.collection_status === MATCH_ATTENDANCE_COLLECTION_STATUS.BLOCKED ? 'blocked' : 'not_ready' },
      ranking: { ok: false, reason: partidoFieldsAfter.collection_status === MATCH_ATTENDANCE_COLLECTION_STATUS.BLOCKED ? 'blocked' : 'not_ready' },
    }),
  };

  if (partidoFieldsAfter.collection_status === MATCH_ATTENDANCE_COLLECTION_STATUS.READY) {
    finalize = await maybeFinalizeRewardsAfterAttendanceEvaluation(
      supabaseAdmin,
      normalizedMatchId,
      partidoFieldsAfter,
      { now, deps },
    );
  }

  return buildAdminOverrideResponsePayload(
    normalizedMatchId,
    updatedParticipant,
    finalize.partidoFields ?? partidoFieldsAfter,
    finalize.summary ?? summaryAfter,
    finalize.rewards,
  );
}

async function forceCloseAttendanceCollection(supabaseAdmin, matchId, {
  action,
  reason,
  actor = {},
  now = new Date(),
  deps = {},
} = {}) {
  const normalizedMatchId = parsePartidoId(matchId);
  if (!normalizedMatchId) {
    return { ok: false, httpStatus: 400, reason: 'invalid_match_id' };
  }

  const state = await getMatchAttendanceState(supabaseAdmin, normalizedMatchId);
  const validated = validateAdminAttendanceMatchContext(state);
  if (!validated.ok) {
    return validated;
  }

  if (isCreditedLocked(validated.partidoFields)) {
    return { ok: false, httpStatus: 409, reason: 'credited_locked' };
  }

  const resolvedAt = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
  const previousStatus = validated.partidoFields.collection_status;

  if (action === 'ready') {
    const eligible = validated.summary?.eligible ?? 0;
    if (!Number.isFinite(Number(eligible)) || Number(eligible) <= 0) {
      return { ok: false, httpStatus: 400, reason: 'no_eligible_participants' };
    }

    const { data: updatedPartido, error } = await supabaseAdmin
      .from('partidos_abiertos')
      .update({
        attendance_collection_status: MATCH_ATTENDANCE_COLLECTION_STATUS.READY,
        attendance_resolved_at: resolvedAt,
        attendance_resolution_reason: MATCH_ATTENDANCE_RESOLUTION_REASON.ADMIN_OVERRIDE,
      })
      .eq('id', normalizedMatchId)
      .neq('attendance_collection_status', MATCH_ATTENDANCE_COLLECTION_STATUS.CREDITED)
      .select('id')
      .maybeSingle();

    if (error) throw error;
    if (!updatedPartido) {
      const refreshed = await getMatchAttendanceState(supabaseAdmin, normalizedMatchId);
      if (refreshed.ok && isCreditedLocked(refreshed.partidoFields)) {
        return { ok: false, httpStatus: 409, reason: 'credited_locked' };
      }
      return { ok: false, httpStatus: 409, reason: 'concurrent_update_conflict' };
    }

    await appendMatchAttendanceAuditLog(supabaseAdmin, {
      match_id: normalizedMatchId,
      actor_user_id: actor.user_id ?? null,
      actor_role: actor.role ?? null,
      action: MATCH_ATTENDANCE_AUDIT_ACTIONS.FORCE_CLOSE_READY,
      previous_status: previousStatus,
      new_status: MATCH_ATTENDANCE_COLLECTION_STATUS.READY,
      reason,
      metadata: { eligible_count: eligible },
    });

    const refreshedState = await getMatchAttendanceState(supabaseAdmin, normalizedMatchId);
    const finalize = await maybeFinalizeRewardsAfterAttendanceEvaluation(
      supabaseAdmin,
      normalizedMatchId,
      refreshedState.partidoFields,
      { now, deps },
    );

    return {
      ok: true,
      match_id: normalizedMatchId,
      action: 'ready',
      match: {
        collection_status: finalize.partidoFields?.collection_status ?? MATCH_ATTENDANCE_COLLECTION_STATUS.READY,
        resolved_at: finalize.partidoFields?.resolved_at ?? resolvedAt,
        resolution_reason: MATCH_ATTENDANCE_RESOLUTION_REASON.ADMIN_OVERRIDE,
        rewards_processed_at: finalize.partidoFields?.rewards_processed_at ?? null,
      },
      summary: finalize.summary ?? refreshedState.summary,
      rewards: finalize.rewards,
    };
  }

  const { data: blockedPartido, error: blockError } = await supabaseAdmin
    .from('partidos_abiertos')
    .update({
      attendance_collection_status: MATCH_ATTENDANCE_COLLECTION_STATUS.BLOCKED,
      attendance_resolved_at: resolvedAt,
      attendance_resolution_reason: MATCH_ATTENDANCE_RESOLUTION_REASON.ADMIN_OVERRIDE,
    })
    .eq('id', normalizedMatchId)
    .neq('attendance_collection_status', MATCH_ATTENDANCE_COLLECTION_STATUS.CREDITED)
    .select('id')
    .maybeSingle();

  if (blockError) throw blockError;
  if (!blockedPartido) {
    const refreshed = await getMatchAttendanceState(supabaseAdmin, normalizedMatchId);
    if (refreshed.ok && isCreditedLocked(refreshed.partidoFields)) {
      return { ok: false, httpStatus: 409, reason: 'credited_locked' };
    }
    return { ok: false, httpStatus: 409, reason: 'concurrent_update_conflict' };
  }

  await appendMatchAttendanceAuditLog(supabaseAdmin, {
    match_id: normalizedMatchId,
    actor_user_id: actor.user_id ?? null,
    actor_role: actor.role ?? null,
    action: MATCH_ATTENDANCE_AUDIT_ACTIONS.FORCE_CLOSE_BLOCKED,
    previous_status: previousStatus,
    new_status: MATCH_ATTENDANCE_COLLECTION_STATUS.BLOCKED,
    reason,
  });

  const refreshedState = await getMatchAttendanceState(supabaseAdmin, normalizedMatchId);

  return {
    ok: true,
    match_id: normalizedMatchId,
    action: 'blocked',
    match: {
      collection_status: MATCH_ATTENDANCE_COLLECTION_STATUS.BLOCKED,
      resolved_at: resolvedAt,
      resolution_reason: MATCH_ATTENDANCE_RESOLUTION_REASON.ADMIN_OVERRIDE,
      rewards_processed_at: null,
    },
    summary: refreshedState.summary,
    rewards: buildAttendanceRewardsResponse({
      padcoins: { ok: false, reason: 'blocked' },
      ranking: { ok: false, reason: 'blocked' },
    }),
  };
}

export async function adminForceCloseAttendanceCollection(supabaseAdmin, matchId, options = {}) {
  return forceCloseAttendanceCollection(supabaseAdmin, matchId, options);
}

export async function adminReprocessAttendanceRewards(supabaseAdmin, matchId, {
  actor = {},
  now = new Date(),
  deps = {},
} = {}) {
  const normalizedMatchId = parsePartidoId(matchId);
  if (!normalizedMatchId) {
    return { ok: false, httpStatus: 400, reason: 'invalid_match_id' };
  }

  const state = await getMatchAttendanceState(supabaseAdmin, normalizedMatchId);
  const validated = validateAdminAttendanceMatchContext(state);
  if (!validated.ok) {
    return validated;
  }

  if (validated.partidoFields.collection_status !== MATCH_ATTENDANCE_COLLECTION_STATUS.READY) {
    return { ok: false, httpStatus: 400, reason: 'not_ready' };
  }

  const finalizeFn = deps.tryFinalizeMatchAttendanceRewards ?? tryFinalizeMatchAttendanceRewards;
  const finalizeResult = await finalizeFn(supabaseAdmin, normalizedMatchId, {
    now,
    deps,
  });

  await appendMatchAttendanceAuditLog(supabaseAdmin, {
    match_id: normalizedMatchId,
    actor_user_id: actor.user_id ?? null,
    actor_role: actor.role ?? null,
    action: MATCH_ATTENDANCE_AUDIT_ACTIONS.REPROCESS_REWARDS,
    previous_status: MATCH_ATTENDANCE_COLLECTION_STATUS.READY,
    new_status: finalizeResult.partidoFields?.collection_status ?? MATCH_ATTENDANCE_COLLECTION_STATUS.READY,
    metadata: {
      idempotent: finalizeResult.idempotent === true,
      skipped: finalizeResult.skipped === true,
      reason: finalizeResult.reason ?? null,
    },
  });

  const refreshed = await getMatchAttendanceState(supabaseAdmin, normalizedMatchId);

  return {
    ok: true,
    match_id: normalizedMatchId,
    idempotent: finalizeResult.idempotent === true,
    match: {
      collection_status: refreshed.partidoFields?.collection_status ?? validated.partidoFields.collection_status,
      resolved_at: refreshed.partidoFields?.resolved_at,
      resolution_reason: refreshed.partidoFields?.resolution_reason,
      rewards_processed_at: refreshed.partidoFields?.rewards_processed_at,
    },
    summary: refreshed.summary ?? validated.summary,
    rewards: finalizeResult.rewards,
  };
}
