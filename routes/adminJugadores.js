import { requireAdminUser } from '../lib/authAccess.js';
import {
  ADMIN_JUGADORES_SEARCH_MIN,
  listAdminJugadoresSede,
  parseLimit,
  parsePage,
  parseSedeIdParam,
  resolveAdminJugadoresScope,
  searchAdminJugadoresGlobal,
} from '../lib/adminJugadoresService.js';

export function mountAdminJugadoresRoutes(app, {
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

  /**
   * GET /api/admin/jugadores/buscar?q=&sede_id=&limit=
   * Autocomplete for registered players (MEJ-05). Admin only.
   */
  app.get('/api/admin/jugadores/buscar', async (req, res) => {
    try {
      const auth = await requireAdminUser(req, res, adminDeps);
      if (!auth) return;

      const requestedSedeId = parseSedeIdParam(req.query.sede_id);
      const scope = resolveAdminJugadoresScope(auth.role, requestedSedeId);
      if (!scope.ok) {
        return res.status(scope.status).json({ error: scope.error });
      }

      const q = String(req.query.q ?? '');
      if (String(q).replace(/^@+/, '').trim().length < ADMIN_JUGADORES_SEARCH_MIN) {
        return res.json({ items: [], q: '' });
      }

      const limit = parseLimit(req.query.limit, 12);
      const result = await searchAdminJugadoresGlobal(supabaseAdmin, {
        q,
        limit,
        sedeId: scope.sedeId,
      });
      return res.json(result);
    } catch (err) {
      console.error('❌ GET /api/admin/jugadores/buscar:', err.message);
      return res.status(500).json({ error: err.message || 'Error al buscar jugadores' });
    }
  });

  /**
   * GET /api/admin/jugadores?sede_id=&q=&page=&limit=
   * Roster for Admin "Jugadores" tab: players with reservation history at sede (MEJ-04).
   * Admin club: forced to own sede. Super admin: sede_id required (or optional global search via buscar).
   */
  app.get('/api/admin/jugadores', async (req, res) => {
    try {
      const auth = await requireAdminUser(req, res, adminDeps);
      if (!auth) return;

      const requestedSedeId = parseSedeIdParam(req.query.sede_id);
      const scope = resolveAdminJugadoresScope(auth.role, requestedSedeId);
      if (!scope.ok) {
        return res.status(scope.status).json({ error: scope.error });
      }

      if (scope.sedeId == null) {
        return res.status(400).json({
          error: 'Seleccioná una sede (sede_id) para listar jugadores',
          code: 'SEDE_REQUIRED',
        });
      }

      const page = parsePage(req.query.page);
      const limit = parseLimit(req.query.limit);
      const q = String(req.query.q ?? '');

      const result = await listAdminJugadoresSede(supabaseAdmin, {
        sedeId: scope.sedeId,
        q,
        page,
        limit,
      });
      return res.json(result);
    } catch (err) {
      console.error('❌ GET /api/admin/jugadores:', err.message);
      return res.status(500).json({ error: err.message || 'Error al listar jugadores' });
    }
  });
}
