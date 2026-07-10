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

export const MATCH_ATTENDANCE_COLLECTION_STATUS = Object.freeze({
  NONE: 'none',
  OPEN: 'open',
  EXPIRED: 'expired',
  READY: 'ready',
  CREDITED: 'credited',
  BLOCKED: 'blocked',
});

export const MATCH_ATTENDANCE_RESPONSE_SOURCE = Object.freeze({
  PLAYER: 'player',
  ADMIN: 'admin',
  SYSTEM_TIMEOUT: 'system_timeout',
  SYSTEM_LEGACY: 'system_legacy',
});

const ATTENDANCE_COLLECTION_STATUS_VALUES = new Set(
  Object.values(MATCH_ATTENDANCE_COLLECTION_STATUS),
);

const ATTENDANCE_RESPONSE_SOURCE_VALUES = new Set(
  Object.values(MATCH_ATTENDANCE_RESPONSE_SOURCE),
);

const ATTENDANCE_STATUS_VALUES = new Set(Object.values(MATCH_ATTENDANCE_STATUS));

export const NON_ELIGIBLE_ATTENDANCE_STATUSES = new Set([
  MATCH_ATTENDANCE_STATUS.PENDING,
  MATCH_ATTENDANCE_STATUS.DENIED,
  MATCH_ATTENDANCE_STATUS.EXCLUDED,
]);

export const ELIGIBLE_ATTENDANCE_STATUSES = new Set([
  MATCH_ATTENDANCE_STATUS.CONFIRMED,
  MATCH_ATTENDANCE_STATUS.ADMIN_VALIDATED,
]);

export const RESOLVED_ATTENDANCE_STATUSES = new Set([
  MATCH_ATTENDANCE_STATUS.CONFIRMED,
  MATCH_ATTENDANCE_STATUS.DENIED,
  MATCH_ATTENDANCE_STATUS.ADMIN_VALIDATED,
  MATCH_ATTENDANCE_STATUS.EXCLUDED,
]);

export function normalizeAttendanceStatus(value, fallback = MATCH_ATTENDANCE_STATUS.PENDING) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (ATTENDANCE_STATUS_VALUES.has(normalized)) {
    return normalized;
  }
  return fallback;
}

export function normalizeAttendanceCollectionStatus(
  value,
  fallback = MATCH_ATTENDANCE_COLLECTION_STATUS.NONE,
) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (ATTENDANCE_COLLECTION_STATUS_VALUES.has(normalized)) {
    return normalized;
  }
  return fallback;
}

export function normalizeAttendanceResponseSource(value) {
  if (value == null || String(value).trim() === '') {
    return null;
  }
  const normalized = String(value).trim().toLowerCase();
  if (ATTENDANCE_RESPONSE_SOURCE_VALUES.has(normalized)) {
    return normalized;
  }
  return null;
}

export function isEligibleAttendanceStatus(status) {
  return ELIGIBLE_ATTENDANCE_STATUSES.has(normalizeAttendanceStatus(status, ''));
}

export function isNonEligibleAttendanceStatus(status) {
  const normalized = normalizeAttendanceStatus(status, '');
  return normalized !== '' && NON_ELIGIBLE_ATTENDANCE_STATUSES.has(normalized);
}

export function isResolvedAttendanceStatus(status) {
  return RESOLVED_ATTENDANCE_STATUSES.has(normalizeAttendanceStatus(status, ''));
}

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
