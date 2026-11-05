import { createHmac, timingSafeEqual } from 'node:crypto';

export const SPACE_UPLOAD_SCOPE = 'commercial-space-upload';
export const SPACE_UPLOAD_MAX_TTL_SECONDS = 600;
export const SPACE_UPLOAD_MAX_TOKEN_LENGTH = 4096;
const DOMAIN = 'padbol:commercial-space-upload:v1.';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const now = () => Math.floor(Date.now() / 1000);
const validSecret = secret => typeof secret === 'string' && secret.trim().length > 0;
const validTime = value => Number.isSafeInteger(value) && value >= 0;
const sign = (payload, secret) => createHmac('sha256', secret).update(DOMAIN + payload, 'utf8').digest();
const invalid = () => Object.assign(new Error('Token de carga inválido o vencido.'), { code: 'SPACE_UPLOAD_TOKEN_INVALID', status: 401 });

/** Server-side issuance only. Never expose the shared inbound secret to a browser. */
export function createSpaceUploadToken({ secret, conversationId, ttlSeconds = SPACE_UPLOAD_MAX_TTL_SECONDS, nowSeconds = now() } = {}) {
  if (!validSecret(secret) || typeof conversationId !== 'string' || !UUID.test(conversationId)
    || !validTime(nowSeconds) || !Number.isSafeInteger(ttlSeconds) || ttlSeconds < 1
    || ttlSeconds > SPACE_UPLOAD_MAX_TTL_SECONDS || !validTime(nowSeconds + ttlSeconds)) {
    throw new TypeError('Invalid space upload token parameters.');
  }
  const claims = { v: 1, scope: SPACE_UPLOAD_SCOPE, conversationId: conversationId.toLowerCase(), iat: nowSeconds, exp: nowSeconds + ttlSeconds };
  const payload = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
  return `${payload}.${sign(payload, secret).toString('base64url')}`;
}

/** Upload-only capability; caller must use this exclusively on its upload endpoint.
 * nowSeconds, iat and exp are integer Unix seconds. No clock-skew grace is granted.
 * conversationId is mandatory and binds the capability to the requested destination.
 */
export function verifySpaceUploadToken({ token, secret, conversationId, nowSeconds = now() } = {}) {
  if (!validSecret(secret) || typeof conversationId !== 'string' || !UUID.test(conversationId)
    || !validTime(nowSeconds) || typeof token !== 'string' || !token.length
    || token.length > SPACE_UPLOAD_MAX_TOKEN_LENGTH) throw invalid();
  const parts = token.split('.');
  if (parts.length !== 2 || !parts.every(part => BASE64URL.test(part))) throw invalid();
  const [payload, signature] = parts;
  const supplied = Buffer.from(signature, 'base64url');
  // Reject alternate/noncanonical encodings; compare every valid-length MAC in constant time.
  if (supplied.length !== 32 || supplied.toString('base64url') !== signature
    || !timingSafeEqual(supplied, sign(payload, secret))) throw invalid();
  let claims;
  try {
    const decoded = Buffer.from(payload, 'base64url');
    if (decoded.toString('base64url') !== payload) throw invalid();
    claims = JSON.parse(decoded.toString('utf8'));
  } catch { throw invalid(); }
  if (!claims || typeof claims !== 'object' || Array.isArray(claims)
    || Object.keys(claims).sort().join(',') !== 'conversationId,exp,iat,scope,v'
    || claims.v !== 1 || claims.scope !== SPACE_UPLOAD_SCOPE
    || typeof claims.conversationId !== 'string' || !UUID.test(claims.conversationId)
    || claims.conversationId.toLowerCase() !== conversationId.toLowerCase()
    || !validTime(claims.iat) || !validTime(claims.exp)
    || claims.iat > nowSeconds || claims.exp <= nowSeconds
    || claims.exp <= claims.iat || claims.exp - claims.iat > SPACE_UPLOAD_MAX_TTL_SECONDS) throw invalid();
  return claims;
}
