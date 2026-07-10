import {
  getMatchAttendanceCronBatchSize,
  getMatchAttendanceWindowHours,
  isAttendanceConfirmationEnabledForMatch,
  isMatchAttendanceConfirmationEnabled,
} from './matchAttendanceConfig.js';
import {
  getSedeAttendanceConfirmationEnabled,
  resolveAttendanceFeatureForPartido,
} from './matchAttendanceSedeConfigService.js';
import { resolveAuthRoleForUser } from '../../lib/authAccess.js';
import {
  isEquiposAsignacionValida,
  normalizeEquipoUserIds,
  sortJugadoresRowsForEquipos,
} from '../partidos/equiposService.js';
import {
  MATCH_ATTENDANCE_COLLECTION_STATUS,
  MATCH_ATTENDANCE_RESOLUTION_REASON,
  MATCH_ATTENDANCE_RESPONSE_SOURCE,
  MATCH_ATTENDANCE_STATUS,
  ATTENDANCE_DENIAL_REASON_MAX_LENGTH,
  MATCH_PARTICIPANT_ROLES,
  MATCH_PARTICIPANT_SOURCES,
  MATCH_REWARD_STATUS,
  MATCH_TYPES,
  isResolvedAttendanceStatus,
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
import { notifyInitialAttendancePendingParticipants } from './matchAttendanceNotificationService.js';
import { creditValidatedMatchPadcoins } from './matchRewardsService.js';
import {
  processCasualMatchRankingAfterResultConfirmed,
  processCasualMatchRankingAfterScoreboardFinished,
} from '../ranking/casualMatchRankingService.js';
import { isScoreboardEstadoTerminado } from './scoreboardMatchRewardsService.js';

export const PARTIDOS_ATTENDANCE_SELECT =
  'id, sede_id, capitan_user_id, attendance_collection_status, attendance_opened_at, attendance_deadline_at, attendance_resolved_at, attendance_resolution_reason, rewards_processed_at';

export const PARTIDOS_ATTENDANCE_REWARDS_SELECT =
  `${PARTIDOS_ATTENDANCE_SELECT}, estado, ganador, resultado, deporte, reserva_id, partido_torneo_id, torneo_id, equipos_asignacion`;

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

export function buildLegacyPartidoAttendanceFields(partido = {}, {
  sedeAttendanceConfirmationEnabled = false,
} = {}) {
  return {
    match_id: Number(partido?.id) || null,
    collection_status: MATCH_ATTENDANCE_COLLECTION_STATUS.NONE,
    opened_at: null,
    deadline_at: null,
    resolved_at: null,
    resolution_reason: null,
    rewards_processed_at: null,
    schema_attendance_columns_available: false,
    feature_enabled: isAttendanceConfirmationEnabledForMatch(partido, {
      sedeEnabled: sedeAttendanceConfirmationEnabled,
    }),
  };
}

export function normalizePartidoAttendanceFields(partido = {}, {
  schemaAttendanceColumnsAvailable = true,
  sedeAttendanceConfirmationEnabled = false,
} = {}) {
  if (!schemaAttendanceColumnsAvailable) {
    return buildLegacyPartidoAttendanceFields(partido, { sedeAttendanceConfirmationEnabled });
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
    feature_enabled: isAttendanceConfirmationEnabledForMatch(partido, {
      sedeEnabled: sedeAttendanceConfirmationEnabled,
    }),
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

  const { sedeEnabled, featureEnabled } = await resolveAttendanceFeatureForPartido(
    supabaseAdmin,
    partido,
  );

  const partidoFields = normalizePartidoAttendanceFields(partido, {
    schemaAttendanceColumnsAvailable,
    sedeAttendanceConfirmationEnabled: sedeEnabled,
  });
  partidoFields.feature_enabled = featureEnabled;

  const { participants } = await fetchParticipantsForAttendance(supabaseAdmin, matchId);

  return {
    ok: true,
    partido,
    partidoFields,
    participants,
    summary: buildMatchAttendanceSummary(partidoFields, participants),
    sede_attendance_confirmation_enabled: sedeEnabled,
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

export const NON_RESTARTABLE_ATTENDANCE_COLLECTION_STATUSES = new Set([
  MATCH_ATTENDANCE_COLLECTION_STATUS.OPEN,
  MATCH_ATTENDANCE_COLLECTION_STATUS.EXPIRED,
  MATCH_ATTENDANCE_COLLECTION_STATUS.READY,
  MATCH_ATTENDANCE_COLLECTION_STATUS.CREDITED,
  MATCH_ATTENDANCE_COLLECTION_STATUS.BLOCKED,
]);

export function calculateAttendanceDeadline(openedAt, windowHours = getMatchAttendanceWindowHours()) {
  const base = openedAt instanceof Date ? openedAt : new Date(openedAt);
  if (!Number.isFinite(base.getTime())) {
    return null;
  }

  const hours = Number(windowHours);
  const effectiveHours = Number.isFinite(hours) && hours > 0
    ? hours
    : getMatchAttendanceWindowHours();

  return new Date(base.getTime() + effectiveHours * 60 * 60 * 1000).toISOString();
}

export function partidoHasClearManualResult(partido = {}) {
  if (!partido) return false;
  if (String(partido.estado ?? '').trim().toLowerCase() === 'cancelado') {
    return false;
  }
  if (String(partido.estado ?? '').trim().toLowerCase() !== 'finalizado') {
    return false;
  }

  const ganador = String(partido.ganador ?? '').trim().toLowerCase();
  if (ganador === 'equipo1' || ganador === 'equipo2') {
    return true;
  }

  const resultado = partido.resultado;
  if (resultado && typeof resultado === 'object') {
    const equipo1 = Number(resultado.equipo1);
    const equipo2 = Number(resultado.equipo2);
    if (Number.isFinite(equipo1) && Number.isFinite(equipo2) && equipo1 !== equipo2) {
      return true;
    }
  }

  return false;
}

export function scoreboardHasClearResult(scoreboard = {}) {
  const setsA = Number(scoreboard.sets_a) || 0;
  const setsB = Number(scoreboard.sets_b) || 0;
  if (setsA > setsB || setsB > setsA) {
    return true;
  }
  return false;
}

export function shouldOpenAttendanceWindow(match = {}, {
  hasClearResult = false,
  featureEnabled = null,
} = {}) {
  const enabled = featureEnabled ?? isAttendanceConfirmationEnabledForMatch(match);
  if (!match || !enabled) {
    return false;
  }

  if (String(match.estado ?? '').trim().toLowerCase() === 'cancelado') {
    return false;
  }

  if (match.partido_torneo_id != null || match.torneo_id != null) {
    return false;
  }

  const collectionStatus = normalizeAttendanceCollectionStatus(match.attendance_collection_status);
  if (collectionStatus !== MATCH_ATTENDANCE_COLLECTION_STATUS.NONE) {
    return false;
  }

  return hasClearResult === true;
}

export function isAttendanceWindowAlreadyActive(match = {}) {
  const collectionStatus = normalizeAttendanceCollectionStatus(match.attendance_collection_status);
  return NON_RESTARTABLE_ATTENDANCE_COLLECTION_STATUSES.has(collectionStatus);
}

async function resolveCapitanesIdsForAttendance(supabaseAdmin, partido = {}) {
  const capitanes = [];
  if (isValidUserId(partido.capitan_user_id)) {
    capitanes.push(String(partido.capitan_user_id).trim());
  }

  if (isEquiposAsignacionValida(partido.equipos_asignacion)) {
    const capitanEquipo2 = normalizeEquipoUserIds(partido.equipos_asignacion.equipo2)[0] ?? null;
    if (capitanEquipo2 && !capitanes.includes(capitanEquipo2)) {
      capitanes.push(capitanEquipo2);
    }
    return capitanes;
  }

  if (partido.id == null) {
    return capitanes;
  }

  const { data: jugadores, error } = await supabaseAdmin
    .from('partidos_abiertos_jugadores')
    .select('user_id, email, joined_at')
    .eq('partido_id', Number(partido.id))
    .order('joined_at', { ascending: true });

  if (error) throw error;

  const sorted = sortJugadoresRowsForEquipos(
    jugadores ?? [],
    partido.capitan_user_id ?? null,
    partido.capitan_email ?? null,
  );
  const midpoint = Math.ceil(sorted.length / 2);
  const capitanEquipo2 = sorted[midpoint]?.user_id ?? null;
  if (isValidUserId(capitanEquipo2) && !capitanes.includes(capitanEquipo2)) {
    capitanes.push(String(capitanEquipo2).trim());
  }

  return capitanes;
}

async function collectScoreboardCandidatesForAttendance(supabaseAdmin, scoreboard) {
  const { collectScoreboardParticipantCandidates } = await import('./scoreboardMatchRewardsService.js');
  return collectScoreboardParticipantCandidates(supabaseAdmin, scoreboard);
}

function mapAttendanceParticipantSource(source = 'manual') {
  const normalized = String(source ?? '').trim().toLowerCase();
  if (normalized === 'scoreboard') {
    return MATCH_PARTICIPANT_SOURCES.SCOREBOARD;
  }
  if (normalized === 'admin') {
    return MATCH_PARTICIPANT_SOURCES.ADMIN;
  }
  return MATCH_PARTICIPANT_SOURCES.MANUAL;
}

function addParticipantCandidate(byUserId, userId, meta = {}) {
  if (!isValidUserId(userId)) {
    return false;
  }

  const key = String(userId).trim();
  const existing = byUserId.get(key) ?? {};
  byUserId.set(key, {
    user_id: key,
    team: meta.team ?? existing.team ?? null,
    email: meta.email ?? existing.email ?? null,
    role: meta.role ?? existing.role ?? MATCH_PARTICIPANT_ROLES.PARTICIPANT,
    source: meta.source ?? existing.source ?? MATCH_PARTICIPANT_SOURCES.MANUAL,
  });
  return true;
}

async function collectPendingParticipantCandidates(supabaseAdmin, {
  partido,
  scoreboard = null,
  source = 'manual',
} = {}) {
  const byUserId = new Map();
  let skippedNoUserId = 0;
  const participantSource = mapAttendanceParticipantSource(source);

  const addOrSkip = (userId, meta = {}) => {
    if (addParticipantCandidate(byUserId, userId, meta)) return;
    if (userId != null && String(userId).trim() !== '') {
      skippedNoUserId += 1;
    }
  };

  if (isValidUserId(partido?.capitan_user_id)) {
    addOrSkip(partido.capitan_user_id, {
      role: MATCH_PARTICIPANT_ROLES.ORGANIZER,
      source: participantSource,
    });
  }

  if (partido?.id != null) {
    const { data: jugadores, error: jugadoresErr } = await supabaseAdmin
      .from('partidos_abiertos_jugadores')
      .select('user_id, email')
      .eq('partido_id', Number(partido.id));

    if (jugadoresErr) throw jugadoresErr;

    for (const jugador of jugadores ?? []) {
      const isOrganizer = isValidUserId(partido.capitan_user_id)
        && jugador.user_id === partido.capitan_user_id;
      if (addParticipantCandidate(byUserId, jugador.user_id, {
        email: jugador.email ?? null,
        role: isOrganizer
          ? MATCH_PARTICIPANT_ROLES.ORGANIZER
          : MATCH_PARTICIPANT_ROLES.PARTICIPANT,
        source: MATCH_PARTICIPANT_SOURCES.JOIN,
      })) {
        continue;
      }
      if (jugador.user_id != null && String(jugador.user_id).trim() !== '') {
        skippedNoUserId += 1;
      }
    }
  }

  if (isEquiposAsignacionValida(partido?.equipos_asignacion)) {
    for (const userId of normalizeEquipoUserIds(partido.equipos_asignacion.equipo1 ?? [])) {
      addOrSkip(userId, { team: 'A', source: participantSource });
    }
    for (const userId of normalizeEquipoUserIds(partido.equipos_asignacion.equipo2 ?? [])) {
      addOrSkip(userId, { team: 'B', source: participantSource });
    }
  }

  if (partido?.id != null) {
    const capitanes = await resolveCapitanesIdsForAttendance(supabaseAdmin, partido);
    for (const capitanId of capitanes) {
      addOrSkip(capitanId, {
        role: capitanId === partido.capitan_user_id
          ? MATCH_PARTICIPANT_ROLES.ORGANIZER
          : MATCH_PARTICIPANT_ROLES.PARTICIPANT,
        source: participantSource,
      });
    }
  }

  if (scoreboard) {
    const { candidates, skipped_no_user_id: skippedFromScoreboard } =
      await collectScoreboardCandidatesForAttendance(supabaseAdmin, scoreboard);
    skippedNoUserId += skippedFromScoreboard ?? 0;

    for (const candidate of candidates ?? []) {
      const isOrganizer = isValidUserId(partido?.capitan_user_id)
        && candidate.user_id === partido.capitan_user_id;
      if (addParticipantCandidate(byUserId, candidate.user_id, {
        team: candidate.team ?? null,
        email: candidate.email ?? null,
        role: isOrganizer
          ? MATCH_PARTICIPANT_ROLES.ORGANIZER
          : MATCH_PARTICIPANT_ROLES.PARTICIPANT,
        source: MATCH_PARTICIPANT_SOURCES.SCOREBOARD,
      })) {
        continue;
      }
      skippedNoUserId += 1;
    }
  }

  return {
    candidates: [...byUserId.values()],
    skipped_no_user_id: skippedNoUserId,
  };
}

async function upsertPendingParticipantForAttendance(supabaseAdmin, {
  matchId,
  candidate,
  requestedAt,
  reservaId = null,
  existingByUserId,
}) {
  const userId = candidate.user_id;
  const existing = existingByUserId.get(userId);

  if (existing && isResolvedAttendanceStatus(existing.attendance_status)) {
    return {
      ok: true,
      participant: existing,
      created: false,
      preserved: true,
    };
  }

  if (existing?.id) {
    const updatePayload = {
      role: candidate.role ?? existing.role ?? MATCH_PARTICIPANT_ROLES.PARTICIPANT,
      team: candidate.team ?? existing.team ?? null,
      source: candidate.source ?? existing.source ?? MATCH_PARTICIPANT_SOURCES.MANUAL,
      attendance_status: MATCH_ATTENDANCE_STATUS.PENDING,
      reward_status: MATCH_REWARD_STATUS.PENDING,
      attendance_requested_at: existing.attendance_requested_at ?? null,
      attendance_responded_at: null,
      attendance_response_source: null,
      attendance_denial_reason: null,
      updated_at: new Date().toISOString(),
    };

    const { data, error } = await supabaseAdmin
      .from('match_participants')
      .update(updatePayload)
      .eq('id', existing.id)
      .select('*')
      .single();

    if (error) throw error;
    existingByUserId.set(userId, data);
    return { ok: true, participant: data, created: false, preserved: false };
  }

  const insertPayload = {
    match_type: MATCH_TYPES.CASUAL,
    match_id: matchId,
    user_id: userId,
    role: candidate.role ?? MATCH_PARTICIPANT_ROLES.PARTICIPANT,
    team: candidate.team ?? null,
    email: candidate.email ?? null,
    source: candidate.source ?? MATCH_PARTICIPANT_SOURCES.MANUAL,
    attendance_status: MATCH_ATTENDANCE_STATUS.PENDING,
    reward_status: MATCH_REWARD_STATUS.PENDING,
    attendance_requested_at: null,
    attendance_responded_at: null,
    attendance_response_source: null,
    attendance_denial_reason: null,
  };

  if (reservaId != null) {
    insertPayload.reserva_id = Number(reservaId);
  }

  const { data, error } = await supabaseAdmin
    .from('match_participants')
    .insert(insertPayload)
    .select('*')
    .single();

  if (error) {
    if (error.code === '23505') {
      const { data: refetched, error: refetchErr } = await supabaseAdmin
        .from('match_participants')
        .select('*')
        .eq('match_type', MATCH_TYPES.CASUAL)
        .eq('match_id', matchId)
        .eq('user_id', userId)
        .maybeSingle();

      if (refetchErr) throw refetchErr;
      if (refetched) {
        existingByUserId.set(userId, refetched);
        return upsertPendingParticipantForAttendance(supabaseAdmin, {
          matchId,
          candidate,
          requestedAt,
          reservaId,
          existingByUserId,
        });
      }
    }
    throw error;
  }

  existingByUserId.set(userId, data);
  return { ok: true, participant: data, created: true, preserved: false };
}

export async function syncPendingParticipantsForAttendance(supabaseAdmin, matchId, source = 'manual', {
  partido = null,
  scoreboard = null,
  reservaId = null,
  requestedAt = new Date().toISOString(),
} = {}) {
  const normalizedMatchId = normalizeMatchId(matchId);
  if (!normalizedMatchId) {
    return { ok: false, reason: 'invalid_match_id', synced: [] };
  }

  let partidoRow = partido;
  if (!partidoRow) {
    const { data, error } = await supabaseAdmin
      .from('partidos_abiertos')
      .select('id, capitan_user_id, equipos_asignacion, estado')
      .eq('id', Number(matchId))
      .maybeSingle();
    if (error) throw error;
    partidoRow = data;
  }

  const { candidates, skipped_no_user_id: skippedNoUserId } =
    await collectPendingParticipantCandidates(supabaseAdmin, {
      partido: partidoRow,
      scoreboard,
      source,
    });

  const existingParticipants = await listMatchParticipants(supabaseAdmin, {
    matchType: MATCH_TYPES.CASUAL,
    matchId: normalizedMatchId,
  });
  const existingByUserId = new Map(
    (existingParticipants ?? []).map((row) => [String(row.user_id), row]),
  );

  const synced = [];
  let inserted = 0;
  let updated = 0;
  let preserved = 0;

  for (const candidate of candidates) {
    const result = await upsertPendingParticipantForAttendance(supabaseAdmin, {
      matchId: normalizedMatchId,
      candidate,
      requestedAt,
      reservaId,
      existingByUserId,
    });

    if (result.ok) {
      synced.push(result.participant);
      if (result.preserved) preserved += 1;
      else if (result.created) inserted += 1;
      else updated += 1;
    }
  }

  return {
    ok: true,
    synced,
    inserted,
    updated,
    preserved,
    skipped_no_user_id: skippedNoUserId,
    identified_count: synced.length,
  };
}

export async function openAttendanceWindowForMatch(supabaseAdmin, matchId, options = {}) {
  const normalizedMatchId = normalizeMatchId(matchId);
  if (!normalizedMatchId) {
    return { ok: false, reason: 'invalid_match_id' };
  }

  const {
    partido: partidoInput = null,
    scoreboard = null,
    source = 'manual',
    hasClearResult = null,
    reservaId = null,
    now = new Date(),
  } = options;

  let partido = partidoInput;
  let schemaAttendanceColumnsAvailable = true;

  if (!partido) {
    const fetched = await fetchPartidoAttendanceRow(supabaseAdmin, normalizedMatchId);
    partido = fetched.partido;
    schemaAttendanceColumnsAvailable = fetched.schemaAttendanceColumnsAvailable;
  } else if (
    partido.attendance_collection_status == null
    && partido.attendance_opened_at === undefined
  ) {
    const fetched = await fetchPartidoAttendanceRow(supabaseAdmin, normalizedMatchId);
    if (fetched.partido) {
      partido = { ...fetched.partido, ...partido };
    }
    schemaAttendanceColumnsAvailable = fetched.schemaAttendanceColumnsAvailable;
  }

  if (!partido) {
    return { ok: false, reason: 'partido_no_encontrado' };
  }

  if (!schemaAttendanceColumnsAvailable) {
    return { ok: false, reason: 'schema_missing' };
  }

  const { featureEnabled } = await resolveAttendanceFeatureForPartido(supabaseAdmin, partido);
  if (!featureEnabled) {
    return { ok: false, reason: 'feature_disabled' };
  }

  if (isAttendanceWindowAlreadyActive(partido)) {
    return {
      ok: true,
      idempotent: true,
      opened: false,
      already_open: true,
      collection_status: normalizeAttendanceCollectionStatus(partido.attendance_collection_status),
      opened_at: partido.attendance_opened_at ?? null,
      deadline_at: partido.attendance_deadline_at ?? null,
      match_id: Number(partido.id),
    };
  }

  const resolvedHasClearResult = hasClearResult ?? (
    source === 'scoreboard'
      ? scoreboardHasClearResult(scoreboard ?? {})
      : partidoHasClearManualResult(partido)
  );

  if (!shouldOpenAttendanceWindow(partido, {
    hasClearResult: resolvedHasClearResult,
    featureEnabled,
  })) {
    return {
      ok: false,
      reason: resolvedHasClearResult ? 'window_not_applicable' : 'resultado_no_claro',
    };
  }

  const openedAt = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
  const deadlineAt = calculateAttendanceDeadline(openedAt);

  const syncResult = await syncPendingParticipantsForAttendance(
    supabaseAdmin,
    normalizedMatchId,
    source,
    {
      partido,
      scoreboard,
      reservaId,
      requestedAt: openedAt,
    },
  );

  const { data: updatedPartido, error: updateErr } = await supabaseAdmin
    .from('partidos_abiertos')
    .update({
      attendance_collection_status: MATCH_ATTENDANCE_COLLECTION_STATUS.OPEN,
      attendance_opened_at: openedAt,
      attendance_deadline_at: deadlineAt,
      attendance_resolved_at: null,
      attendance_resolution_reason: null,
      rewards_processed_at: null,
    })
    .eq('id', Number(partido.id))
    .eq('attendance_collection_status', MATCH_ATTENDANCE_COLLECTION_STATUS.NONE)
    .select(PARTIDOS_ATTENDANCE_SELECT)
    .maybeSingle();

  if (updateErr) throw updateErr;

  if (!updatedPartido) {
    const { partido: currentPartido } = await fetchPartidoAttendanceRow(
      supabaseAdmin,
      normalizedMatchId,
    );
    if (currentPartido && isAttendanceWindowAlreadyActive(currentPartido)) {
      return {
        ok: true,
        idempotent: true,
        opened: false,
        already_open: true,
        collection_status: normalizeAttendanceCollectionStatus(
          currentPartido.attendance_collection_status,
        ),
        opened_at: currentPartido.attendance_opened_at ?? null,
        deadline_at: currentPartido.attendance_deadline_at ?? null,
        match_id: Number(currentPartido.id),
        sync: syncResult,
      };
    }

    return { ok: false, reason: 'window_update_conflict' };
  }

  console.log(
    `[Attendance Fase 3.1] window opened partido=${partido.id} source=${source} participants=${syncResult.identified_count ?? 0} deadline=${deadlineAt}`,
  );

  const notificationResult = await notifyInitialAttendancePendingParticipants(
    supabaseAdmin,
    partido.id,
    {
      deadlineAt,
      partido: updatedPartido,
      participants: syncResult.synced,
      deps: {
        ...(options.deps ?? {}),
        ...(options.deps?.attendanceNotifications ?? {}),
      },
    },
  ).catch((err) => {
    console.warn(
      `[Attendance Fase 3.5] initial notifications failed partido=${partido.id}:`,
      err?.message ?? err,
    );
    return { ok: false, reason: 'notification_error', errors: 1 };
  });

  return {
    ok: true,
    opened: true,
    idempotent: false,
    already_open: false,
    attendance_pending: true,
    collection_status: MATCH_ATTENDANCE_COLLECTION_STATUS.OPEN,
    opened_at: openedAt,
    deadline_at: deadlineAt,
    match_id: Number(partido.id),
    sync: syncResult,
    notifications: notificationResult,
  };
}

export async function maybeDeferCasualRewardsForAttendance(supabaseAdmin, matchId, options = {}) {
  const partido = options.partido ?? null;
  if (partido) {
    const { featureEnabled } = await resolveAttendanceFeatureForPartido(supabaseAdmin, partido);
    if (!featureEnabled) {
      return { deferred: false, reason: 'feature_disabled' };
    }
  } else if (!isMatchAttendanceConfirmationEnabled()) {
    return { deferred: false, reason: 'feature_disabled' };
  }

  const result = await openAttendanceWindowForMatch(supabaseAdmin, matchId, options);

  if (result.ok && (result.opened || result.idempotent)) {
    return {
      deferred: true,
      attendance_pending: true,
      reason: result.opened ? 'attendance_window_opened' : 'attendance_window_already_open',
      attendance: result,
    };
  }

  if (result.ok === false) {
    console.warn(
      `[Attendance Fase 3.1] could not open window partido=${matchId} reason=${result.reason ?? 'unknown'}`,
    );
    return {
      deferred: true,
      attendance_pending: false,
      reason: result.reason ?? 'attendance_window_failed',
      attendance: result,
    };
  }

  return { deferred: false, reason: 'not_applicable', attendance: result };
}

export function normalizeAttendanceDenialReason(value, {
  maxLength = ATTENDANCE_DENIAL_REASON_MAX_LENGTH,
} = {}) {
  if (value == null) return null;
  const cleaned = String(value).replace(/\s+/g, ' ').trim();
  if (!cleaned) return null;
  return cleaned.slice(0, maxLength);
}

export function parsePlayerAttendanceResponseBody(body = {}) {
  const response = String(body?.response ?? '').trim().toLowerCase();
  if (response !== 'confirm' && response !== 'deny') {
    return { ok: false, reason: 'invalid_response' };
  }

  const targetStatus = response === 'confirm'
    ? MATCH_ATTENDANCE_STATUS.CONFIRMED
    : MATCH_ATTENDANCE_STATUS.DENIED;

  return {
    ok: true,
    response,
    targetStatus,
    denialReason: response === 'deny'
      ? normalizeAttendanceDenialReason(body?.reason)
      : null,
  };
}

export function isAttendanceDeadlineExpired(deadlineAt, now = new Date()) {
  if (!deadlineAt) return false;
  const deadlineMs = new Date(deadlineAt).getTime();
  const nowMs = now instanceof Date ? now.getTime() : new Date(now).getTime();
  return Number.isFinite(deadlineMs) && deadlineMs <= nowMs;
}

const PLAYER_RESPONSE_BLOCKED_COLLECTION_STATUSES = new Set([
  MATCH_ATTENDANCE_COLLECTION_STATUS.NONE,
  MATCH_ATTENDANCE_COLLECTION_STATUS.EXPIRED,
  MATCH_ATTENDANCE_COLLECTION_STATUS.READY,
  MATCH_ATTENDANCE_COLLECTION_STATUS.CREDITED,
  MATCH_ATTENDANCE_COLLECTION_STATUS.BLOCKED,
]);

export function validatePlayerAttendanceSubmission({
  featureEnabled,
  schemaAvailable,
  collectionStatus,
  deadlineAt,
  participant,
  rewardsProcessedAt = null,
  now = new Date(),
} = {}) {
  if (!schemaAvailable) {
    return { ok: false, httpStatus: 503, reason: 'schema_missing' };
  }

  if (!featureEnabled) {
    return { ok: false, httpStatus: 409, reason: 'feature_disabled' };
  }

  if (!participant?.id) {
    return { ok: false, httpStatus: 404, reason: 'participant_not_found' };
  }

  const normalizedCollection = normalizeAttendanceCollectionStatus(collectionStatus);
  if (PLAYER_RESPONSE_BLOCKED_COLLECTION_STATUSES.has(normalizedCollection)) {
    return {
      ok: false,
      httpStatus: 409,
      reason: normalizedCollection === MATCH_ATTENDANCE_COLLECTION_STATUS.EXPIRED
        ? 'window_expired'
        : 'window_not_open',
    };
  }

  if (normalizedCollection !== MATCH_ATTENDANCE_COLLECTION_STATUS.OPEN) {
    return { ok: false, httpStatus: 409, reason: 'window_not_open' };
  }

  if (isAttendanceDeadlineExpired(deadlineAt, now)) {
    return { ok: false, httpStatus: 409, reason: 'deadline_expired' };
  }

  if (rewardsProcessedAt) {
    return { ok: false, httpStatus: 409, reason: 'rewards_already_processed' };
  }

  const currentStatus = normalizeAttendanceStatus(participant.attendance_status);
  if (
    currentStatus === MATCH_ATTENDANCE_STATUS.ADMIN_VALIDATED
    || currentStatus === MATCH_ATTENDANCE_STATUS.EXCLUDED
  ) {
    return { ok: false, httpStatus: 409, reason: 'status_locked' };
  }

  return { ok: true };
}

export function isSamePlayerAttendanceResponse(participant, targetStatus, denialReason = null) {
  if (!participant) return false;

  const currentStatus = normalizeAttendanceStatus(participant.attendance_status);
  if (currentStatus !== targetStatus) return false;

  if (targetStatus === MATCH_ATTENDANCE_STATUS.DENIED) {
    return (participant.attendance_denial_reason ?? null) === (denialReason ?? null)
      && participant.attendance_response_source === MATCH_ATTENDANCE_RESPONSE_SOURCE.PLAYER;
  }

  return currentStatus === MATCH_ATTENDANCE_STATUS.CONFIRMED
    && participant.attendance_response_source === MATCH_ATTENDANCE_RESPONSE_SOURCE.PLAYER;
}

export function buildPlayerAttendanceUpdatePayload(targetStatus, {
  denialReason = null,
  now = new Date(),
} = {}) {
  const respondedAt = now instanceof Date ? now.toISOString() : new Date(now).toISOString();

  if (targetStatus === MATCH_ATTENDANCE_STATUS.CONFIRMED) {
    return {
      attendance_status: MATCH_ATTENDANCE_STATUS.CONFIRMED,
      attendance_confirmed_at: respondedAt,
      attendance_responded_at: respondedAt,
      attendance_response_source: MATCH_ATTENDANCE_RESPONSE_SOURCE.PLAYER,
      attendance_denial_reason: null,
      updated_at: respondedAt,
    };
  }

  return {
    attendance_status: MATCH_ATTENDANCE_STATUS.DENIED,
    attendance_confirmed_at: null,
    attendance_responded_at: respondedAt,
    attendance_response_source: MATCH_ATTENDANCE_RESPONSE_SOURCE.PLAYER,
    attendance_denial_reason: denialReason,
    updated_at: respondedAt,
  };
}

export function computeNextAttendanceCollectionTransition(participants = [], {
  readyResolutionReason = MATCH_ATTENDANCE_RESOLUTION_REASON.ALL_RESPONDED,
} = {}) {
  const counts = countParticipantsByAttendanceStatus(participants);

  if (counts.pending > 0) {
    return {
      shouldTransition: false,
      collection_status: MATCH_ATTENDANCE_COLLECTION_STATUS.OPEN,
      resolution_reason: null,
    };
  }

  if (counts.confirmed > 0 || counts.admin_validated > 0) {
    return {
      shouldTransition: true,
      collection_status: MATCH_ATTENDANCE_COLLECTION_STATUS.READY,
      resolution_reason: readyResolutionReason,
    };
  }

  return {
    shouldTransition: true,
    collection_status: MATCH_ATTENDANCE_COLLECTION_STATUS.BLOCKED,
    resolution_reason: MATCH_ATTENDANCE_RESOLUTION_REASON.NO_ELIGIBLE_PARTICIPANTS,
  };
}

export function computeAttendanceCollectionTransitionAfterTimeout(participants = []) {
  return computeNextAttendanceCollectionTransition(participants, {
    readyResolutionReason: MATCH_ATTENDANCE_RESOLUTION_REASON.TIMEOUT_PARTIAL,
  });
}

function buildPendingTimeoutExclusionPayload(now = new Date()) {
  const respondedAt = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
  return {
    attendance_status: MATCH_ATTENDANCE_STATUS.EXCLUDED,
    attendance_confirmed_at: null,
    attendance_responded_at: respondedAt,
    attendance_response_source: MATCH_ATTENDANCE_RESPONSE_SOURCE.SYSTEM_TIMEOUT,
    attendance_denial_reason: null,
    updated_at: respondedAt,
  };
}

function shouldSkipExpiredAttendancePartido(partido = {}) {
  if (!partido) {
    return { skip: true, reason: 'partido_no_encontrado' };
  }

  if (partido.partido_torneo_id != null || partido.torneo_id != null) {
    return { skip: true, reason: 'torneo_out_of_scope' };
  }

  if (String(partido.estado ?? '').trim().toLowerCase() === 'cancelado') {
    return { skip: true, reason: 'partido_cancelado' };
  }

  return { skip: false };
}

async function excludePendingParticipantsForTimeout(supabaseAdmin, matchId, {
  now = new Date(),
} = {}) {
  const normalizedMatchId = normalizeMatchId(matchId);
  if (!normalizedMatchId) {
    return { ok: false, reason: 'invalid_match_id', excluded_count: 0, participants: [] };
  }

  const updatePayload = buildPendingTimeoutExclusionPayload(now);
  const { data, error } = await supabaseAdmin
    .from('match_participants')
    .update(updatePayload)
    .eq('match_type', MATCH_TYPES.CASUAL)
    .eq('match_id', normalizedMatchId)
    .eq('attendance_status', MATCH_ATTENDANCE_STATUS.PENDING)
    .select(PARTICIPANTS_ATTENDANCE_SELECT);

  if (error) {
    if (isMissingMatchAttendanceColumnError(error)) {
      return { ok: false, reason: 'schema_missing', excluded_count: 0, participants: [] };
    }
    throw error;
  }

  return {
    ok: true,
    excluded_count: (data ?? []).length,
    participants: data ?? [],
  };
}

async function transitionOpenAttendanceWindowAfterTimeout(supabaseAdmin, matchId, participants, {
  now = new Date(),
} = {}) {
  const transition = computeAttendanceCollectionTransitionAfterTimeout(participants);
  if (!transition.shouldTransition) {
    return {
      ok: true,
      changed: false,
      collection_status: MATCH_ATTENDANCE_COLLECTION_STATUS.OPEN,
      resolution_reason: null,
    };
  }

  const resolvedAt = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
  const { data: updatedPartido, error } = await supabaseAdmin
    .from('partidos_abiertos')
    .update({
      attendance_collection_status: transition.collection_status,
      attendance_resolved_at: resolvedAt,
      attendance_resolution_reason: transition.resolution_reason,
    })
    .eq('id', Number(matchId))
    .eq('attendance_collection_status', MATCH_ATTENDANCE_COLLECTION_STATUS.OPEN)
    .select(PARTIDOS_ATTENDANCE_SELECT)
    .maybeSingle();

  if (error) throw error;

  if (!updatedPartido) {
    const refreshed = await getMatchAttendanceState(supabaseAdmin, matchId);
    return {
      ok: true,
      changed: false,
      idempotent: true,
      collection_status: refreshed.partidoFields?.collection_status ?? null,
      resolution_reason: refreshed.partidoFields?.resolution_reason ?? null,
      partidoFields: refreshed.partidoFields ?? null,
      summary: refreshed.summary ?? null,
    };
  }

  const partidoFields = normalizePartidoAttendanceFields(updatedPartido, {
    schemaAttendanceColumnsAvailable: true,
  });
  const { participants: refreshedParticipants } = await fetchParticipantsForAttendance(
    supabaseAdmin,
    matchId,
  );

  return {
    ok: true,
    changed: true,
    collection_status: transition.collection_status,
    resolution_reason: transition.resolution_reason,
    partidoFields,
    summary: buildMatchAttendanceSummary(partidoFields, refreshedParticipants),
  };
}

const EXPIRED_ATTENDANCE_WINDOWS_SELECT =
  `${PARTIDOS_ATTENDANCE_SELECT}, estado, partido_torneo_id, torneo_id`;

export async function fetchExpiredOpenAttendanceWindows(supabaseAdmin, {
  now = new Date(),
  limit = getMatchAttendanceCronBatchSize(),
} = {}) {
  const nowIso = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
  const effectiveLimit = Number.isFinite(Number(limit)) && Number(limit) > 0
    ? Math.floor(Number(limit))
    : getMatchAttendanceCronBatchSize();

  const { data, error } = await supabaseAdmin
    .from('partidos_abiertos')
    .select(EXPIRED_ATTENDANCE_WINDOWS_SELECT)
    .eq('attendance_collection_status', MATCH_ATTENDANCE_COLLECTION_STATUS.OPEN)
    .lte('attendance_deadline_at', nowIso)
    .is('partido_torneo_id', null)
    .is('torneo_id', null)
    .order('attendance_deadline_at', { ascending: true })
    .limit(effectiveLimit);

  if (error) {
    if (isMissingMatchAttendanceColumnError(error)) {
      return [];
    }
    throw error;
  }

  return (data ?? []).filter((partido) => {
    const skip = shouldSkipExpiredAttendancePartido(partido);
    return !skip.skip;
  });
}

/**
 * Expira una ventana open vencida: pending → excluded, resuelve ready/blocked y acredita si aplica.
 */
export async function expireAttendanceWindow(supabaseAdmin, matchId, options = {}) {
  const {
    now = new Date(),
    partido: partidoInput = null,
    deps = {},
  } = options;

  let partido = partidoInput;
  let schemaAttendanceColumnsAvailable = true;

  if (!partido) {
    const fetched = await fetchPartidoForAttendanceRewards(supabaseAdmin, matchId);
    partido = fetched.partido;
    schemaAttendanceColumnsAvailable = fetched.schemaAttendanceColumnsAvailable;
  } else if (partido.attendance_collection_status == null) {
    const fetched = await fetchPartidoForAttendanceRewards(supabaseAdmin, matchId);
    if (fetched.partido) {
      partido = { ...fetched.partido, ...partido };
    }
    schemaAttendanceColumnsAvailable = fetched.schemaAttendanceColumnsAvailable;
  }

  if (!partido) {
    return {
      ok: false,
      skipped: true,
      reason: 'partido_no_encontrado',
      match_id: Number(matchId) || null,
    };
  }

  if (!schemaAttendanceColumnsAvailable) {
    return {
      ok: false,
      skipped: true,
      reason: 'schema_missing',
      match_id: Number(partido.id),
    };
  }

  const partidoSkip = shouldSkipExpiredAttendancePartido(partido);
  if (partidoSkip.skip) {
    return {
      ok: true,
      skipped: true,
      reason: partidoSkip.reason,
      match_id: Number(partido.id),
    };
  }

  const { sedeEnabled, featureEnabled } = await resolveAttendanceFeatureForPartido(
    supabaseAdmin,
    partido,
  );
  const partidoFields = normalizePartidoAttendanceFields(partido, {
    schemaAttendanceColumnsAvailable: true,
    sedeAttendanceConfirmationEnabled: sedeEnabled,
  });
  partidoFields.feature_enabled = featureEnabled;

  if (!featureEnabled) {
    return {
      ok: true,
      skipped: true,
      reason: 'feature_disabled',
      match_id: Number(partido.id),
    };
  }

  const collectionStatus = partidoFields.collection_status;
  if (collectionStatus !== MATCH_ATTENDANCE_COLLECTION_STATUS.OPEN) {
    return {
      ok: true,
      skipped: true,
      idempotent: true,
      reason: 'not_open',
      match_id: Number(partido.id),
      collection_status: collectionStatus,
    };
  }

  if (!isAttendanceDeadlineExpired(partidoFields.deadline_at, now)) {
    return {
      ok: true,
      skipped: true,
      reason: 'not_expired',
      match_id: Number(partido.id),
    };
  }

  const exclusion = await excludePendingParticipantsForTimeout(supabaseAdmin, partido.id, { now });
  if (!exclusion.ok) {
    return {
      ok: false,
      skipped: true,
      reason: exclusion.reason ?? 'exclusion_failed',
      match_id: Number(partido.id),
    };
  }

  const { participants } = await fetchParticipantsForAttendance(supabaseAdmin, partido.id);
  const transitionResult = await transitionOpenAttendanceWindowAfterTimeout(
    supabaseAdmin,
    partido.id,
    participants,
    { now },
  );

  let partidoFieldsAfter = transitionResult.partidoFields
    ?? normalizePartidoAttendanceFields(partido, { schemaAttendanceColumnsAvailable: true });
  let summaryAfter = transitionResult.summary;
  let rewards = null;
  let credited = false;

  if (partidoFieldsAfter.collection_status === MATCH_ATTENDANCE_COLLECTION_STATUS.READY) {
    const finalizeFn = deps.tryFinalizeMatchAttendanceRewards ?? tryFinalizeMatchAttendanceRewards;
    const finalizeResult = await finalizeFn(supabaseAdmin, partido.id, { now, deps });
    rewards = finalizeResult.rewards ?? null;
    credited = finalizeResult.credited === true;

    const refreshed = await getMatchAttendanceState(supabaseAdmin, partido.id);
    if (refreshed.ok) {
      partidoFieldsAfter = refreshed.partidoFields;
      summaryAfter = refreshed.summary;
    } else if (finalizeResult.partidoFields) {
      partidoFieldsAfter = finalizeResult.partidoFields;
      summaryAfter = finalizeResult.summary ?? summaryAfter;
    }
  }

  console.log(
    `[Attendance Fase 3.4] expired partido=${partido.id} excluded=${exclusion.excluded_count} status=${partidoFieldsAfter.collection_status} credited=${credited}`,
  );

  return {
    ok: true,
    expired: true,
    match_id: Number(partido.id),
    pending_excluded: exclusion.excluded_count,
    changed: transitionResult.changed === true,
    idempotent: transitionResult.idempotent === true,
    collection_status: partidoFieldsAfter.collection_status,
    resolution_reason: partidoFieldsAfter.resolution_reason,
    partidoFields: partidoFieldsAfter,
    summary: summaryAfter,
    credited,
    rewards,
  };
}

export async function processExpiredAttendanceWindows(supabaseAdmin, options = {}) {
  const {
    now = new Date(),
    batchSize = getMatchAttendanceCronBatchSize(),
    deps = {},
  } = options;

  const summary = {
    ok: true,
    examined: 0,
    expired: 0,
    ready: 0,
    credited: 0,
    blocked: 0,
    errors: 0,
    skipped: 0,
  };

  const matches = await fetchExpiredOpenAttendanceWindows(supabaseAdmin, {
    now,
    limit: batchSize,
  });
  summary.examined = matches.length;

  for (const match of matches) {
    try {
      const result = await expireAttendanceWindow(supabaseAdmin, match.id, {
        now,
        partido: match,
        deps,
      });

      if (result.skipped) {
        summary.skipped += 1;
        continue;
      }

      if (!result.expired) {
        continue;
      }

      summary.expired += 1;
      const finalStatus = result.partidoFields?.collection_status ?? result.collection_status;

      if (finalStatus === MATCH_ATTENDANCE_COLLECTION_STATUS.CREDITED || result.credited) {
        summary.credited += 1;
      } else if (finalStatus === MATCH_ATTENDANCE_COLLECTION_STATUS.READY) {
        summary.ready += 1;
      } else if (finalStatus === MATCH_ATTENDANCE_COLLECTION_STATUS.BLOCKED) {
        summary.blocked += 1;
      }
    } catch (err) {
      summary.errors += 1;
      console.error(
        `[Attendance Fase 3.4] batch error partido=${match.id}:`,
        err?.message ?? err,
      );
    }
  }

  if (summary.expired > 0 || summary.errors > 0) {
    console.log(
      `[Attendance Fase 3.4] batch examined=${summary.examined} expired=${summary.expired} ready=${summary.ready} credited=${summary.credited} blocked=${summary.blocked} errors=${summary.errors}`,
    );
  }

  return summary;
}

export async function evaluateAttendanceCollectionState(supabaseAdmin, matchId, {
  now = new Date(),
} = {}) {
  const state = await getMatchAttendanceState(supabaseAdmin, matchId);
  if (!state.ok) {
    return state;
  }

  if (state.partidoFields.schema_attendance_columns_available !== true) {
    return { ok: false, reason: 'schema_missing' };
  }

  if (state.partidoFields.collection_status !== MATCH_ATTENDANCE_COLLECTION_STATUS.OPEN) {
    return {
      ok: true,
      changed: false,
      partidoFields: state.partidoFields,
      summary: state.summary,
    };
  }

  const transition = computeNextAttendanceCollectionTransition(state.participants);
  if (!transition.shouldTransition) {
    return {
      ok: true,
      changed: false,
      partidoFields: state.partidoFields,
      summary: state.summary,
    };
  }

  const resolvedAt = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
  const { data: updatedPartido, error } = await supabaseAdmin
    .from('partidos_abiertos')
    .update({
      attendance_collection_status: transition.collection_status,
      attendance_resolved_at: resolvedAt,
      attendance_resolution_reason: transition.resolution_reason,
    })
    .eq('id', Number(matchId))
    .eq('attendance_collection_status', MATCH_ATTENDANCE_COLLECTION_STATUS.OPEN)
    .select(PARTIDOS_ATTENDANCE_SELECT)
    .maybeSingle();

  if (error) throw error;

  if (!updatedPartido) {
    const refreshed = await getMatchAttendanceState(supabaseAdmin, matchId);
    return {
      ok: true,
      changed: false,
      partidoFields: refreshed.partidoFields,
      summary: refreshed.summary,
    };
  }

  const partidoFields = normalizePartidoAttendanceFields(updatedPartido, {
    schemaAttendanceColumnsAvailable: true,
  });
  const { participants } = await fetchParticipantsForAttendance(supabaseAdmin, matchId);

  return {
    ok: true,
    changed: true,
    partidoFields,
    summary: buildMatchAttendanceSummary(partidoFields, participants),
  };
}

const PADCOINS_ACCEPTABLE_SKIP_REASONS = new Set([
  'reserva_ya_acreditada_legacy',
  'sede_no_participa',
  'estado_no_acreditable',
  'reserva_no_acreditable',
  'monto_cero',
  'sin_shares',
  'sin_reserva_vinculada',
]);

const PADCOINS_CREDIT_SOFT_REASONS = new Set([
  'ya_acreditado_event',
]);

const RANKING_CREDIT_SOFT_REASONS = new Set([
  'ya_acreditado_event',
]);

export function buildAttendanceRewardsResponse({
  processed = false,
  padcoins = { ok: false, reason: 'not_attempted' },
  ranking = { ok: false, reason: 'not_attempted' },
} = {}) {
  return {
    processed: processed === true,
    padcoins: {
      ok: padcoins.ok === true,
      reason: padcoins.reason ?? null,
    },
    ranking: {
      ok: ranking.ok === true,
      reason: ranking.reason ?? null,
    },
  };
}

export function evaluatePadcoinsBranchResult(result = {}) {
  if (result?.ok === false) {
    return { ok: false, reason: result.reason ?? 'padcoins_failed' };
  }

  if (result.acreditado === true) {
    return { ok: true, reason: 'credited' };
  }

  const credits = Array.isArray(result.credits) ? result.credits : [];
  if (credits.length > 0) {
    const hasHardFailure = credits.some(
      (credit) => credit.acreditado !== true && !PADCOINS_CREDIT_SOFT_REASONS.has(credit.reason),
    );
    if (hasHardFailure) {
      return { ok: false, reason: 'padcoins_credit_failed' };
    }

    const hasSuccess = credits.some((credit) => credit.acreditado === true);
    const allDuplicate = credits.every((credit) => credit.reason === 'ya_acreditado_event');
    if (hasSuccess || allDuplicate) {
      return { ok: true, reason: hasSuccess ? 'credited' : 'already_credited' };
    }

    return { ok: false, reason: 'padcoins_not_credited' };
  }

  if (PADCOINS_ACCEPTABLE_SKIP_REASONS.has(result.reason)) {
    return { ok: true, reason: result.reason };
  }

  if (result.reason === 'sin_participantes_elegibles') {
    return { ok: false, reason: result.reason };
  }

  return { ok: false, reason: result.reason ?? 'padcoins_not_credited' };
}

export function evaluateRankingBranchResult(result = {}) {
  if (result?.ok === false) {
    return { ok: false, reason: result.reason ?? 'ranking_failed' };
  }

  if (result.skipped === true && result.reason === 'torneo_out_of_scope') {
    return { ok: true, reason: result.reason };
  }

  if (result.acreditado === true) {
    return { ok: true, reason: 'credited' };
  }

  const credits = Array.isArray(result.credits) ? result.credits : [];
  if (credits.length > 0) {
    const hasHardFailure = credits.some(
      (credit) => credit.acreditado !== true && !RANKING_CREDIT_SOFT_REASONS.has(credit.reason),
    );
    if (hasHardFailure) {
      const recoverable = credits.some((credit) => credit.recoverable === true);
      return {
        ok: false,
        reason: recoverable ? 'ranking_recoverable_failure' : 'ranking_credit_failed',
      };
    }

    const hasSuccess = credits.some((credit) => credit.acreditado === true);
    const allDuplicate = credits.every((credit) => credit.reason === 'ya_acreditado_event');
    if (hasSuccess || allDuplicate) {
      return { ok: true, reason: hasSuccess ? 'credited' : 'already_credited' };
    }

    return { ok: false, reason: 'ranking_not_credited' };
  }

  if (result.reason === 'sin_resultado_claro' || result.reason === 'partido_no_finalizado') {
    return { ok: false, reason: result.reason };
  }

  if (result.reason === 'sin_participantes_elegibles') {
    return { ok: false, reason: result.reason };
  }

  return { ok: false, reason: result.reason ?? 'ranking_not_credited' };
}

async function fetchReservaForAttendanceRewards(supabaseAdmin, partido = {}) {
  if (partido?.reserva_id != null) {
    const { data, error } = await supabaseAdmin
      .from('reservas')
      .select('id, user_id, sede_id, sede, estado, fecha, hora, hora_fin, hora_inicio, partido_id, precio, precio_esperado, monto_pagado, moneda, pago_estado')
      .eq('id', Number(partido.reserva_id))
      .maybeSingle();

    if (error) throw error;
    if (data) return data;
  }

  if (partido?.id == null) {
    return null;
  }

  const { data, error } = await supabaseAdmin
    .from('reservas')
    .select('id, user_id, sede_id, sede, estado, fecha, hora, hora_fin, hora_inicio, partido_id, precio, precio_esperado, monto_pagado, moneda, pago_estado')
    .eq('partido_id', partido.id)
    .maybeSingle();

  if (error) throw error;
  return data ?? null;
}

async function fetchTerminatedScoreboardForPartido(supabaseAdmin, partidoId) {
  const normalizedPartidoId = Number(partidoId);
  if (!Number.isFinite(normalizedPartidoId) || normalizedPartidoId <= 0) {
    return null;
  }

  const { data, error } = await supabaseAdmin
    .from('scoreboard_partidos')
    .select('*')
    .eq('partido_abierto_id', normalizedPartidoId)
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  if (!data) return null;
  if (!isScoreboardEstadoTerminado(data.estado)) {
    return null;
  }

  return data;
}

async function fetchPartidoForAttendanceRewards(supabaseAdmin, matchId) {
  const normalizedMatchId = Number(matchId);
  if (!Number.isFinite(normalizedMatchId) || normalizedMatchId <= 0) {
    return { partido: null, schemaAttendanceColumnsAvailable: false };
  }

  const { data, error } = await supabaseAdmin
    .from('partidos_abiertos')
    .select(PARTIDOS_ATTENDANCE_REWARDS_SELECT)
    .eq('id', normalizedMatchId)
    .maybeSingle();

  if (error) {
    if (isMissingMatchAttendanceColumnError(error)) {
      return { partido: null, schemaAttendanceColumnsAvailable: false };
    }
    throw error;
  }

  return {
    partido: data ?? null,
    schemaAttendanceColumnsAvailable: true,
  };
}

function isCasualMatchForAttendanceRewards(partido = {}) {
  if (partido.partido_torneo_id != null || partido.torneo_id != null) {
    return false;
  }
  return true;
}

async function blockReadyMatchForNoEligibleParticipants(supabaseAdmin, matchId, {
  now = new Date(),
} = {}) {
  const resolvedAt = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
  const { data, error } = await supabaseAdmin
    .from('partidos_abiertos')
    .update({
      attendance_collection_status: MATCH_ATTENDANCE_COLLECTION_STATUS.BLOCKED,
      attendance_resolution_reason: MATCH_ATTENDANCE_RESOLUTION_REASON.NO_ELIGIBLE_PARTICIPANTS,
      attendance_resolved_at: resolvedAt,
    })
    .eq('id', Number(matchId))
    .eq('attendance_collection_status', MATCH_ATTENDANCE_COLLECTION_STATUS.READY)
    .select(PARTIDOS_ATTENDANCE_SELECT)
    .maybeSingle();

  if (error) throw error;
  return data ?? null;
}

async function markMatchAttendanceRewardsCredited(supabaseAdmin, matchId, partidoFields, {
  now = new Date(),
} = {}) {
  const processedAt = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
  const updatePayload = {
    attendance_collection_status: MATCH_ATTENDANCE_COLLECTION_STATUS.CREDITED,
    rewards_processed_at: processedAt,
  };

  if (!partidoFields?.resolved_at) {
    updatePayload.attendance_resolved_at = processedAt;
  }

  const { data, error } = await supabaseAdmin
    .from('partidos_abiertos')
    .update(updatePayload)
    .eq('id', Number(matchId))
    .eq('attendance_collection_status', MATCH_ATTENDANCE_COLLECTION_STATUS.READY)
    .select(PARTIDOS_ATTENDANCE_SELECT)
    .maybeSingle();

  if (error) throw error;

  if (data) {
    return {
      credited: true,
      idempotent: false,
      partidoFields: normalizePartidoAttendanceFields(data, {
        schemaAttendanceColumnsAvailable: true,
      }),
    };
  }

  const refreshed = await getMatchAttendanceState(supabaseAdmin, matchId);
  const refreshedStatus = refreshed.partidoFields?.collection_status;
  return {
    credited: refreshedStatus === MATCH_ATTENDANCE_COLLECTION_STATUS.CREDITED,
    idempotent: refreshedStatus === MATCH_ATTENDANCE_COLLECTION_STATUS.CREDITED,
    partidoFields: refreshed.partidoFields ?? partidoFields,
  };
}

async function processRankingForAttendanceRewards(supabaseAdmin, {
  partido,
  reservaId = null,
  scoreboard = null,
  deps = {},
} = {}) {
  const rankingAfterScoreboard = deps.processCasualMatchRankingAfterScoreboardFinished
    ?? processCasualMatchRankingAfterScoreboardFinished;
  const rankingAfterManual = deps.processCasualMatchRankingAfterResultConfirmed
    ?? processCasualMatchRankingAfterResultConfirmed;

  if (scoreboard) {
    return rankingAfterScoreboard(supabaseAdmin, {
      scoreboard,
      partidoId: partido.id,
      reservaId,
    });
  }

  return rankingAfterManual(supabaseAdmin, partido.id, {
    partido,
    reservaId,
  });
}

/**
 * Orquestador Fase 3.3: acredita PadCoins + Ranking cuando la ventana queda ready.
 */
export async function tryFinalizeMatchAttendanceRewards(supabaseAdmin, matchId, options = {}) {
  const {
    now = new Date(),
    scoreboard: scoreboardInput = null,
    deps = {},
  } = options;

  const state = await getMatchAttendanceState(supabaseAdmin, matchId);
  if (!state.ok) {
    return {
      ok: false,
      skipped: true,
      reason: state.reason ?? 'partido_no_encontrado',
      rewards: buildAttendanceRewardsResponse({
        padcoins: { ok: false, reason: state.reason ?? 'partido_no_encontrado' },
        ranking: { ok: false, reason: state.reason ?? 'partido_no_encontrado' },
      }),
    };
  }

  const { partidoFields, participants, summary } = state;

  if (partidoFields.schema_attendance_columns_available !== true) {
    return {
      ok: false,
      skipped: true,
      reason: 'schema_missing',
      rewards: buildAttendanceRewardsResponse({
        padcoins: { ok: false, reason: 'schema_missing' },
        ranking: { ok: false, reason: 'schema_missing' },
      }),
    };
  }

  if (!partidoFields.feature_enabled) {
    return {
      ok: true,
      skipped: true,
      reason: 'feature_disabled',
      rewards: buildAttendanceRewardsResponse({
        padcoins: { ok: false, reason: 'feature_disabled' },
        ranking: { ok: false, reason: 'feature_disabled' },
      }),
    };
  }

  const { partido: rewardsPartido } = await fetchPartidoForAttendanceRewards(supabaseAdmin, matchId);
  if (!rewardsPartido) {
    return {
      ok: false,
      skipped: true,
      reason: 'partido_no_encontrado',
      rewards: buildAttendanceRewardsResponse({
        padcoins: { ok: false, reason: 'partido_no_encontrado' },
        ranking: { ok: false, reason: 'partido_no_encontrado' },
      }),
    };
  }

  if (!isCasualMatchForAttendanceRewards(rewardsPartido)) {
    return {
      ok: true,
      skipped: true,
      reason: 'torneo_out_of_scope',
      rewards: buildAttendanceRewardsResponse({
        padcoins: { ok: false, reason: 'torneo_out_of_scope' },
        ranking: { ok: false, reason: 'torneo_out_of_scope' },
      }),
    };
  }

  if (String(rewardsPartido.estado ?? '').trim().toLowerCase() === 'cancelado') {
    return {
      ok: true,
      skipped: true,
      reason: 'partido_cancelado',
      rewards: buildAttendanceRewardsResponse({
        padcoins: { ok: false, reason: 'partido_cancelado' },
        ranking: { ok: false, reason: 'partido_cancelado' },
      }),
    };
  }

  if (partidoFields.collection_status === MATCH_ATTENDANCE_COLLECTION_STATUS.CREDITED
    || partidoFields.rewards_processed_at) {
    return {
      ok: true,
      skipped: true,
      idempotent: true,
      reason: 'already_credited',
      partidoFields,
      summary,
      rewards: buildAttendanceRewardsResponse({
        processed: true,
        padcoins: { ok: true, reason: 'already_credited' },
        ranking: { ok: true, reason: 'already_credited' },
      }),
    };
  }

  if (partidoFields.collection_status === MATCH_ATTENDANCE_COLLECTION_STATUS.BLOCKED) {
    return {
      ok: true,
      skipped: true,
      reason: 'blocked',
      partidoFields,
      summary,
      rewards: buildAttendanceRewardsResponse({
        padcoins: { ok: false, reason: 'blocked' },
        ranking: { ok: false, reason: 'blocked' },
      }),
    };
  }

  if (partidoFields.collection_status !== MATCH_ATTENDANCE_COLLECTION_STATUS.READY) {
    return {
      ok: true,
      skipped: true,
      reason: 'not_ready',
      partidoFields,
      summary,
      rewards: buildAttendanceRewardsResponse({
        padcoins: { ok: false, reason: 'not_ready' },
        ranking: { ok: false, reason: 'not_ready' },
      }),
    };
  }

  const eligibleParticipants = getEligibleParticipantsForRewards(participants);
  if (!eligibleParticipants.length) {
    const blockedPartido = await blockReadyMatchForNoEligibleParticipants(supabaseAdmin, matchId, { now });
    const refreshed = blockedPartido
      ? normalizePartidoAttendanceFields(blockedPartido, { schemaAttendanceColumnsAvailable: true })
      : partidoFields;

    return {
      ok: true,
      blocked: true,
      reason: MATCH_ATTENDANCE_RESOLUTION_REASON.NO_ELIGIBLE_PARTICIPANTS,
      partidoFields: refreshed,
      rewards: buildAttendanceRewardsResponse({
        padcoins: { ok: false, reason: MATCH_ATTENDANCE_RESOLUTION_REASON.NO_ELIGIBLE_PARTICIPANTS },
        ranking: { ok: false, reason: MATCH_ATTENDANCE_RESOLUTION_REASON.NO_ELIGIBLE_PARTICIPANTS },
      }),
    };
  }

  const refreshedState = await getMatchAttendanceState(supabaseAdmin, matchId);
  if (refreshedState.ok) {
    const refreshedStatus = refreshedState.partidoFields.collection_status;
    if (refreshedStatus !== MATCH_ATTENDANCE_COLLECTION_STATUS.READY) {
      if (refreshedStatus === MATCH_ATTENDANCE_COLLECTION_STATUS.CREDITED
        || refreshedState.partidoFields.rewards_processed_at) {
        return {
          ok: true,
          skipped: true,
          idempotent: true,
          reason: 'already_credited',
          partidoFields: refreshedState.partidoFields,
          summary: refreshedState.summary,
          rewards: buildAttendanceRewardsResponse({
            processed: true,
            padcoins: { ok: true, reason: 'already_credited' },
            ranking: { ok: true, reason: 'already_credited' },
          }),
        };
      }

      return {
        ok: true,
        skipped: true,
        reason: 'state_changed',
        partidoFields: refreshedState.partidoFields,
        summary: refreshedState.summary,
        rewards: buildAttendanceRewardsResponse({
          padcoins: { ok: false, reason: 'state_changed' },
          ranking: { ok: false, reason: 'state_changed' },
        }),
      };
    }

    if (String(refreshedState.partido?.estado ?? rewardsPartido.estado ?? '').trim().toLowerCase() === 'cancelado') {
      return {
        ok: true,
        skipped: true,
        reason: 'partido_cancelado',
        partidoFields: refreshedState.partidoFields,
        summary: refreshedState.summary,
        rewards: buildAttendanceRewardsResponse({
          padcoins: { ok: false, reason: 'partido_cancelado' },
          ranking: { ok: false, reason: 'partido_cancelado' },
        }),
      };
    }
  }

  const fetchReserva = deps.fetchReservaForPartido ?? fetchReservaForAttendanceRewards;
  const reserva = await fetchReserva(supabaseAdmin, rewardsPartido);

  const fetchScoreboard = deps.fetchTerminatedScoreboardForPartido ?? fetchTerminatedScoreboardForPartido;
  const scoreboard = scoreboardInput ?? await fetchScoreboard(supabaseAdmin, matchId);

  const creditPadcoins = deps.creditValidatedMatchPadcoins ?? creditValidatedMatchPadcoins;

  let padcoinsRaw = { ok: true, acreditado: false, reason: 'sin_reserva_vinculada' };
  if (reserva?.id) {
    try {
      padcoinsRaw = await creditPadcoins(supabaseAdmin, {
        matchId: normalizeMatchId(matchId),
        reserva,
        organizerUserId: reserva.user_id,
      });
    } catch (err) {
      console.error(
        `[Attendance Fase 3.3] PadCoins error partido=${matchId}:`,
        err?.message ?? err,
      );
      padcoinsRaw = { ok: false, reason: 'padcoins_exception' };
    }
  }

  let rankingRaw = { ok: true, acreditado: false, reason: 'ranking_not_attempted' };
  try {
    rankingRaw = await processRankingForAttendanceRewards(supabaseAdmin, {
      partido: rewardsPartido,
      reservaId: reserva?.id ?? rewardsPartido.reserva_id ?? null,
      scoreboard,
      deps,
    });
  } catch (err) {
    console.error(
      `[Attendance Fase 3.3] Ranking error partido=${matchId}:`,
      err?.message ?? err,
    );
    rankingRaw = { ok: false, reason: 'ranking_exception' };
  }

  const padcoinsEval = evaluatePadcoinsBranchResult(padcoinsRaw);
  const rankingEval = evaluateRankingBranchResult(rankingRaw);
  const rewards = buildAttendanceRewardsResponse({
    processed: padcoinsEval.ok && rankingEval.ok,
    padcoins: padcoinsEval,
    ranking: rankingEval,
  });

  if (!padcoinsEval.ok || !rankingEval.ok) {
    console.warn(
      `[Attendance Fase 3.3] partial failure partido=${matchId} padcoins=${padcoinsEval.reason} ranking=${rankingEval.reason}`,
    );
    return {
      ok: true,
      credited: false,
      partidoFields: refreshedState.ok ? refreshedState.partidoFields : partidoFields,
      summary: refreshedState.ok ? refreshedState.summary : summary,
      eligible_count: eligibleParticipants.length,
      rewards,
    };
  }

  const markResult = await markMatchAttendanceRewardsCredited(
    supabaseAdmin,
    matchId,
    refreshedState.ok ? refreshedState.partidoFields : partidoFields,
    { now },
  );

  const finalState = await getMatchAttendanceState(supabaseAdmin, matchId);

  console.log(
    `[Attendance Fase 3.3] credited partido=${matchId} eligible=${eligibleParticipants.length} idempotent=${markResult.idempotent === true}`,
  );

  return {
    ok: true,
    credited: markResult.credited === true,
    idempotent: markResult.idempotent === true,
    partidoFields: finalState.ok ? finalState.partidoFields : markResult.partidoFields,
    summary: finalState.ok ? finalState.summary : summary,
    eligible_count: eligibleParticipants.length,
    rewards: buildAttendanceRewardsResponse({
      processed: markResult.credited === true,
      padcoins: padcoinsEval,
      ranking: rankingEval,
    }),
  };
}

export async function maybeFinalizeRewardsAfterAttendanceEvaluation(supabaseAdmin, matchId, partidoFields, {
  now = new Date(),
  deps = {},
} = {}) {
  if (partidoFields.collection_status !== MATCH_ATTENDANCE_COLLECTION_STATUS.READY) {
    return {
      partidoFields,
      summary: null,
      rewards: buildAttendanceRewardsResponse({
        padcoins: { ok: false, reason: 'not_ready' },
        ranking: { ok: false, reason: 'not_ready' },
      }),
    };
  }

  const finalizeFn = deps.tryFinalizeMatchAttendanceRewards ?? tryFinalizeMatchAttendanceRewards;
  const finalizeResult = await finalizeFn(supabaseAdmin, matchId, {
    now,
    deps,
  });

  const refreshed = await getMatchAttendanceState(supabaseAdmin, matchId);
  return {
    partidoFields: refreshed.ok ? refreshed.partidoFields : (finalizeResult.partidoFields ?? partidoFields),
    summary: refreshed.ok ? refreshed.summary : finalizeResult.summary,
    rewards: finalizeResult.rewards,
  };
}

function buildSubmitPlayerAttendanceResponsePayload(matchId, participant, partidoFields, summary, {
  rewards = null,
  idempotent = false,
} = {}) {
  const playerFields = normalizeParticipantAttendanceFields(participant);
  const rewardsBlock = rewards ?? buildAttendanceRewardsResponse({
    padcoins: { ok: false, reason: 'not_attempted' },
    ranking: { ok: false, reason: 'not_attempted' },
  });

  return {
    ok: true,
    match_id: Number(matchId),
    idempotent,
    player: {
      attendance_status: playerFields.attendance_status,
      attendance_responded_at: playerFields.attendance_responded_at,
      attendance_response_source: playerFields.attendance_response_source,
      attendance_denial_reason: playerFields.attendance_denial_reason,
    },
    match: {
      collection_status: partidoFields.collection_status,
      deadline_at: partidoFields.deadline_at,
      resolved_at: partidoFields.resolved_at,
      resolution_reason: partidoFields.resolution_reason,
      rewards_processed_at: partidoFields.rewards_processed_at,
    },
    summary: {
      total_participants: summary.total_participants,
      pending: summary.pending,
      confirmed: summary.confirmed,
      denied: summary.denied,
      admin_validated: summary.admin_validated,
      excluded: summary.excluded,
      eligible: summary.eligible,
    },
    rewards: rewardsBlock,
  };
}

export async function submitPlayerAttendanceResponse(supabaseAdmin, matchId, userId, body = {}, {
  now = new Date(),
  deps = {},
} = {}) {
  if (!isValidUserId(userId)) {
    return { ok: false, httpStatus: 400, reason: 'invalid_user_id' };
  }

  const parsed = parsePlayerAttendanceResponseBody(body);
  if (!parsed.ok) {
    return { ok: false, httpStatus: 400, reason: parsed.reason };
  }

  const { partido, schemaAttendanceColumnsAvailable } = await fetchPartidoAttendanceRow(
    supabaseAdmin,
    matchId,
  );

  if (!partido) {
    return { ok: false, httpStatus: 404, reason: 'partido_no_encontrado' };
  }

  const membership = await resolveUserPartidoMembership(supabaseAdmin, partido, userId);
  if (!membership.is_member) {
    return { ok: false, httpStatus: 403, reason: 'not_a_participant' };
  }

  const normalizedMatchId = normalizeMatchId(matchId);
  const { data: participant, error: participantErr } = await supabaseAdmin
    .from('match_participants')
    .select(PARTICIPANTS_ATTENDANCE_SELECT)
    .eq('match_type', MATCH_TYPES.CASUAL)
    .eq('match_id', normalizedMatchId)
    .eq('user_id', userId)
    .maybeSingle();

  if (participantErr) {
    if (isMissingMatchAttendanceColumnError(participantErr)) {
      return { ok: false, httpStatus: 503, reason: 'schema_missing' };
    }
    throw participantErr;
  }

  const { sedeEnabled, featureEnabled } = await resolveAttendanceFeatureForPartido(
    supabaseAdmin,
    partido,
  );

  const partidoFields = normalizePartidoAttendanceFields(partido, {
    schemaAttendanceColumnsAvailable,
    sedeAttendanceConfirmationEnabled: sedeEnabled,
  });
  partidoFields.feature_enabled = featureEnabled;

  const validation = validatePlayerAttendanceSubmission({
    featureEnabled: partidoFields.feature_enabled,
    schemaAvailable: schemaAttendanceColumnsAvailable,
    collectionStatus: partidoFields.collection_status,
    deadlineAt: partidoFields.deadline_at,
    participant,
    rewardsProcessedAt: partidoFields.rewards_processed_at,
    now,
  });

  if (!validation.ok) {
    return { ok: false, httpStatus: validation.httpStatus, reason: validation.reason };
  }

  if (isSamePlayerAttendanceResponse(participant, parsed.targetStatus, parsed.denialReason)) {
    const state = await getMatchAttendanceState(supabaseAdmin, matchId);
    const finalize = await maybeFinalizeRewardsAfterAttendanceEvaluation(
      supabaseAdmin,
      matchId,
      state.partidoFields,
      { now, deps },
    );
    const payload = buildSubmitPlayerAttendanceResponsePayload(
      matchId,
      participant,
      finalize.partidoFields ?? state.partidoFields,
      finalize.summary ?? state.summary,
      { rewards: finalize.rewards, idempotent: true },
    );
    return payload;
  }

  const updatePayload = buildPlayerAttendanceUpdatePayload(parsed.targetStatus, {
    denialReason: parsed.denialReason,
    now,
  });

  const { data: updatedParticipant, error: updateErr } = await supabaseAdmin
    .from('match_participants')
    .update(updatePayload)
    .eq('id', participant.id)
    .eq('match_type', MATCH_TYPES.CASUAL)
    .eq('match_id', normalizedMatchId)
    .eq('user_id', userId)
    .select(PARTICIPANTS_ATTENDANCE_SELECT)
    .maybeSingle();

  if (updateErr) {
    if (isMissingMatchAttendanceColumnError(updateErr)) {
      return { ok: false, httpStatus: 503, reason: 'schema_missing' };
    }
    throw updateErr;
  }

  if (!updatedParticipant) {
    const { data: refetched } = await supabaseAdmin
      .from('match_participants')
      .select(PARTICIPANTS_ATTENDANCE_SELECT)
      .eq('id', participant.id)
      .maybeSingle();

    if (refetched && isSamePlayerAttendanceResponse(refetched, parsed.targetStatus, parsed.denialReason)) {
      const state = await getMatchAttendanceState(supabaseAdmin, matchId);
      const finalize = await maybeFinalizeRewardsAfterAttendanceEvaluation(
        supabaseAdmin,
        matchId,
        state.partidoFields,
        { now, deps },
      );
      const payload = buildSubmitPlayerAttendanceResponsePayload(
        matchId,
        refetched,
        finalize.partidoFields ?? state.partidoFields,
        finalize.summary ?? state.summary,
        { rewards: finalize.rewards, idempotent: true },
      );
      return payload;
    }

    return { ok: false, httpStatus: 409, reason: 'concurrent_update_conflict' };
  }

  const evaluation = await evaluateAttendanceCollectionState(supabaseAdmin, matchId, { now });
  const partidoFieldsAfter = evaluation.partidoFields ?? partidoFields;
  const summaryAfter = evaluation.summary ?? buildMatchAttendanceSummary(
    partidoFieldsAfter,
    (await fetchParticipantsForAttendance(supabaseAdmin, matchId)).participants,
  );

  const finalize = await maybeFinalizeRewardsAfterAttendanceEvaluation(
    supabaseAdmin,
    matchId,
    partidoFieldsAfter,
    { now, deps },
  );

  return buildSubmitPlayerAttendanceResponsePayload(
    matchId,
    updatedParticipant,
    finalize.partidoFields ?? partidoFieldsAfter,
    finalize.summary ?? summaryAfter,
    { rewards: finalize.rewards },
  );
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

export { isAttendanceConfirmationEnabledForMatch, resolveAttendanceFeatureForPartido };
