export function isAdminClubOrSuper(role) {
  return role?.rol === 'super_admin' || role?.rol === 'admin_club';
}

export async function resolveAuthRoleForUser(user, {
  fetchUserRoleRowForAuthUser,
  legacySuperAdminEmails = [],
} = {}) {
  const email = String(user?.email || '').trim().toLowerCase();
  const row = fetchUserRoleRowForAuthUser
    ? await fetchUserRoleRowForAuthUser(user)
    : null;

  if (!row && legacySuperAdminEmails.includes(email)) {
    return { rol: 'super_admin', sede_id: null };
  }

  const sedeIdRaw = row?.sede_id;
  const sedeIdNum = sedeIdRaw != null && sedeIdRaw !== '' ? Number(sedeIdRaw) : null;

  return {
    rol: String(row?.role || row?.rol || '').trim().toLowerCase() || null,
    sede_id: Number.isFinite(sedeIdNum) ? sedeIdNum : null,
  };
}

export async function requireAuthenticatedUser(req, res, getAuthenticatedUser) {
  const { user, status, error: authError } = await getAuthenticatedUser(req);
  if (!user) {
    res.status(status ?? 401).json({ error: authError ?? 'No autorizado' });
    return null;
  }
  return user;
}

export async function requireAdminUser(req, res, {
  getAuthenticatedUser,
  fetchUserRoleRowForAuthUser,
  legacySuperAdminEmails = [],
}) {
  const user = await requireAuthenticatedUser(req, res, getAuthenticatedUser);
  if (!user) return null;

  const role = await resolveAuthRoleForUser(user, {
    fetchUserRoleRowForAuthUser,
    legacySuperAdminEmails,
  });

  if (!isAdminClubOrSuper(role)) {
    res.status(403).json({ error: 'No tenés permiso para esta operación' });
    return null;
  }

  return { user, role };
}

async function resolveSedeNombreById(supabaseAdmin, sedeId) {
  if (sedeId == null || !supabaseAdmin) return null;
  const { data } = await supabaseAdmin
    .from('sedes')
    .select('nombre')
    .eq('id', sedeId)
    .maybeSingle();
  const nombre = data?.nombre ? String(data.nombre).trim() : '';
  return nombre || null;
}

/**
 * Alcance de listados de reservas:
 * - super_admin → todas
 * - admin_club → sede del rol
 * - jugador → ownerFilter (OR de email/user_id)
 */
export async function resolveReservasListScope(role, ownerFilter, supabaseAdmin) {
  if (role?.rol === 'super_admin') {
    return { kind: 'all' };
  }

  if (role?.rol === 'admin_club') {
    if (role.sede_id == null) {
      return { kind: 'forbidden' };
    }
    const sedeNombre = await resolveSedeNombreById(supabaseAdmin, role.sede_id);
    return { kind: 'sede', sedeId: role.sede_id, sedeNombre };
  }

  if (!ownerFilter) {
    return { kind: 'forbidden' };
  }

  return { kind: 'owner', ownerFilter };
}

export function applyReservasListScopeToQuery(query, scope) {
  if (scope.kind === 'all') {
    return query;
  }
  if (scope.kind === 'owner') {
    return query.or(scope.ownerFilter);
  }
  if (scope.kind === 'sede') {
    if (scope.sedeNombre) {
      const escaped = String(scope.sedeNombre).replace(/"/g, '\\"');
      return query.or(`sede_id.eq.${scope.sedeId},sede.eq."${escaped}"`);
    }
    return query.eq('sede_id', scope.sedeId);
  }
  return query;
}

const INTERNAL_SECRET_ENV_KEYS = ['INTERNAL_API_SECRET', 'RESERVAS_HOLD_CLEANUP_SECRET'];

export function isInternalApiSecretAuthorized(req, envKeys = INTERNAL_SECRET_ENV_KEYS) {
  const headerSecret = String(
    req.headers['x-internal-secret']
    ?? req.headers['x-cron-secret']
    ?? '',
  ).trim();
  if (!headerSecret) return false;

  for (const key of envKeys) {
    const configured = String(process.env[key] || '').trim();
    if (configured && headerSecret === configured) return true;
  }
  return false;
}

export async function requireAdminOrInternalSecret(req, res, {
  getAuthenticatedUser,
  fetchUserRoleRowForAuthUser,
  legacySuperAdminEmails = [],
} = {}) {
  if (isInternalApiSecretAuthorized(req)) {
    return { via: 'internal_secret', user: null, role: null };
  }

  const auth = await requireAdminUser(req, res, {
    getAuthenticatedUser,
    fetchUserRoleRowForAuthUser,
    legacySuperAdminEmails,
  });
  if (!auth) return null;

  return { via: 'admin', ...auth };
}

const SEDE_SENSITIVE_PATCH_KEYS = new Set([
  'mp_access_token',
  'mp_public_key',
  'stripe_account_id',
  'stripe_secret_key',
]);

export function filterSedePatchForRole(patch, role) {
  if (role?.rol === 'super_admin') return patch;
  const out = { ...patch };
  for (const key of SEDE_SENSITIVE_PATCH_KEYS) {
    delete out[key];
  }
  return out;
}

export async function requireSedeAdminForId(req, res, sedeId, {
  getAuthenticatedUser,
  fetchUserRoleRowForAuthUser,
  legacySuperAdminEmails = [],
} = {}) {
  const auth = await requireAdminUser(req, res, {
    getAuthenticatedUser,
    fetchUserRoleRowForAuthUser,
    legacySuperAdminEmails,
  });
  if (!auth) return null;

  if (auth.role.rol === 'super_admin') {
    return auth;
  }

  if (auth.role.rol === 'admin_club' && Number(auth.role.sede_id) === Number(sedeId)) {
    return auth;
  }

  res.status(403).json({ error: 'No tenés permiso para modificar esta sede' });
  return null;
}

export async function resolveIngresosListScope(role, supabaseAdmin) {
  if (role?.rol === 'super_admin') {
    return { kind: 'all' };
  }
  if (role?.rol === 'admin_club') {
    if (role.sede_id == null) {
      return { kind: 'forbidden' };
    }
    const sedeNombre = await resolveSedeNombreById(supabaseAdmin, role.sede_id);
    return { kind: 'sede', sedeId: role.sede_id, sedeNombre };
  }
  return { kind: 'forbidden' };
}
