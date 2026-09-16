import { createHash } from 'node:crypto';

// Capa común de contacto/conversación CRM (WhatsApp + correo).
// - Normaliza email y teléfono antes de comparar.
// - No fusiona personas solo por nombre.
// - Ante coincidencias ambiguas, conserva registros separados y marca revisión.
// - Exclusión de canal temporal por intento (mismo recorrido): un canal elegido
//   impide el otro dentro del MISMO attemptId; un intento posterior se acepta.

export const CRM_CHANNELS = Object.freeze(['whatsapp', 'email']);

export function normalizeEmail(value) {
  const email = String(value ?? '').trim().toLowerCase();
  if (!email || !email.includes('@')) return null;
  const [local, domain] = email.split('@');
  if (!local || !domain) return null;
  // Gmail: ignorar puntos y sufijo +alias para agrupar la misma cuenta.
  const normalizedLocal = /^(gmail|googlemail)\.com$/.test(domain)
    ? local.replace(/\./g, '').split('+')[0]
    : local;
  return `${normalizedLocal}@${domain}`;
}

export function normalizePhone(value) {
  const digits = String(value ?? '').replace(/[^\d]/g, '');
  if (!digits) return null;
  // Quita sólo el prefijo internacional `00`; conserva el `0` local (p. ej. 011).
  const trimmed = digits.replace(/^00/, '');
  if (trimmed.length < 8 || trimmed.length > 15) return null;
  return trimmed;
}

export function contactChannelKey({ email, phone } = {}) {
  return { email: normalizeEmail(email), phone: normalizePhone(phone) };
}

/** Un teléfono sin código internacional (empieza con `0` local) no es confiable para emparejar. */
export function phoneHasCountryCode(digits) {
  const value = normalizePhone(digits);
  return Boolean(value && /^[1-9]/.test(value) && value.length >= 10);
}

/**
 * Busca una coincidencia segura de contacto por email o teléfono normalizados.
 * - 0 coincidencias → `none`.
 * - 1 coincidencia → `exact`.
 * - >1 coincidencias → `ambiguous` (no fusionar; marcar revisión).
 * Nunca compara solo por nombre.
 */
export function matchCrmContact({ email, phone, existing = [] } = {}) {
  const em = normalizeEmail(email);
  const ph = normalizePhone(phone);
  if (!em && !ph) return { status: 'none', contact: null };

  const matches = (Array.isArray(existing) ? existing : []).filter((c) => {
    const cEm = normalizeEmail(c?.email_normalized ?? c?.email);
    const cPh = normalizePhone(c?.phone_normalized ?? c?.phone);
    const emailMatch = Boolean(em && cEm && em === cEm);
    // El teléfono solo empareja de forma segura si ambos tienen código de país.
    const phoneMatch = Boolean(
      ph && cPh && ph === cPh && phoneHasCountryCode(ph) && phoneHasCountryCode(cPh),
    );
    return emailMatch || phoneMatch;
  });

  if (matches.length === 0) return { status: 'none', contact: null };
  if (matches.length === 1) return { status: 'exact', contact: matches[0] };
  return { status: 'ambiguous', contacts: matches };
}

export function attemptIdFor({ source, sourceId, contactKey } = {}) {
  const key = `${source}:${sourceId}:${String(contactKey ?? '')}`;
  return createHash('sha256').update(key).digest('hex');
}

/**
 * Exclusión de canal dentro de un mismo intento (recorrido).
 * - Primer intento de un attemptId → `accepted`.
 * - Repetición del MISMO canal en el mismo attemptId → `idempotent` (no duplica).
 * - Canal distinto en el MISMO attemptId → `blocked` (no se permite el segundo canal).
 * Un intento posterior (nuevo attemptId) siempre se evalúa de nuevo → `accepted`.
 */
export function resolveChannelAttempt({ attemptId, channel, existingAttempts = [] } = {}) {
  if (!attemptId || !CRM_CHANNELS.includes(channel)) return { status: 'invalid' };
  const prior = (Array.isArray(existingAttempts) ? existingAttempts : [])
    .find((a) => a?.attempt_id === attemptId);
  if (!prior) return { status: 'accepted', channel };
  if (prior.channel === channel) return { status: 'idempotent', channel };
  return { status: 'blocked', channel: prior.channel, requested: channel };
}
