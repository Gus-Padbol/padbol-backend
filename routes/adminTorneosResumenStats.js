import { requireAdminUser } from '../lib/authAccess.js';
import { sendHttpError } from '../lib/httpErrors.js';
import { getTorneosResumenStats } from '../lib/torneos/torneosResumenStatsService.js';

/**
 * GET /api/admin/torneos/resumen-stats
 *
 * Endpoint aditivo batch para badges del tab Torneos del Panel Admin.
 * No modifica GET /api/torneos/:id/equipos ni /partidos.
 */
export function mountAdminTorneosResumenStatsRoutes(app, {
  supabaseAdmin,
  getAuthenticatedUser,
  fetchUserRoleRowForAuthUser,
  legacySuperAdminEmails = [],
}) {
  const adminDeps = {
    getAuthenticatedUser,
    fetchUserRoleRowForAuthUser,
    legacySuperAdminEmails,
  };

  app.get('/api/admin/torneos/resumen-stats', async (req, res) => {
    try {
      const auth = await requireAdminUser(req, res, adminDeps);
      if (!auth) return;

      const result = await getTorneosResumenStats(supabaseAdmin, {
        role: auth.role,
        query: req.query,
      });

      return res.status(200).json({
        ok: true,
        data: {
          items: result.items,
        },
      });
    } catch (err) {
      return sendHttpError(res, err, {
        context: 'GET /api/admin/torneos/resumen-stats',
        fallbackMessage: 'No se pudo obtener el resumen de torneos',
      });
    }
  });
}
