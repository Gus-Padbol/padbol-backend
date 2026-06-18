import { cleanupExpiredReservaHolds } from '../src/cron/reservasHoldCleanup.js';

async function resolveAuthRole(user, { fetchUserRoleRowForAuthUser, legacySuperAdminEmails }) {
  const email = String(user.email || '').trim().toLowerCase();
  const row = await fetchUserRoleRowForAuthUser(user);
  if (!row && legacySuperAdminEmails.includes(email)) {
    return { rol: 'super_admin', sede_id: null };
  }
  const sedeIdRaw = row?.sede_id;
  const sedeIdNum = sedeIdRaw != null && sedeIdRaw !== '' ? Number(sedeIdRaw) : null;
  return {
    rol: String(row?.role || '').trim().toLowerCase() || null,
    sede_id: Number.isFinite(sedeIdNum) ? sedeIdNum : null,
  };
}

function isAdminClubOrSuper(role) {
  return role.rol === 'super_admin' || role.rol === 'admin_club';
}

function isInternalCleanupAuthorized(req) {
  const configuredSecret = String(process.env.RESERVAS_HOLD_CLEANUP_SECRET || '').trim();
  if (!configuredSecret) return false;

  const headerSecret = String(
    req.headers['x-internal-secret']
    ?? req.headers['x-cron-secret']
    ?? '',
  ).trim();

  return headerSecret.length > 0 && headerSecret === configuredSecret;
}

async function authorizeCleanupRequest(req, deps) {
  if (isInternalCleanupAuthorized(req)) {
    return { authorized: true, via: 'internal_secret' };
  }

  const { user, status, error: authError } = await deps.getAuthenticatedUser(req);
  if (!user) {
    return { authorized: false, status, error: authError ?? 'No autorizado' };
  }

  const role = await resolveAuthRole(user, deps);
  if (!isAdminClubOrSuper(role)) {
    return {
      authorized: false,
      status: 403,
      error: 'No tenés permiso para ejecutar la limpieza de holds vencidos',
    };
  }

  return { authorized: true, via: 'admin_jwt', user };
}

export function mountReservasHoldCleanupRoutes(app, {
  supabaseAdmin,
  pgPool,
  getAuthenticatedUser,
  fetchUserRoleRowForAuthUser,
  legacySuperAdminEmails = [],
}) {
  app.post('/api/reservas/cleanup-expired-holds', async (req, res) => {
    try {
      const auth = await authorizeCleanupRequest(req, {
        getAuthenticatedUser,
        fetchUserRoleRowForAuthUser,
        legacySuperAdminEmails,
      });

      if (!auth.authorized) {
        return res.status(auth.status ?? 401).json({ error: auth.error ?? 'No autorizado' });
      }

      const result = await cleanupExpiredReservaHolds({ supabaseAdmin, pgPool });

      console.log(
        `✓ POST /api/reservas/cleanup-expired-holds (${auth.via})`
        + ` — ${result.total} reserva(s), ${result.partidos_cancelados} partido(s)`,
      );

      return res.json({
        ok: true,
        via: auth.via,
        ...result,
      });
    } catch (err) {
      console.error('❌ POST /api/reservas/cleanup-expired-holds:', err.message);
      return res.status(500).json({ error: err.message || 'Error al limpiar holds vencidos' });
    }
  });
}
