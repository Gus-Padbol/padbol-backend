export const RESERVA_PUT_SENSITIVE_FIELDS = new Set([
  'estado',
  'precio',
  'precio_esperado',
  'pago_estado',
  'mp_payment_id',
  'sede',
  'sede_id',
  'fecha',
  'hora',
  'hora_inicio',
  'hora_fin',
  'cancha',
  'email',
  'user_id',
  'duracion',
  'duracion_minutos',
]);

async function resolveAdminClubSedeNombre(roleRow, { supabaseAdmin, pgPool } = {}) {
  if (roleRow?.sede_id == null) return null;
  if (pgPool) {
    const { rows } = await pgPool.query('SELECT nombre FROM sedes WHERE id = $1 LIMIT 1', [roleRow.sede_id]);
    return rows[0]?.nombre ?? null;
  }
  if (supabaseAdmin) {
    const { data } = await supabaseAdmin.from('sedes').select('nombre').eq('id', roleRow.sede_id).maybeSingle();
    return data?.nombre ?? null;
  }
  return null;
}

/**
 * @returns {'admin'|'owner'|null}
 */
export async function resolveReservaAccess(user, reserva, {
  fetchUserRoleRowForAuthUser,
  legacySuperAdminEmails = [],
  supabaseAdmin,
  pgPool,
} = {}) {
  if (!user?.id) return null;

  const email = String(user.email || '').trim().toLowerCase();
  if (email && legacySuperAdminEmails.includes(email)) return 'admin';

  const roleRow = fetchUserRoleRowForAuthUser
    ? await fetchUserRoleRowForAuthUser(user)
    : null;
  const rol = String(roleRow?.role || roleRow?.rol || '').trim().toLowerCase();

  if (rol === 'super_admin') return 'admin';

  if (rol === 'admin_club' && roleRow?.sede_id != null) {
    if (reserva.sede_id != null && Number(reserva.sede_id) === Number(roleRow.sede_id)) {
      return 'admin';
    }
    const sedeNombre = await resolveAdminClubSedeNombre(roleRow, { supabaseAdmin, pgPool });
    if (sedeNombre && String(reserva.sede || '').trim() === String(sedeNombre).trim()) {
      return 'admin';
    }
  }

  if (reserva.user_id && String(reserva.user_id) === String(user.id)) return 'owner';
  if (email && reserva.email && String(reserva.email).trim().toLowerCase() === email) {
    return 'owner';
  }

  return null;
}

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
    const sedeNombre = await resolveAdminClubSedeNombre(roleRow, { supabaseAdmin, pgPool });
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

export function buildNormalUserReservaPutUpdates(body) {
  const payload = body ?? {};
  const keys = Object.keys(payload).filter((key) => payload[key] !== undefined);

  const sensitive = keys.filter((key) => RESERVA_PUT_SENSITIVE_FIELDS.has(key));
  if (sensitive.length > 0) {
    const err = new Error('No tenés permiso para editar esta reserva');
    err.status = 403;
    throw err;
  }

  if (!keys.includes('nombre')) {
    const err = new Error('No tenés permiso para editar esta reserva');
    err.status = 403;
    throw err;
  }

  return { nombre: payload.nombre };
}

export function buildAdminReservaPutUpdates(body, { normalizeReservaCancha } = {}) {
  const {
    sede,
    sede_id,
    fecha,
    hora,
    hora_inicio,
    hora_fin,
    cancha,
    nombre,
    email,
    user_id,
    precio,
    precio_esperado,
    pago_estado,
    mp_payment_id,
    estado,
    duracion,
    duracion_minutos,
  } = body ?? {};

  const updates = {};
  if (sede !== undefined) updates.sede = sede;
  if (sede_id !== undefined) updates.sede_id = sede_id !== null ? parseInt(sede_id, 10) : null;
  if (fecha !== undefined) updates.fecha = fecha;
  if (hora !== undefined) updates.hora = hora;
  if (hora_inicio !== undefined) updates.hora_inicio = hora_inicio;
  if (hora_inicio !== undefined && hora === undefined) updates.hora = hora_inicio;
  if (hora_fin !== undefined) updates.hora_fin = hora_fin;
  if (cancha !== undefined) {
    updates.cancha = cancha !== null && normalizeReservaCancha
      ? normalizeReservaCancha(cancha)
      : cancha;
  }
  if (nombre !== undefined) updates.nombre = nombre;
  if (email !== undefined) updates.email = email;
  if (user_id !== undefined) updates.user_id = user_id;
  if (precio !== undefined) updates.precio = precio !== null ? parseInt(precio, 10) : null;
  if (precio_esperado !== undefined) {
    updates.precio_esperado = precio_esperado !== null ? parseInt(precio_esperado, 10) : null;
  }
  if (pago_estado !== undefined) updates.pago_estado = pago_estado;
  if (mp_payment_id !== undefined) updates.mp_payment_id = mp_payment_id;
  if (estado !== undefined) updates.estado = estado;

  const durationValue = duracion_minutos ?? duracion;
  if (durationValue !== undefined) {
    updates.duracion_minutos = durationValue !== null ? parseInt(durationValue, 10) : null;
  }

  return updates;
}
