import {
  ELIGIBLE_ATTENDANCE_STATUSES,
  MATCH_ATTENDANCE_STATUS,
  MATCH_PARTICIPANT_ROLES,
  MATCH_PARTICIPANT_SOURCES,
  MATCH_REWARD_STATUS,
  MATCH_TYPES,
  NON_ELIGIBLE_ATTENDANCE_STATUSES,
  isValidUserId,
  normalizeMatchId,
} from './matchParticipantsConstants.js';

function isMissingTable(error) {
  const message = String(error?.message ?? '').toLowerCase();
  return (
    error?.code === '42P01'
    || error?.code === 'PGRST205'
    || message.includes('does not exist')
    || message.includes('could not find the table')
  );
}

function isDuplicateParticipantError(error) {
  return error?.code === '23505'
    && String(error?.message ?? '').toLowerCase().includes('match_participants');
}

function buildParticipantRow(payload = {}) {
  const matchType = String(payload.match_type ?? MATCH_TYPES.CASUAL).trim() || MATCH_TYPES.CASUAL;
  const matchId = normalizeMatchId(payload.match_id);
  const userId = String(payload.user_id ?? '').trim();

  if (!matchId || !isValidUserId(userId)) {
    return null;
  }

  const row = {
    match_type: matchType,
    match_id: matchId,
    user_id: userId,
    role: payload.role ?? MATCH_PARTICIPANT_ROLES.PARTICIPANT,
    source: payload.source ?? MATCH_PARTICIPANT_SOURCES.MANUAL,
    attendance_status: payload.attendance_status ?? MATCH_ATTENDANCE_STATUS.PENDING,
    reward_status: payload.reward_status ?? MATCH_REWARD_STATUS.PENDING,
  };

  if (payload.reserva_id != null) {
    row.reserva_id = Number(payload.reserva_id);
  }
  if (payload.email != null) {
    row.email = String(payload.email).trim() || null;
  }
  if (payload.team != null) {
    row.team = String(payload.team).trim() || null;
  }
  if (payload.attendance_confirmed_at) {
    row.attendance_confirmed_at = payload.attendance_confirmed_at;
  }

  return row;
}

/**
 * Inserta o actualiza un participante por (match_type, match_id, user_id).
 */
export async function upsertMatchParticipant(supabaseAdmin, payload = {}) {
  const row = buildParticipantRow(payload);
  if (!row) {
    return { ok: false, reason: 'invalid_payload' };
  }

  const { data: existing, error: fetchErr } = await supabaseAdmin
    .from('match_participants')
    .select('*')
    .eq('match_type', row.match_type)
    .eq('match_id', row.match_id)
    .eq('user_id', row.user_id)
    .maybeSingle();

  if (fetchErr) {
    if (isMissingTable(fetchErr)) {
      return { ok: false, reason: 'table_missing', skipped: true };
    }
    throw fetchErr;
  }

  if (existing?.id) {
    const updatePayload = {
      updated_at: new Date().toISOString(),
    };

    if (payload.role != null) updatePayload.role = row.role;
    if (payload.source != null) updatePayload.source = row.source;
    if (payload.attendance_status != null) updatePayload.attendance_status = row.attendance_status;
    if (payload.reward_status != null) updatePayload.reward_status = row.reward_status;
    if (payload.email != null) updatePayload.email = row.email;
    if (payload.team != null) updatePayload.team = row.team;
    if (payload.reserva_id != null) updatePayload.reserva_id = row.reserva_id;
    if (payload.attendance_confirmed_at != null) {
      updatePayload.attendance_confirmed_at = row.attendance_confirmed_at;
    }

    const { data, error } = await supabaseAdmin
      .from('match_participants')
      .update(updatePayload)
      .eq('id', existing.id)
      .select('*')
      .single();

    if (error) throw error;
    return { ok: true, participant: data, created: false };
  }

  const { data, error } = await supabaseAdmin
    .from('match_participants')
    .insert(row)
    .select('*')
    .single();

  if (error) {
    if (isDuplicateParticipantError(error)) {
      return upsertMatchParticipant(supabaseAdmin, payload);
    }
    if (isMissingTable(error)) {
      return { ok: false, reason: 'table_missing', skipped: true };
    }
    throw error;
  }

  return { ok: true, participant: data, created: true };
}

export async function listMatchParticipants(supabaseAdmin, {
  matchType = MATCH_TYPES.CASUAL,
  matchId,
} = {}) {
  const normalizedMatchId = normalizeMatchId(matchId);
  if (!normalizedMatchId) {
    return [];
  }

  const { data, error } = await supabaseAdmin
    .from('match_participants')
    .select('*')
    .eq('match_type', matchType)
    .eq('match_id', normalizedMatchId)
    .order('created_at', { ascending: true });

  if (error) {
    if (isMissingTable(error)) return [];
    throw error;
  }

  return data ?? [];
}

export async function markAttendance(supabaseAdmin, {
  matchType = MATCH_TYPES.CASUAL,
  matchId,
  userId,
  attendanceStatus,
  rewardStatus = null,
  confirmedAt = null,
} = {}) {
  const normalizedMatchId = normalizeMatchId(matchId);
  if (!normalizedMatchId || !isValidUserId(userId)) {
    return { ok: false, reason: 'invalid_payload' };
  }

  const updatePayload = {
    attendance_status: attendanceStatus,
    updated_at: new Date().toISOString(),
  };

  if (rewardStatus != null) {
    updatePayload.reward_status = rewardStatus;
  }
  if (confirmedAt != null) {
    updatePayload.attendance_confirmed_at = confirmedAt;
  } else if (
    attendanceStatus === MATCH_ATTENDANCE_STATUS.CONFIRMED
    || attendanceStatus === MATCH_ATTENDANCE_STATUS.ADMIN_VALIDATED
  ) {
    updatePayload.attendance_confirmed_at = new Date().toISOString();
  }

  const { data, error } = await supabaseAdmin
    .from('match_participants')
    .update(updatePayload)
    .eq('match_type', matchType)
    .eq('match_id', normalizedMatchId)
    .eq('user_id', userId)
    .select('*')
    .maybeSingle();

  if (error) {
    if (isMissingTable(error)) {
      return { ok: false, reason: 'table_missing', skipped: true };
    }
    throw error;
  }

  if (!data) {
    return { ok: false, reason: 'participant_not_found' };
  }

  return { ok: true, participant: data };
}

/**
 * Asegura fila de organizador vinculada a reserva/partido casual.
 */
export async function ensureOrganizerParticipantFromReserva(supabaseAdmin, {
  reserva,
  partido,
} = {}) {
  const matchId = normalizeMatchId(partido?.id ?? reserva?.partido_id);
  const organizerUserId = reserva?.user_id;

  if (!matchId || !isValidUserId(organizerUserId)) {
    return { ok: false, reason: 'missing_match_or_organizer' };
  }

  return upsertMatchParticipant(supabaseAdmin, {
    match_type: MATCH_TYPES.CASUAL,
    match_id: matchId,
    reserva_id: reserva?.id ?? null,
    user_id: organizerUserId,
    role: MATCH_PARTICIPANT_ROLES.ORGANIZER,
    source: MATCH_PARTICIPANT_SOURCES.RESERVATION,
    attendance_status: MATCH_ATTENDANCE_STATUS.PENDING,
    reward_status: MATCH_REWARD_STATUS.PENDING,
  });
}

const NON_ELIGIBLE_ATTENDANCE = NON_ELIGIBLE_ATTENDANCE_STATUSES;
const ELIGIBLE_ATTENDANCE = ELIGIBLE_ATTENDANCE_STATUSES;

/**
 * Participantes con user_id y asistencia validada (no pending/denied/excluded).
 */
export function getEligibleParticipantsForRewards(participants = []) {
  return (participants ?? []).filter((participant) => {
    if (!isValidUserId(participant?.user_id)) {
      return false;
    }
    const status = String(participant.attendance_status ?? '').trim();
    if (NON_ELIGIBLE_ATTENDANCE.has(status)) {
      return false;
    }
    return ELIGIBLE_ATTENDANCE.has(status);
  });
}

/**
 * Si solo hay organizador identificado/validado, solo él es elegible.
 * Participantes sin user_id nunca son elegibles.
 */
export function resolveEligibleParticipantsForRewards(participants = []) {
  const withUserId = (participants ?? []).filter((p) => isValidUserId(p?.user_id));
  const eligible = getEligibleParticipantsForRewards(withUserId);
  const nonOrganizerEligible = eligible.filter(
    (p) => p.role !== MATCH_PARTICIPANT_ROLES.ORGANIZER,
  );

  if (nonOrganizerEligible.length === 0) {
    return eligible.filter((p) => p.role === MATCH_PARTICIPANT_ROLES.ORGANIZER);
  }

  return eligible;
}

/**
 * Sincroniza participantes desde partidos_abiertos_jugadores (solo con user_id).
 */
export async function syncParticipantsFromPartidoJugadores(supabaseAdmin, {
  partidoId,
  reservaId = null,
  capitanUserId = null,
  markValidated = false,
} = {}) {
  const matchId = normalizeMatchId(partidoId);
  if (!matchId) {
    return { ok: false, reason: 'invalid_partido_id', synced: [] };
  }

  const { data: jugadores, error } = await supabaseAdmin
    .from('partidos_abiertos_jugadores')
    .select('user_id, email')
    .eq('partido_id', Number(partidoId));

  if (error) throw error;

  const synced = [];
  const confirmedAt = markValidated ? new Date().toISOString() : null;
  const attendanceStatus = markValidated
    ? MATCH_ATTENDANCE_STATUS.ADMIN_VALIDATED
    : MATCH_ATTENDANCE_STATUS.PENDING;
  const rewardStatus = markValidated
    ? MATCH_REWARD_STATUS.ELIGIBLE
    : MATCH_REWARD_STATUS.PENDING;

  for (const jugador of jugadores ?? []) {
    if (!isValidUserId(jugador.user_id)) {
      continue;
    }

    const isOrganizer = capitanUserId && jugador.user_id === capitanUserId;
    const result = await upsertMatchParticipant(supabaseAdmin, {
      match_type: MATCH_TYPES.CASUAL,
      match_id: matchId,
      reserva_id: reservaId,
      user_id: jugador.user_id,
      email: jugador.email ?? null,
      team: null,
      role: isOrganizer
        ? MATCH_PARTICIPANT_ROLES.ORGANIZER
        : MATCH_PARTICIPANT_ROLES.PARTICIPANT,
      source: MATCH_PARTICIPANT_SOURCES.JOIN,
      attendance_status: attendanceStatus,
      attendance_confirmed_at: confirmedAt,
      reward_status: rewardStatus,
    });

    if (result.ok) {
      synced.push(result.participant);
    }
  }

  return { ok: true, synced };
}
