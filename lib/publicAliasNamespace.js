export const HANDLE_FIELDS = ['alias', 'username', 'apodo'];
export const MIN_HANDLE = 2, MAX_HANDLE = 80;
/** Canonico: sin @ inicial, trim, minusculas; rechaza @ interno, vacio corto/largo. */
export function normalizeHandle(value) {
  let s = String(value ?? '').trim().replace(/^@+/, '').toLowerCase();
  if (s.length < MIN_HANDLE || s.length > MAX_HANDLE || s.includes('@') || /\s/.test(s)) return null;
  return s;
}
// ECMAScript trim whitespace, explicitly enumerated for PostgreSQL regex portability.
const TRIM_CHARS = '\u0009-\u000d\u0020\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff';
export function escapeRegexLiteral(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
export function handleMatchPattern(normalizedHandle) {
  return `^[${TRIM_CHARS}]*@*${escapeRegexLiteral(normalizedHandle)}[${TRIM_CHARS}]*$`;
}
/** Consulta los tres campos con imatch (~*), sin OR string; fail-closed. */
export async function isHandleTaken({ supabaseAdmin, handle, userId = null }) {
  const wanted = normalizeHandle(handle);
  if (!wanted) return { invalid: true, taken: true };
  const pattern = handleMatchPattern(wanted);
  for (const field of HANDLE_FIELDS) {
    const { data, error } = await supabaseAdmin.from('jugadores_perfil').select('user_id')
      .filter(field, 'imatch', pattern).limit(5);
    if (error) return { error: true, taken: true };
    // PostgreSQL matching is authoritative: never discard a SQL match using a
    // second JS case-folding rule. A different/null owner blocks availability.
    const taken = (data || []).some((row) => !userId || String(row.user_id || '') !== String(userId));
    if (taken) return { invalid: false, taken: true };
  }
  return { invalid: false, taken: false };
}
