import { createHash } from 'node:crypto';

/** Prefijo para metadata serializada en notificaciones.link (schema prod sin data). */
export const NOTIFICATION_LINK_PREFIX = 'padbol:notif:v1h:';

/** Formato anterior con dedupe_key en claro — solo lectura retrocompatible. */
export const LEGACY_NOTIFICATION_LINK_PREFIX = 'padbol:notif:v1:';

/** Límite razonable para link TEXT en prod (URLs + metadata compacta). */
export const MAX_NOTIFICATION_ENCODED_LINK_LENGTH = 2048;

const METADATA_BLOCKLIST = new Set([
  'token',
  'access_token',
  'refresh_token',
  'password',
  'secret',
  'api_key',
  'email',
  'telefono',
  'phone',
]);

function messageRefersToNotificacionesDataColumn(message) {
  const msg = String(message ?? '').toLowerCase();
  if (!msg.includes('data')) {
    return false;
  }
  if (!msg.includes('notificaciones')) {
    return false;
  }
  return msg.includes("'data'") || msg.includes('column \'data\'') || msg.includes('column "data"');
}

export function isMissingNotificacionesDataColumnError(error) {
  const code = String(error?.code ?? '');
  if (code !== '42703' && code !== 'PGRST204') {
    return false;
  }
  return messageRefersToNotificacionesDataColumn(error?.message);
}

export function hasNotificationMetadata(metadata) {
  return metadata != null
    && typeof metadata === 'object'
    && !Array.isArray(metadata)
    && Object.keys(metadata).length > 0;
}

export function sanitizeNotificationMetadata(metadata = {}) {
  if (!hasNotificationMetadata(metadata)) {
    return {};
  }

  const clean = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (METADATA_BLOCKLIST.has(String(key).toLowerCase())) {
      continue;
    }
    clean[key] = value;
  }
  return clean;
}

function hashDedupeKeyForPrefix(dedupeKey) {
  return createHash('sha256').update(String(dedupeKey), 'utf8').digest('hex');
}

function parseBase64UrlJson(encoded) {
  if (!encoded) {
    return {};
  }
  try {
    const parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    return parsed != null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed
      : {};
  } catch {
    return {};
  }
}

function splitEncodedNotificationLink(link, prefix) {
  const raw = String(link ?? '');
  if (!raw.startsWith(prefix)) {
    return null;
  }
  const body = raw.slice(prefix.length);
  const separator = body.indexOf(':');
  if (separator < 0) {
    return null;
  }
  return {
    marker: body.slice(0, separator),
    restEnc: body.slice(separator + 1),
  };
}

export function isEncodedNotificationLink(link) {
  const raw = String(link ?? '');
  return raw.startsWith(NOTIFICATION_LINK_PREFIX)
    || raw.startsWith(LEGACY_NOTIFICATION_LINK_PREFIX);
}

export function encodeNotificationLinkPayload(metadata = {}, {
  maxLength = MAX_NOTIFICATION_ENCODED_LINK_LENGTH,
} = {}) {
  const sanitized = sanitizeNotificationMetadata(metadata);
  const dedupeKey = String(sanitized.dedupe_key ?? '');
  const restEnc = Buffer.from(JSON.stringify(sanitized)).toString('base64url');
  const hashPart = dedupeKey ? hashDedupeKeyForPrefix(dedupeKey) : 'none';
  const encoded = `${NOTIFICATION_LINK_PREFIX}${hashPart}:${restEnc}`;

  if (encoded.length > maxLength) {
    const err = new Error('notification_encoded_link_too_large');
    err.code = 'NOTIFICATION_LINK_TOO_LARGE';
    err.encodedLength = encoded.length;
    throw err;
  }

  return encoded;
}

export function decodeNotificationLinkPayload(link) {
  const raw = String(link ?? '');

  const v1hParts = splitEncodedNotificationLink(raw, NOTIFICATION_LINK_PREFIX);
  if (v1hParts) {
    return sanitizeNotificationMetadata(parseBase64UrlJson(v1hParts.restEnc));
  }

  const legacyParts = splitEncodedNotificationLink(raw, LEGACY_NOTIFICATION_LINK_PREFIX);
  if (legacyParts) {
    const dedupeKey = legacyParts.marker;
    const rest = parseBase64UrlJson(legacyParts.restEnc);
    const payload = { ...rest };
    if (dedupeKey) {
      payload.dedupe_key = dedupeKey;
    }
    return payload;
  }

  return null;
}

function resolveDataFromRow(row = {}) {
  if (row?.data != null && typeof row.data === 'object' && !Array.isArray(row.data)) {
    return sanitizeNotificationMetadata(row.data);
  }

  const decoded = decodeNotificationLinkPayload(row?.link);
  if (!decoded) {
    return {};
  }

  const data = { ...decoded };
  delete data.original_link;
  return sanitizeNotificationMetadata(data);
}

function resolvePublicLinkFromRow(row = {}, data = {}) {
  const rawLink = row?.link ?? null;

  if (rawLink != null && !isEncodedNotificationLink(rawLink)) {
    return rawLink;
  }

  if (isEncodedNotificationLink(rawLink)) {
    const decoded = decodeNotificationLinkPayload(rawLink);
    if (!decoded) {
      return null;
    }
    if (decoded.original_link != null && String(decoded.original_link).trim()) {
      return String(decoded.original_link);
    }
    return null;
  }

  if (data.original_link != null && String(data.original_link).trim()) {
    return String(data.original_link);
  }

  return null;
}

export function resolveNotificationPayload(row = {}) {
  const data = resolveDataFromRow(row);
  const link = resolvePublicLinkFromRow(row, data);
  return { data, link };
}

export function resolveNotificationData(row = {}) {
  return resolveNotificationPayload(row).data;
}

export function buildDedupeLinkPrefix(dedupeKey) {
  return `${NOTIFICATION_LINK_PREFIX}${hashDedupeKeyForPrefix(dedupeKey)}:`;
}
