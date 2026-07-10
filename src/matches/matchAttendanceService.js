import { isAttendanceConfirmationEnabledForMatch } from './matchAttendanceConfig.js';
import { resolveAuthRoleForUser } from '../../lib/authAccess.js';
import {
  MATCH_ATTENDANCE_COLLECTION_STATUS,
  MATCH_ATTENDANCE_STATUS,
  MATCH_TYPES,
  normalizeAttendanceCollectionStatus,
  normalizeAttendanceResponseSource,
  normalizeAttendanceStatus,
  normalizeMatchId,
  isValidUserId,
} from './matchParticipantsConstants.js';
import {
  getEligibleParticipantsForRewards,
  listMatchParticipants,
} from './matchParticipantsService.js';

export const PARTIDOS_ATTENDANCE_SELECT =
  'id, sede_id, capitan_user_id, attendance_collection_status, attendance_opened_at, attendance_deadline_at, attendance_resolved_at, attendance_resolution_reason, rewards_processed_at';

export const PARTICIPANTS_ATTENDANCE_SELECT =
  'id, user_id, role, team, attendance_status, attendance_confirmed_at, attendance_requested_at, attendance_responded_at, attendance_response_source, attendance_denial_reason, reward_status';

const PARTIDOS_ATTENDANCE_COLUMN_MARKERS = [
  'attendance_collection_status',
  'attendance_opened_at',
  'attendance_deadline_at',
  'attendance_resolved_at',
  'attendance_resolution_reason',
  'rewards_processed_at',
];

const PARTICIPANTS_ATTENDANCE_COLUMN_MARKERS = [
  'attendance_requested_at',
  'attendance_responded_at',
  'attendance_response_source',
  'attendance_denial_reason',
];

export function isMissingMatchAttendanceColumnError(error) {
  const message = String(error?.message ?? '').toLowerCase();
  if (error?.code === '42703') {
    return PARTIDOS_ATTENDANCE_COLUMN_MARKERS.some((col) => message.includes(col))
      || PARTICIPANTS_ATTENDANCE_COLUMN_MARKERS.some((col) => message.includes(col));
  }

  return [...PARTIDOS_ATTENDANCE_COLUMN_MARKERS, ...PARTICIPANTS_ATTENDANCE_COLUMN_MARKERS]
    .some((col) => message.includes(col) && message.includes('does not exist'));
}

function safeCount(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

export function buildLegacyPartidoAttendanceFields(partido = {}) {
  return {
    match_id: Number(partido?.id) || null,
    collection_status: MATCH_ATTENDANCE_COLLECTION_STATUS.NONE,
    opened_at: null,
    deadline_at: null,
    resolved_at: null,
    resolution_reason: null,
    rewards_processed_at: null,
    schema_attendance_columns_available: false,
    feature_enabled: isAttendanceConfirmationEnabledForMatch(partido),
  };
}

export function normalizePartidoAttendanceFields(partido = {}, {
  schemaAttendanceColumnsAvailable = true,
} = {}) {
  if (!schemaAttendanceColumnsAvailable) {
    return buildLegacyPartidoAttendanceFields(partido);
  }

  return {
    match_id: Number(partido?.id) || null,
    collection_status: normalizeAttendanceCollectionStatus(partido?.attendance_collection_status),
    opened_at: partido?.attendance_opened_at ?? null,
    deadline_at: partido?.attendance_deadline_at ?? null,
    resolved_at: partido?.attendance_resolved_at ?? null,
    resolution_reason: partido?.attendance_resolution_reason ?? null,
    rewards_processed_at: partido?.rewards_processed_at ?? null,
    schema_attendance_columns_available: true,
    feature_enabled: isAttendanceConfirmationEnabledForMatch(partido),
  };
}

export function normalizeParticipantAttendanceFields(participant = null, {
  schemaParticipantColumnsAvailable = true,
  defaultStatus = MATCH_ATTENDANCE_STATUS.PENDING,
} = {}) {
  if (!participant) {
    return {
      user_id: null,
      attendance_status: defaultStatus,
      attendance_confirmed_at: null,
      attendance_requested_at: null,
      attendance_responded_at: null,
      attendance_response_source: null,
      attendance_denial_reason: null,
      reward_status: null,
      is_participant: false,
    };
  }

  return {
    user_id: participant.user_id ?? null,
    attendance_status: normalizeAttendanceStatus(participant.attendance_status, defaultStatus),
    attendance_confirmed_at: participant.attendance_confirmed_at ?? null,
    attendance_requested_at: schemaParticipantColumnsAvailable
      ? (participant.attendance_requested_at ?? null)
      : null,
    attendance_responded_at: schemaParticipantColumnsAvailable
      ? (participant.attendance_responded_at ?? null)
      : null,
    attendance_response_source: schemaParticipantColumnsAvailable
      ? normalizeAttendanceResponseSource(participant.attendance_response_source)
      : null,
    attendance_denial_reason: schemaParticipantColumnsAvailable
      ? (participant.attendance_denial_reason ?? null)
      : null,
    reward_status: participant.reward_status ?? null,
    is_participant: true,
  };
}

export function countParticipantsByAttendanceStatus(participants = []) {
  const counts = {
    total_participants: 0,
    pending: 0,
    confirmed: 0,
    denied: 0,
    admin_validated: 0,
    excluded: 0,
  };

  for (const participant of participants ?? []) {
    if (!isValidUserId(participant?.user_id)) continue;
    counts.total_participants += 1;

    const status = normalizeAttendanceStatus(participant.attendance_status, '');
    switch (status) {
      case MATCH_ATTENDANCE_STATUS.CONFIRMED:
        counts.confirmed += 1;
        break;
      case MATCH_ATTENDANCE_STATUS.DENIED:
        counts.denied += 1;
        break;
      case MATCH_ATTENDANCE_STATUS.ADMIN_VALIDATED:
        counts.admin_validated += 1;
        break;
      case MATCH_ATTENDANCE_STATUS.EXCLUDED:
        counts.excluded += 1;
        break;
      default:
        counts.pending += 1;
        break;
    }
  }

  return counts;
}

export function computeEligibleParticipantCount(participants = []) {
  return getEligibleParticipantsForRewards(participants ?? []).length;
}

export function buildMatchAttendanceSummary(partidoFields, participants = []) {
  const counts = countParticipantsByAttendanceStatus(participants);

  return {
    match_id: partidoFields.match_id,
    collection_status: partidoFields.collection_status,
    opened_at: partidoFields.opened_at,
    deadline_at: partidoFields.deadline_at,
    resolved_at: partidoFields.resolved_at,
    resolution_reason: partidoFields.resolution_reason,
    rewards_processed_at: partidoFields.rewards_processed_at,
    total_participants: safeCount(counts.total_participants),
    pending: safeCount(counts.pending),
    confirmed: safeCount(counts.confirmed),
    denied: safeCount(counts.denied),
    admin_validated: safeCount(counts.admin_validated),
    excluded: safeCount(counts.excluded),
    eligible: safeCount(computeEligibleParticipantCount(participants)),
    feature_enabled: partidoFields.feature_enabled === true,
    schema_attendance_columns_available: partidoFields.schema_attendance_columns_available === true,
  };
}

export function computeCanRespondToAttendance({
  featureEnabled,
  collectionStatus,
  deadlineAt,
  attendanceStatus,
  isParticipant,
  now = new Date(),
} = {}) {
  if (!featureEnabled || !isParticipant) {
    return false;
  }

  if (collectionStatus !== MATCH_ATTENDANCE_COLLECTION_STATUS.OPEN) {
    return false;
  }

  if (normalizeAttendanceStatus(attendanceStatus) !== MATCH_ATTENDANCE_STATUS.PENDING) {
    return false;
  }

  if (deadlineAt) {
    const deadlineMs = new Date(deadlineAt).getTime();
    if (Number.isFinite(deadlineMs) && deadlineMs <= now.getTime()) {
      return false;
    }
  }

  return true;
}

async function fetchPartidoAttendanceRow(supabaseAdmin, matchId) {
  const normalizedMatchId = Number(matchId);
  if (!Number.isFinite(normalizedMatchId) || normalizedMatchId <= 0) {
    return { partido: null, schemaAttendanceColumnsAvailable: false };
  }

  const { data, error } = await supabaseAdmin
    .from('partidos_abiertos')
    .select(PARTIDOS_ATTENDANCE_SELECT)
    .eq('id', normalizedMatchId)
    .maybeSingle();

  if (error) {
    if (isMissingMatchAttendanceColumnError(error)) {
      const { data: fallback, error: fallbackErr } = await supabaseAdmin
        .from('partidos_abiertos')
        .select('id, sede_id, capitan_user_id')
        .eq('id', normalizedMatchId)
        .maybeSingle();

      if (fallbackErr) throw fallbackErr;
      return {
        partido: fallback ?? null,
        schemaAttendanceColumnsAvailable: false,
      };
    }
    throw error;
  }

  return {
    partido: data ?? null,
    schemaAttendanceColumnsAvailable: true,
  };
}

async function fetchParticipantsForAttendance(supabaseAdmin, matchId) {
  const normalizedMatchId = normalizeMatchId(matchId);
  if (!normalizedMatchId) {
    return { participants: [], schemaParticipantColumnsAvailable: true };
  }

  const { data, error } = await supabaseAdmin
    .from('match_participants')
    .select(PARTICIPANTS_ATTENDANCE_SELECT)
    .eq('match_type', MATCH_TYPES.CASUAL)
    .eq('match_id', normalizedMatchId)
    .order('created_at', { ascending: true });

  if (error) {
    if (isMissingMatchAttendanceColumnError(error)) {
      return {
        participants: await listMatchParticipants(supabaseAdmin, {
          matchType: MATCH_TYPES.CASUAL,
          matchId: normalizedMatchId,
        }),
        schemaParticipantColumnsAvailable: false,
      };
    }
    throw error;
  }

  return {
    participants: data ?? [],
    schemaParticipantColumnsAvailable: true,
  };
}

export async function getMatchAttendanceState(supabaseAdmin, matchId) {
  const { partido, schemaAttendanceColumnsAvailable } = await fetchPartidoAttendanceRow(
    supabaseAdmin,
    matchId,
  );

  if (!partido) {
    return { ok: false, reason: 'partido_no_encontrado' };
  }

  const partidoFields = normalizePartidoAttendanceFields(partido, {
    schemaAttendanceColumnsAvailable,
  });

  const { participants } = await fetchParticipantsForAttendance(supabaseAdmin, matchId);

  return {
    ok: true,
    partido,
    partidoFields,
    participants,
    summary: buildMatchAttendanceSummary(partidoFields, participants),
  };
}

export async function getMatchAttendanceSummary(supabaseAdmin, matchId) {
  const state = await getMatchAttendanceState(supabaseAdmin, matchId);
  if (!state.ok) {
    return state;
  }

  return {
    ok: true,
    summary: state.summary,
  };
}

export async function getPlayerAttendanceState(supabaseAdmin, matchId, userId) {
  if (!isValidUserId(userId)) {
    return { ok: false, reason: 'invalid_user_id' };
  }

  const state = await getMatchAttendanceState(supabaseAdmin, matchId);
  if (!state.ok) {
    return state;
  }

  const participant = (state.participants ?? []).find((row) => row.user_id === userId) ?? null;
  const membership = await resolveUserPartidoMembership(supabaseAdmin, state.partido, userId);

  const playerFields = normalizeParticipantAttendanceFields(participant, {
    defaultStatus: membership.is_member
      ? MATCH_ATTENDANCE_STATUS.PENDING
      : MATCH_ATTENDANCE_STATUS.PENDING,
  });

  const canRespond = computeCanRespondToAttendance({
    featureEnabled: state.partidoFields.feature_enabled,
    collectionStatus: state.partidoFields.collection_status,
    deadlineAt: state.partidoFields.deadline_at,
    attendanceStatus: playerFields.attendance_status,
    isParticipant: membership.is_member,
  });

  return {
    ok: true,
    match: state.partidoFields,
    summary: state.summary,
    player: {
      ...playerFields,
      is_member: membership.is_member,
      is_captain: membership.is_captain,
      can_respond: canRespond,
    },
  };
}

export async function resolveUserPartidoMembership(supabaseAdmin, partido, userId) {
  if (!partido || !isValidUserId(userId)) {
    return { is_member: false, is_captain: false };
  }

  const isCaptain = String(partido.capitan_user_id ?? '') === String(userId);
  if (isCaptain) {
    return { is_member: true, is_captain: true };
  }

  const { data: joinRow, error: joinErr } = await supabaseAdmin
    .from('partidos_abiertos_jugadores')
    .select('id')
    .eq('partido_id', partido.id)
    .eq('user_id', userId)
    .maybeSingle();

  if (joinErr) throw joinErr;
  if (joinRow) {
    return { is_member: true, is_captain: false };
  }

  const { data: participantRow, error: participantErr } = await supabaseAdmin
    .from('match_participants')
    .select('id')
    .eq('match_type', MATCH_TYPES.CASUAL)
    .eq('match_id', String(partido.id))
    .eq('user_id', userId)
    .maybeSingle();

  if (participantErr) throw participantErr;

  return {
    is_member: Boolean(participantRow?.id),
    is_captain: false,
  };
}

export async function userCanViewAttendanceSummary(user, partido, {
  fetchUserRoleRowForAuthUser,
  legacySuperAdminEmails = [],
} = {}) {
  if (!user?.id || !partido) return false;

  if (String(partido.capitan_user_id ?? '') === String(user.id)) {
    return true;
  }

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

export { isAttendanceConfirmationEnabledForMatch };
