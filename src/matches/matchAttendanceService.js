import { getMatchAttendanceWindowHours, isAttendanceConfirmationEnabledForMatch } from './matchAttendanceConfig.js';
import { resolveAuthRoleForUser } from '../../lib/authAccess.js';
import {
  isEquiposAsignacionValida,
  normalizeEquipoUserIds,
  sortJugadoresRowsForEquipos,
} from '../partidos/equiposService.js';
import {
  MATCH_ATTENDANCE_COLLECTION_STATUS,
  MATCH_ATTENDANCE_STATUS,
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
} = {}) {
  if (!match || !isAttendanceConfirmationEnabledForMatch(match)) {
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
      attendance_requested_at: requestedAt,
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
    attendance_requested_at: requestedAt,
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

  if (!isAttendanceConfirmationEnabledForMatch(partido)) {
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

  if (!shouldOpenAttendanceWindow(partido, { hasClearResult: resolvedHasClearResult })) {
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
  };
}

export async function maybeDeferCasualRewardsForAttendance(supabaseAdmin, matchId, options = {}) {
  if (!isAttendanceConfirmationEnabledForMatch(options.partido)) {
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
