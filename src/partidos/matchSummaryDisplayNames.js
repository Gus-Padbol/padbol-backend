const TECHNICAL_EXACT = new Set([
  'test',
  'prueba',
  'demo',
  'admin',
  'usuario',
  'user',
  'guest',
  'jugador',
  'player',
  'null',
  'undefined',
  'padbolinternacional',
]);

const TECHNICAL_PREFIX_RE = /^(test|prueba|demo|admin|usuario|user|guest|padbolmatch|padbol)/i;

/**
 * Nombres aptos para crónica deportiva (no emails, cuentas técnicas ni placeholders).
 * @param {unknown} name
 */
export function isTrustworthyPlayerDisplayName(name) {
  if (name == null || typeof name !== 'string') return false;

  const cleaned = name.replace(/[\n\r\t<>]/g, '').trim();
  if (!cleaned || cleaned.includes('@')) return false;
  if (cleaned.length < 2 || cleaned.length > 40) return false;

  const lower = cleaned.toLowerCase();
  if (TECHNICAL_EXACT.has(lower)) return false;
  if (TECHNICAL_PREFIX_RE.test(lower)) return false;
  if (/^padbolmatch/i.test(lower)) return false;

  // Usernames técnicos: una sola palabra, minúsculas/números, sin espacios.
  if (!/\s/.test(cleaned) && /^[a-z0-9_.-]+$/.test(lower)) {
    if (/\d/.test(lower) && lower.length >= 8) return false;
    if (lower.length >= 14) return false;
  }

  return true;
}

export function sanitizePlayerDisplayNameForSummary(name, fallback = 'Jugador') {
  if (!isTrustworthyPlayerDisplayName(name)) return fallback;
  return String(name).replace(/[\n\r\t<>]/g, '').trim().slice(0, 40);
}

export const ADMIN_SUMMARY_PATTERNS = [
  /confirmado por/i,
  /resultado confirmado/i,
  /resultado fue confirmado/i,
  /registrado en padbol match/i,
  /seg[uú]n el sistema/i,
  /datos cargados/i,
  /ambos capitanes/i,
  /cargado por capitanes/i,
  /\ben padbol match\b/i,
];

export function summaryContainsAdministrativeLanguage(text) {
  const value = String(text ?? '');
  return ADMIN_SUMMARY_PATTERNS.some((pattern) => pattern.test(value));
}

/**
 * Detecta usernames técnicos, emails y "equipo formado por..." en texto visible.
 * @param {string} text
 * @param {object|null} payload
 */
export function summaryContainsUntrustworthyIdentifiers(text, payload = null) {
  const value = String(text ?? '');
  const lower = value.toLowerCase();

  if (/equipo formado por/i.test(lower)) return true;

  const blockedFragments = ['padbolmatchsaas', 'padbolmatch', 'padbolinternacional', '@'];
  for (const fragment of blockedFragments) {
    if (lower.includes(fragment)) return true;
  }

  for (const equipoKey of ['equipo1', 'equipo2']) {
    for (const jugador of payload?.equipos?.[equipoKey]?.jugadores ?? []) {
      const name = jugador?.nombre_display;
      if (!name || typeof name !== 'string') continue;
      const nameLower = name.toLowerCase();
      if (!lower.includes(nameLower)) continue;
      if (!isTrustworthyPlayerDisplayName(name)) return true;
    }
  }

  return false;
}
