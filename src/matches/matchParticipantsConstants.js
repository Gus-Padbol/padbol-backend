export const MATCH_TYPES = Object.freeze({
  CASUAL: 'casual',
});

export const MATCH_PARTICIPANT_ROLES = Object.freeze({
  ORGANIZER: 'organizer',
  PARTICIPANT: 'participant',
});

export const MATCH_PARTICIPANT_SOURCES = Object.freeze({
  RESERVATION: 'reservation',
  JOIN: 'join',
  SCOREBOARD: 'scoreboard',
  MANUAL: 'manual',
  ADMIN: 'admin',
});

export const MATCH_ATTENDANCE_STATUS = Object.freeze({
  PENDING: 'pending',
  CONFIRMED: 'confirmed',
  DENIED: 'denied',
  ADMIN_VALIDATED: 'admin_validated',
  EXCLUDED: 'excluded',
});

export const MATCH_REWARD_STATUS = Object.freeze({
  PENDING: 'pending',
  ELIGIBLE: 'eligible',
  CREDITED: 'credited',
  SKIPPED: 'skipped',
  REVERSED: 'reversed',
});

export const MATCH_REWARD_TYPES = Object.freeze({
  PADCOINS: 'padcoins',
  XP: 'xp',
  RANKING: 'ranking',
});

export const MATCH_REWARD_EVENT_STATUS = Object.freeze({
  PENDING: 'pending',
  CREDITED: 'credited',
  SKIPPED: 'skipped',
  REVERSED: 'reversed',
});

export const RESERVATION_REWARD_MODES = Object.freeze({
  ORGANIZER_ONLY: 'organizer_only',
  MATCH_DEFERRED: 'match_deferred',
});

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidUserId(userId) {
  return UUID_REGEX.test(String(userId ?? '').trim());
}

export function normalizeMatchId(matchId) {
  const id = String(matchId ?? '').trim();
  return id || null;
}
