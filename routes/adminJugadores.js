import { requireAdminUser } from '../lib/authAccess.js';
import {
  ADMIN_JUGADORES_SEARCH_MIN,
  desvincularJugadorSede,
  listAdminJugadoresSede,
  parseLimit,
  parsePage,
  parseSedeIdParam,
  parseVinculadoFilter,
  resolveAdminJugadoresScope,
  searchAdminJugadoresGlobal,
  vincularJugadorSede,
} from '../lib/adminJugadoresService.js';

function sendServiceError(res, err, fallback) {
  const status = Number(err?.status) || 500;
  const body = { error: err?.message || fallback };
  if (err?.code) body.code = err.code;
  return res.status(status).json(body);
}

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
      return sendServiceError(res, err, 'Error al buscar jugadores');
    }
  });

  /**
   * GET /api/admin/jugadores?sede_id=&q=&page=&limit=&vinculado=
   * Roster: historial de reservas ∪ vínculos formales activos (MEJ-04).
   * Admin club: forced to own sede. Super admin: sede_id required.
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
      const vinculado = parseVinculadoFilter(req.query.vinculado);

      const result = await listAdminJugadoresSede(supabaseAdmin, {
        sedeId: scope.sedeId,
        q,
        page,
        limit,
        vinculado,
      });
      return res.json(result);
    } catch (err) {
      console.error('❌ GET /api/admin/jugadores:', err.message);
      return sendServiceError(res, err, 'Error al listar jugadores');
    }
  });

  /**
   * POST /api/admin/jugadores/:userId/vincular
   * Body: { sede_id, origen?, notas? }
   */
  app.post('/api/admin/jugadores/:userId/vincular', async (req, res) => {
    try {
      const auth = await requireAdminUser(req, res, adminDeps);
      if (!auth) return;

      const sedeId = parseSedeIdParam(req.body?.sede_id ?? req.query?.sede_id);
      if (sedeId == null) {
        return res.status(400).json({ error: 'sede_id es requerido', code: 'SEDE_REQUIRED' });
      }

      const result = await vincularJugadorSede(supabaseAdmin, {
        role: auth.role,
        userId: req.params.userId,
        sedeId,
        origen: req.body?.origen,
        notas: req.body?.notas,
        adminUserId: auth.user?.id || null,
      });
      return res.json(result);
    } catch (err) {
      console.error('❌ POST /api/admin/jugadores/:userId/vincular:', err.message);
      return sendServiceError(res, err, 'Error al vincular jugador');
    }
  });

  /**
   * POST /api/admin/jugadores/:userId/desvincular
   * Body/query: { sede_id }
   * Soft-unlink: conserva historial (estado=inactivo).
   */
  app.post('/api/admin/jugadores/:userId/desvincular', async (req, res) => {
    try {
      const auth = await requireAdminUser(req, res, adminDeps);
      if (!auth) return;

      const sedeId = parseSedeIdParam(req.body?.sede_id ?? req.query?.sede_id);
      if (sedeId == null) {
        return res.status(400).json({ error: 'sede_id es requerido', code: 'SEDE_REQUIRED' });
      }

      const result = await desvincularJugadorSede(supabaseAdmin, {
        role: auth.role,
        userId: req.params.userId,
        sedeId,
      });
      return res.json(result);
    } catch (err) {
      console.error('❌ POST /api/admin/jugadores/:userId/desvincular:', err.message);
      return sendServiceError(res, err, 'Error al desvincular jugador');
    }
  });
}
