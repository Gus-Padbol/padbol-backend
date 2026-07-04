export const TORNEO_ADMIN_ACCESS_REASON = {
  SIN_AUTH: 'sin_auth',
  SUPER_ADMIN: 'super_admin',
  ADMIN_CLUB_SEDE: 'admin_club_sede',
  SEDE_NO_COINCIDE: 'sede_no_coincide',
  ADMIN_SEDE_NO_TORNEO: 'admin_sede_no_torneo',
  ROL_NO_ADMIN: 'rol_no_admin',
};

function parseTorneoId(raw) {
  const id = Number.parseInt(String(raw ?? '').trim(), 10);
  if (!Number.isFinite(id) || id <= 0) return null;
  return id;
}

function normalizeTorneoSedeId(torneoSedeId) {
  if (torneoSedeId == null || torneoSedeId === '') return null;
  const sedeId = Number(torneoSedeId);
  return Number.isFinite(sedeId) ? sedeId : null;
}

/**
 * Evalúa si un usuario autenticado puede administrar un torneo de la sede indicada.
 * Alineado con requireTorneoAdminForSede / POST manual de resultado.
 *
 * @param {{ user?: object, role?: { rol?: string, sede_id?: number|null } } | null} auth
 * @param {number|string|null|undefined} torneoSedeId
 * @returns {{ allowed: boolean, reason: string }}
 */
export function resolveTorneoAdminAccess(auth, torneoSedeId) {
  if (!auth?.role?.rol) {
    return { allowed: false, reason: TORNEO_ADMIN_ACCESS_REASON.SIN_AUTH };
  }

  const rol = String(auth.role.rol).trim().toLowerCase();

  if (rol === 'super_admin') {
    return { allowed: true, reason: TORNEO_ADMIN_ACCESS_REASON.SUPER_ADMIN };
  }

  if (rol === 'admin_club') {
    const requiredSedeId = normalizeTorneoSedeId(torneoSedeId);
    const userSedeId = auth.role.sede_id != null ? Number(auth.role.sede_id) : null;

    if (requiredSedeId == null || userSedeId !== requiredSedeId) {
      return { allowed: false, reason: TORNEO_ADMIN_ACCESS_REASON.SEDE_NO_COINCIDE };
    }

    return { allowed: true, reason: TORNEO_ADMIN_ACCESS_REASON.ADMIN_CLUB_SEDE };
  }

  if (rol === 'admin_sede') {
    return { allowed: false, reason: TORNEO_ADMIN_ACCESS_REASON.ADMIN_SEDE_NO_TORNEO };
  }

  return { allowed: false, reason: TORNEO_ADMIN_ACCESS_REASON.ROL_NO_ADMIN };
}

export function buildTorneoPermisosPayload(torneoId, allowed) {
  return {
    ok: true,
    torneo_id: Number(torneoId),
    permisos: {
      puede_administrar: Boolean(allowed),
      puede_cargar_resultado: Boolean(allowed),
    },
  };
}

/**
 * Resuelve permisos de torneo para un usuario autenticado.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} supabaseAdmin
 * @param {{ user?: object, role?: object } | null} auth
 * @param {number|string} torneoId
 * @returns {Promise<{ statusCode: number, body: object }>}
 */
export async function buildTorneoPermisosResponse(supabaseAdmin, auth, torneoId) {
  const tid = parseTorneoId(torneoId);
  if (tid == null) {
    return {
      statusCode: 404,
      body: {
        ok: false,
        error: 'Torneo no encontrado',
        code: 'torneo_no_encontrado',
      },
    };
  }

  const { data: torneo, error } = await supabaseAdmin
    .from('torneos')
    .select('id, sede_id')
    .eq('id', tid)
    .maybeSingle();

  if (error) throw error;
  if (!torneo) {
    return {
      statusCode: 404,
      body: {
        ok: false,
        error: 'Torneo no encontrado',
        code: 'torneo_no_encontrado',
        torneo_id: tid,
      },
    };
  }

  const torneoSedeId = normalizeTorneoSedeId(torneo.sede_id);
  const { allowed } = resolveTorneoAdminAccess(auth, torneoSedeId);

  return {
    statusCode: 200,
    body: buildTorneoPermisosPayload(tid, allowed),
  };
}

/**
 * Handler HTTP para GET /api/torneos/:torneoId/permisos.
 */
export async function handleGetTorneoPermisos(req, deps = {}) {
  const getAuthenticatedUserFn = deps.getAuthenticatedUser;
  const resolveAuthRoleFn = deps.resolveAuthRoleForUser;
  const buildPermisosFn = deps.buildTorneoPermisosResponse ?? buildTorneoPermisosResponse;
  const supabaseAdmin = deps.supabaseAdmin;

  if (typeof getAuthenticatedUserFn !== 'function') {
    throw new Error('getAuthenticatedUser dependency required');
  }
  if (!supabaseAdmin) {
    throw new Error('supabaseAdmin dependency required');
  }

  const { user, status, error: authError } = await getAuthenticatedUserFn(req);
  if (!user) {
    return {
      statusCode: status ?? 401,
      body: { error: authError ?? 'No autorizado' },
    };
  }

  const role = resolveAuthRoleFn
    ? await resolveAuthRoleFn(user, deps.resolveAuthRoleOptions ?? {})
    : user.role ?? null;

  return buildPermisosFn(
    supabaseAdmin,
    { user, role },
    req.params?.torneoId,
  );
}
