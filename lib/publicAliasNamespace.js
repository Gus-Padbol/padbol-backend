const HANDLE_FIELDS = ['alias', 'username', 'apodo'];
const escapeLike = (s) => String(s).replace(/[\\%_]/g, '\\$&');
/** True si el handle está tomado por OTRO user_id en alias/username/apodo. */
export async function isHandleTaken({ supabaseAdmin, handle, userId = null }) {
  const value = String(handle || '').replace(/^@+/, '').trim();
  if (!value || value.length > 80 || value.includes('@')) return { invalid: true, taken: true };
  const literal = escapeLike(value);
  const { data, error } = await supabaseAdmin.from('jugadores_perfil')
    .select('user_id, alias, username, apodo')
    .or(HANDLE_FIELDS.map((f) => `${f}.ilike."${literal}"`).join(','))
    .limit(5);
  if (error) return { error: true, taken: true };
  const taken = (data || []).some((row) => {
    const own = userId && String(row.user_id || '') === String(userId);
    if (own) return false;
    return HANDLE_FIELDS.some((f) => String(row[f] || '').replace(/^@+/, '').trim().toLowerCase() === value.toLowerCase());
  });
  return { invalid: false, taken };
}
