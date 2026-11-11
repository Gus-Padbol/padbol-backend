// Private profile access. Public /perfiles intentionally keeps its small DTO.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const AUTHENTICATED_PROFILE_SELECT = [
  'id', 'user_id', 'nombre', 'nombre_saludo', 'apellido', 'telefono', 'whatsapp',
  'nivel', 'lateralidad', 'posicion_cancha', 'pais', 'ciudad', 'email', 'foto_url',
  'username', 'alias', 'apodo', 'companero_habitual_id', 'xp', 'liga',
].join(', ');

function failure(code, status = 409) {
  return Object.assign(new Error(code), { code, status });
}
function identity(user) {
  const uid = String(user?.id ?? '').trim();
  if (!UUID.test(uid)) throw failure('PROFILE_IDENTITY_UNVERIFIED', 401);
  return { uid, email: String(user?.email ?? '').trim() };
}
function rows(result) {
  if (result.error) throw result.error;
  if (!Array.isArray(result.data)) throw failure('PROFILE_READ_INVALID');
  if (result.data.length > 1) throw failure('PROFILE_AMBIGUOUS');
  return result.data[0] ?? null;
}
function assertRow(row) {
  if (row && (row.id == null || String(row.id).trim() === '')) throw failure('PROFILE_ROW_INVALID');
}

export async function readAuthenticatedPlayerProfile(db, user) {
  const { uid, email } = identity(user);
  const owned = rows(await db.from('jugadores_perfil')
    .select(AUTHENTICATED_PROFILE_SELECT).eq('user_id', uid).limit(2));
  assertRow(owned);
  if (owned) {
    if (String(owned.user_id).toLowerCase() !== uid.toLowerCase()) throw failure('PROFILE_IDENTITY_UNVERIFIED');
    return owned;
  }
  if (!email) return null;
  const legacy = rows(await db.from('jugadores_perfil')
    .select(AUTHENTICATED_PROFILE_SELECT).eq('email', email).is('user_id', null).limit(2));
  assertRow(legacy);
  if (legacy && (legacy.user_id != null || legacy.email !== email)) throw failure('PROFILE_IDENTITY_UNVERIFIED');
  return legacy;
}

export async function updateAuthenticatedPlayerProfile(db, user, current, patch) {
  const { uid, email } = identity(user);
  assertRow(current);
  if (!current) throw failure('PROFILE_NOT_FOUND', 404);
  if (patch.id !== undefined || patch.user_id !== undefined || patch.email !== undefined) {
    throw failure('PROFILE_IDENTITY_PATCH_REJECTED', 400);
  }
  const legacy = current.user_id == null;
  if (legacy ? (!email || current.email !== email) : String(current.user_id).toLowerCase() !== uid.toLowerCase()) {
    throw failure('PROFILE_IDENTITY_UNVERIFIED');
  }
  let query = db.from('jugadores_perfil')
    .update(legacy ? { ...patch, user_id: uid } : patch).eq('id', current.id);
  query = legacy ? query.is('user_id', null).eq('email', email) : query.eq('user_id', uid);
  const updated = rows(await query.select(AUTHENTICATED_PROFILE_SELECT));
  if (!updated || String(updated.id) !== String(current.id)
    || String(updated.user_id).toLowerCase() !== uid.toLowerCase()) {
    throw failure('PROFILE_WRITE_CONFLICT');
  }
  return updated;
}
