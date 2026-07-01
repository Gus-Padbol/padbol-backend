import crypto from 'node:crypto';

/** Genera token seguro para control de árbitro (devolver UNA sola vez al cliente). */
export function generateControlToken() {
  return crypto.randomBytes(32).toString('base64url');
}

/** Hash SHA-256 del token; único valor persistido en DB. */
export function hashControlToken(token) {
  return crypto.createHash('sha256').update(String(token ?? ''), 'utf8').digest('hex');
}

/** Comparación timing-safe entre token recibido y hash almacenado. */
export function verifyControlToken(token, storedHash) {
  if (token == null || token === '' || storedHash == null || storedHash === '') {
    return false;
  }

  const incomingHash = hashControlToken(token);
  const a = Buffer.from(incomingHash, 'hex');
  const b = Buffer.from(String(storedHash), 'hex');

  if (a.length !== b.length) return false;

  try {
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

export function buildControlPath(token) {
  return `/scoreboard/control/${encodeURIComponent(String(token))}`;
}

/** Para logs: nunca imprimir token completo. */
export function maskControlTokenForLog(token) {
  const s = String(token ?? '').trim();
  if (!s) return '(empty)';
  if (s.length <= 8) return '***';
  return `${s.slice(0, 4)}…${s.slice(-4)}`;
}

export function parseControlTokenParam(raw) {
  const token = String(raw ?? '').trim();
  if (!token) {
    throw Object.assign(new Error('Token de control inválido'), { status: 400 });
  }
  if (token.length > 512) {
    throw Object.assign(new Error('Token de control inválido'), { status: 400 });
  }
  return token;
}

export function stripSensitiveControlFields(row) {
  if (!row || typeof row !== 'object') return row;
  const {
    control_token_hash: _hash,
    control_token_created_at: _created,
    control_token_revoked_at: _revoked,
    ...rest
  } = row;
  return rest;
}
