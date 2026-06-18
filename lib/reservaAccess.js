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
