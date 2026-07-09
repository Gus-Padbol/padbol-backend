import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from 'node:crypto';

const ENCRYPTION_PREFIX = 'enc:v1:';
const PENDING_PREFIX = 'pending_encryption:v1:';

function deriveKey(rawSecret) {
  const trimmed = String(rawSecret ?? '').trim();
  if (!trimmed) return null;

  if (/^[0-9a-f]{64}$/i.test(trimmed)) {
    return Buffer.from(trimmed, 'hex');
  }

  try {
    const decoded = Buffer.from(trimmed, 'base64');
    if (decoded.length === 32) return decoded;
  } catch {
    // fall through to scrypt
  }

  return scryptSync(trimmed, 'padbol-jugador-identidad-v1', 32);
}

export function hasIdentidadEncryptionKey() {
  return Boolean(process.env.IDENTIDAD_ENCRYPTION_KEY?.trim());
}

/**
 * Almacenamiento interno del número de documento.
 * Con IDENTIDAD_ENCRYPTION_KEY → AES-256-GCM.
 * Sin clave → prefijo pending_encryption (NO es cifrado fuerte; ver docs).
 */
export function encryptDocumentoForStorage(numeroNormalizado) {
  const plain = String(numeroNormalizado ?? '').trim();
  if (!plain) return null;

  const key = deriveKey(process.env.IDENTIDAD_ENCRYPTION_KEY);
  if (!key) {
    return `${PENDING_PREFIX}${Buffer.from(plain, 'utf8').toString('base64url')}`;
  }

  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  const payload = [
    iv.toString('base64url'),
    authTag.toString('base64url'),
    encrypted.toString('base64url'),
  ].join(':');

  return `${ENCRYPTION_PREFIX}${payload}`;
}

export function decryptDocumentoFromStorage(stored) {
  const value = String(stored ?? '').trim();
  if (!value) return null;

  if (value.startsWith(PENDING_PREFIX)) {
    try {
      return Buffer.from(value.slice(PENDING_PREFIX.length), 'base64url').toString('utf8');
    } catch {
      return null;
    }
  }

  if (!value.startsWith(ENCRYPTION_PREFIX)) return null;

  const key = deriveKey(process.env.IDENTIDAD_ENCRYPTION_KEY);
  if (!key) return null;

  const payload = value.slice(ENCRYPTION_PREFIX.length);
  const [ivB64, tagB64, dataB64] = payload.split(':');
  if (!ivB64 || !tagB64 || !dataB64) return null;

  try {
    const iv = Buffer.from(ivB64, 'base64url');
    const authTag = Buffer.from(tagB64, 'base64url');
    const encrypted = Buffer.from(dataB64, 'base64url');
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

export function isPendingEncryptionStorage(stored) {
  return String(stored ?? '').startsWith(PENDING_PREFIX);
}
