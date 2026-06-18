export async function assertReservaOwnerOrAdmin(user, reserva, {
  fetchUserRoleRowForAuthUser,
  legacySuperAdminEmails = [],
  supabaseAdmin,
  pgPool,
} = {}) {
  if (!user?.id) {
    const err = new Error('No autorizado');
    err.status = 401;
    throw err;
  }

  const email = String(user.email || '').trim().toLowerCase();
  if (email && legacySuperAdminEmails.includes(email)) return true;

  const roleRow = fetchUserRoleRowForAuthUser
    ? await fetchUserRoleRowForAuthUser(user)
    : null;
  const rol = String(roleRow?.role || roleRow?.rol || '').trim().toLowerCase();

  if (rol === 'super_admin') return true;

  if (rol === 'admin_club' && roleRow?.sede_id != null) {
    if (reserva.sede_id != null && Number(reserva.sede_id) === Number(roleRow.sede_id)) {
      return true;
    }
    let sedeNombre = null;
    if (pgPool) {
      const { rows } = await pgPool.query('SELECT nombre FROM sedes WHERE id = $1 LIMIT 1', [roleRow.sede_id]);
      sedeNombre = rows[0]?.nombre ?? null;
    } else if (supabaseAdmin) {
      const { data } = await supabaseAdmin.from('sedes').select('nombre').eq('id', roleRow.sede_id).maybeSingle();
      sedeNombre = data?.nombre ?? null;
    }
    if (sedeNombre && String(reserva.sede || '').trim() === String(sedeNombre).trim()) {
      return true;
    }
  }

  if (reserva.user_id && String(reserva.user_id) === String(user.id)) return true;
  if (email && reserva.email && String(reserva.email).trim().toLowerCase() === email) return true;

  const err = new Error('No tenés permiso para esta reserva');
  err.status = 403;
  throw err;
}

/**
 * Cancelación compatible con Nativa: JWT obligatorio.
 * Dueño por user_id; fallback email del body solo si coincide con JWT y reserva.
 * Admin/sede vía assertReservaOwnerOrAdmin.
 */
export async function assertCancelReservaOwnerCompat(user, reserva, bodyEmail, deps = {}) {
  try {
    await assertReservaOwnerOrAdmin(user, reserva, deps);
    return;
  } catch (err) {
    if (err.status !== 403) throw err;
  }

  const jwtUserId = user?.id ? String(user.id) : null;
  const jwtEmail = String(user.email || '').trim().toLowerCase();
  const reservaUserId = reserva?.user_id ? String(reserva.user_id) : null;
  const reservaEmail = reserva?.email ? String(reserva.email).trim().toLowerCase() : null;
  const bodyEmailNorm = bodyEmail != null && String(bodyEmail).trim() !== ''
    ? String(bodyEmail).trim().toLowerCase()
    : null;

  if (jwtUserId && reservaUserId && jwtUserId === reservaUserId) {
    return;
  }

  if (
    bodyEmailNorm
    && jwtEmail
    && reservaEmail
    && bodyEmailNorm === jwtEmail
    && bodyEmailNorm === reservaEmail
  ) {
    return;
  }

  const err = new Error('Reserva no encontrada o no pertenece a este usuario');
  err.status = 403;
  throw err;
}
