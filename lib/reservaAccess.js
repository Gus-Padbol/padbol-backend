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
 * Igual que resolveReservaAccess pero además expone el rol resuelto,
 * para que las rutas puedan aplicar restricciones extra (ej.: solo
 * super_admin puede reasignar la sede de una reserva).
 *
 * El scope se decide SIEMPRE contra la sede persistida en la reserva;
 * ningún sede_id enviado por el cliente participa de esta decisión.
 *
 * @returns {Promise<{ access: 'admin'|'owner'|null, rol: string|null }>}
 */
export async function resolveReservaAccessContext(user, reserva, {
  fetchUserRoleRowForAuthUser,
  legacySuperAdminEmails = [],
  supabaseAdmin,
  pgPool,
} = {}) {
  if (!user?.id) return { access: null, rol: null };

  const email = String(user.email || '').trim().toLowerCase();
  if (email && legacySuperAdminEmails.includes(email)) {
    return { access: 'admin', rol: 'super_admin' };
  }

  const roleRow = fetchUserRoleRowForAuthUser
    ? await fetchUserRoleRowForAuthUser(user)
    : null;
  const rol = String(roleRow?.role || roleRow?.rol || '').trim().toLowerCase() || null;

  if (rol === 'super_admin') return { access: 'admin', rol };

  if (rol === 'admin_club' && roleRow?.sede_id != null) {
    if (reserva.sede_id != null && Number(reserva.sede_id) === Number(roleRow.sede_id)) {
      return { access: 'admin', rol };
    }
    const sedeNombre = await resolveAdminClubSedeNombre(roleRow, { supabaseAdmin, pgPool });
    if (sedeNombre && String(reserva.sede || '').trim() === String(sedeNombre).trim()) {
      return { access: 'admin', rol };
    }
  }

  if (reserva.user_id && String(reserva.user_id) === String(user.id)) {
    return { access: 'owner', rol };
  }
  if (email && reserva.email && String(reserva.email).trim().toLowerCase() === email) {
    return { access: 'owner', rol };
  }

  return { access: null, rol };
}

/**
 * @returns {'admin'|'owner'|null}
 */
export async function resolveReservaAccess(user, reserva, deps = {}) {
  const { access } = await resolveReservaAccessContext(user, reserva, deps);
  return access;
}

/**
 * Gate canónico de escritura sobre una reserva puntual (PUT/DELETE):
 * - reserva inexistente → 404;
 * - usuario sin acceso (scope por sede persistida) → 403;
 * - acceso admin/owner → ok, con el rol resuelto.
 *
 * @param {object|null} user usuario autenticado (JWT ya validado por la ruta)
 * @param {object|null|undefined} reserva fila persistida de la base (o null si no existe)
 * @returns {Promise<{ ok: true, access: 'admin'|'owner', rol: string|null }
 *   | { ok: false, status: number, error: string }>}
 */
export async function authorizeReservaWrite(user, reserva, deps = {}) {
  if (!reserva) {
    return { ok: false, status: 404, error: 'Reserva no encontrada' };
  }

  const { access, rol } = await resolveReservaAccessContext(user, reserva, deps);
  if (!access) {
    return { ok: false, status: 403, error: 'No tenés permiso para esta reserva' };
  }

  return { ok: true, access, rol };
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

/**
 * `allowSedeReassign=false` (admin_club): se ignoran `sede`/`sede_id` del body
 * para que un admin de sede no pueda mover la reserva a otra sede.
 * Solo super_admin conserva la reasignación de sede.
 */
export function buildAdminReservaPutUpdates(body, { normalizeReservaCancha, allowSedeReassign = true } = {}) {
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
  if (allowSedeReassign) {
    if (sede !== undefined) updates.sede = sede;
    if (sede_id !== undefined) updates.sede_id = sede_id !== null ? parseInt(sede_id, 10) : null;
  }
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
