export const HANDLE_FIELDS = ['alias', 'username', 'apodo'];
export const MIN_HANDLE = 2, MAX_HANDLE = 80;
/** Canonico: sin @ inicial, trim, minusculas; rechaza @ interno, vacio corto/largo. */
export function normalizeHandle(value) {
  let s = String(value ?? '').trim().replace(/^@+/, '').toLowerCase();
  if (s.length < MIN_HANDLE || s.length > MAX_HANDLE || s.includes('@') || /\s/.test(s)) return null;
  return s;
}
/** Escapa literal para ILIKE (PostgREST quoted): \, %, _ y comillas dobles. */
export function escapeLikeLiteral(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_').replace(/"/g, '\\"');
}
function literalEquals(stored, wanted) {
  return normalizeHandle(stored) === wanted;
}
/** Consulta los tres campos con .ilike parametrizado (sin OR string), fail-closed. */
export async function isHandleTaken({ supabaseAdmin, handle, userId = null }) {
  const wanted = normalizeHandle(handle);
  if (!wanted) return { invalid: true, taken: true };
  const pattern = escapeLikeLiteral(wanted);
  for (const field of HANDLE_FIELDS) {
    const { data, error } = await supabaseAdmin.from('jugadores_perfil').select('user_id, alias, username, apodo')
      .ilike(field, pattern).limit(5);
    if (error) return { error: true, taken: true };
    const taken = (data || []).some((row) => {
      const own = userId && String(row.user_id || '') === String(userId);
      if (own) return false;
      return HANDLE_FIELDS.some((f) => literalEquals(row[f], wanted));
    });
    if (taken) return { invalid: false, taken: true };
  }
  return { invalid: false, taken: false };
}
