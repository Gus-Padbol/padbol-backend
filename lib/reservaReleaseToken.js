import crypto from 'crypto';

export const RESERVA_RELEASE_PENDING_STATES = Object.freeze([
  'pendiente',
  'pendiente_pago_manual',
  'pendiente_pago_efectivo',
  'pendiente_pago_mercadopago',
  'pendiente_mercadopago',
]);

const TOKEN_VERSION = 1;
const DEFAULT_TTL_SECONDS = 2 * 60 * 60;

function tokenError(message, code, status = 401) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

function signingKey(secret) {
  const value = String(secret || '').trim();
  if (!value) throw tokenError('Liberación segura no configurada', 'RESERVA_RELEASE_NOT_CONFIGURED', 503);
  return crypto.createHmac('sha256', value).update('padbol:reserva-release:v1').digest();
}

function slotHash(reserva) {
  const sede = String(reserva?.sede || '').trim();
  const fecha = String(reserva?.fecha || '').trim().slice(0, 10);
  const hora = String(reserva?.hora || '').trim();
  const cancha = String(reserva?.cancha ?? '').trim();
  if (!sede || !fecha || !hora || !cancha) throw tokenError('Slot inválido', 'RESERVA_RELEASE_INVALID_SLOT', 500);
  return crypto.createHash('sha256').update(`${sede}\u001f${fecha}\u001f${hora}\u001f${cancha}`).digest('base64url');
}

export function isReservaReleasePendingState(value) {
  return RESERVA_RELEASE_PENDING_STATES.includes(String(value || '').trim().toLowerCase());
}

export function createReservaReleaseToken({ reserva, secret, nowMs = Date.now(), ttlSeconds = DEFAULT_TTL_SECONDS }) {
  const rid = Number.parseInt(String(reserva?.id ?? ''), 10);
  if (!Number.isFinite(rid) || rid <= 0 || !isReservaReleasePendingState(reserva?.estado)) {
    throw tokenError('Reserva pendiente inválida', 'RESERVA_RELEASE_INVALID_RESERVATION', 409);
  }
  const ttl = Math.min(86400, Math.max(60, Number.parseInt(String(ttlSeconds), 10) || DEFAULT_TTL_SECONDS));
  const exp = Math.floor(nowMs / 1000) + ttl;
  const payload = Buffer.from(JSON.stringify({
    v: TOKEN_VERSION,
    rid,
    slot: slotHash(reserva),
    exp,
    nonce: crypto.randomBytes(16).toString('base64url'),
  })).toString('base64url');
  const signature = crypto.createHmac('sha256', signingKey(secret)).update(payload).digest('base64url');
  return { token: `${payload}.${signature}`, expiresAt: new Date(exp * 1000).toISOString() };
}

export function verifyReservaReleaseToken(token, { secret, nowMs = Date.now() }) {
  const raw = String(token || '').trim();
  const [payloadRaw, signatureRaw, extra] = raw.split('.');
  if (!payloadRaw || !signatureRaw || extra !== undefined) {
    throw tokenError('Token de liberación requerido', 'RESERVA_RELEASE_TOKEN_REQUIRED');
  }
  if (!/^[A-Za-z0-9_-]+$/.test(payloadRaw) || !/^[A-Za-z0-9_-]{43}$/.test(signatureRaw)) {
    throw tokenError('Token de liberación inválido', 'RESERVA_RELEASE_TOKEN_INVALID');
  }
  const expected = crypto.createHmac('sha256', signingKey(secret)).update(payloadRaw).digest();
  const supplied = Buffer.from(signatureRaw, 'base64url');
  if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) {
    throw tokenError('Token de liberación inválido', 'RESERVA_RELEASE_TOKEN_INVALID');
  }
  let payload;
  try { payload = JSON.parse(Buffer.from(payloadRaw, 'base64url').toString('utf8')); } catch {
    throw tokenError('Token de liberación inválido', 'RESERVA_RELEASE_TOKEN_INVALID');
  }
  if (payload?.v !== TOKEN_VERSION || !Number.isInteger(payload?.rid) || payload.rid <= 0 ||
      typeof payload?.slot !== 'string' || typeof payload?.nonce !== 'string' || !Number.isFinite(payload?.exp)) {
    throw tokenError('Token de liberación inválido', 'RESERVA_RELEASE_TOKEN_INVALID');
  }
  if (payload.exp <= Math.floor(nowMs / 1000)) {
    throw tokenError('Token de liberación expirado', 'RESERVA_RELEASE_TOKEN_EXPIRED', 410);
  }
  return { reservationId: payload.rid, slotHash: payload.slot };
}

export function assertReservaMatchesReleaseToken(reserva, claims) {
  if (Number(reserva?.id) !== Number(claims?.reservationId) || slotHash(reserva) !== claims?.slotHash) {
    throw tokenError('El token no corresponde a la reserva', 'RESERVA_RELEASE_SLOT_MISMATCH', 403);
  }
  if (!isReservaReleasePendingState(reserva?.estado)) {
    throw tokenError('La reserva ya no está pendiente', 'RESERVA_RELEASE_INVALID_STATE', 409);
  }
}
