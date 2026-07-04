import {
  requireAdminUser,
  requireSedeAdminForId,
} from '../../lib/authAccess.js';
import {
  createPremioCanjeable,
  deactivatePremioCanjeable,
  getPremioCanjeableById,
  listPremiosCanjeables,
  listPremiosCanjeablesPublicos,
  updatePremioCanjeable,
} from '../padcoins/premiosCanjeablesService.js';

function parseSedeId(raw) {
  const sid = Number.parseInt(String(raw ?? '').trim(), 10);
  return Number.isFinite(sid) && sid > 0 ? sid : null;
}

function resolveAdminListSedeId(role, query = {}) {
  if (role.rol === 'admin_club') {
    if (role.sede_id == null) {
      const err = new Error('Admin de club sin sede asignada');
      err.status = 403;
      throw err;
    }

    const requested = parseSedeId(query.sede_id ?? query.sedeId);
    if (requested && Number(requested) !== Number(role.sede_id)) {
      const err = new Error('No tenés permiso para administrar esta sede');
      err.status = 403;
      throw err;
    }

    return role.sede_id;
  }

  if (role.rol === 'super_admin') {
    const sedeId = parseSedeId(query.sede_id ?? query.sedeId);
    if (!sedeId) {
      const err = new Error('sede_id es requerido');
      err.status = 400;
      throw err;
    }
    return sedeId;
  }

  const err = new Error('No autorizado');
  err.status = 403;
  throw err;
}

function sendRouteError(res, err, fallbackMessage) {
  const status = err.status || 500;
  return res.status(status).json({ error: err.message || fallbackMessage });
}

export function mountPremiosCanjeablesRoutes(app, {
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

  app.get('/api/premios-canjeables', async (req, res) => {
    try {
      const sedeId = parseSedeId(req.query.sede_id ?? req.query.sedeId);
      if (!sedeId) {
        return res.status(400).json({ error: 'sede_id es requerido' });
      }

      const premios = await listPremiosCanjeablesPublicos(supabaseAdmin, { sede_id: sedeId });
      return res.json({ ok: true, premios });
    } catch (err) {
      console.error('❌ GET /api/premios-canjeables:', err.message);
      return sendRouteError(res, err, 'Error al listar premios canjeables');
    }
  });

  app.get('/api/admin/premios-canjeables', async (req, res) => {
    try {
      const auth = await requireAdminUser(req, res, adminDeps);
      if (!auth) return;

      const sedeId = resolveAdminListSedeId(auth.role, req.query ?? {});
      const premios = await listPremiosCanjeables(supabaseAdmin, { sede_id: sedeId });

      return res.json({ ok: true, premios });
    } catch (err) {
      console.error('❌ GET /api/admin/premios-canjeables:', err.message);
      return sendRouteError(res, err, 'Error al listar premios canjeables admin');
    }
  });

  app.post('/api/admin/premios-canjeables', async (req, res) => {
    try {
      const auth = await requireAdminUser(req, res, adminDeps);
      if (!auth) return;

      const body = req.body ?? {};
      const role = auth.role;
      let sedeId = parseSedeId(body.sede_id ?? body.sedeId);

      if (role.rol === 'admin_club') {
        if (role.sede_id == null) {
          return res.status(403).json({ error: 'Admin de club sin sede asignada' });
        }
        sedeId = role.sede_id;
      } else if (role.rol === 'super_admin' && !sedeId) {
        return res.status(400).json({ error: 'sede_id es requerido' });
      }

      const authSede = await requireSedeAdminForId(req, res, sedeId, adminDeps);
      if (!authSede) return;

      const premio = await createPremioCanjeable(supabaseAdmin, {
        ...body,
        sede_id: sedeId,
      });

      console.log(`✓ POST /api/admin/premios-canjeables — sede ${sedeId}, premio ${premio.id}`);
      return res.status(201).json({ ok: true, premio });
    } catch (err) {
      console.error('❌ POST /api/admin/premios-canjeables:', err.message);
      return sendRouteError(res, err, 'Error al crear premio canjeable');
    }
  });

  app.put('/api/admin/premios-canjeables/:id', async (req, res) => {
    try {
      const auth = await requireAdminUser(req, res, adminDeps);
      if (!auth) return;

      const premioId = String(req.params.id ?? '').trim();
      if (!premioId) {
        return res.status(400).json({ error: 'id inválido' });
      }

      const existing = await getPremioCanjeableById(supabaseAdmin, premioId);
      if (!existing) {
        return res.status(404).json({ error: 'Premio no encontrado' });
      }

      const authSede = await requireSedeAdminForId(req, res, existing.sede_id, adminDeps);
      if (!authSede) return;

      const body = { ...(req.body ?? {}) };
      if (auth.role.rol === 'admin_club') {
        delete body.sede_id;
        delete body.sedeId;
      } else if (body.sede_id != null || body.sedeId != null) {
        const nextSedeId = parseSedeId(body.sede_id ?? body.sedeId);
        if (!nextSedeId) {
          return res.status(400).json({ error: 'sede_id inválido' });
        }
        const authNextSede = await requireSedeAdminForId(req, res, nextSedeId, adminDeps);
        if (!authNextSede) return;
      }

      const premio = await updatePremioCanjeable(supabaseAdmin, premioId, body);
      console.log(`✓ PUT /api/admin/premios-canjeables/${premioId}`);
      return res.json({ ok: true, premio });
    } catch (err) {
      console.error('❌ PUT /api/admin/premios-canjeables/:id:', err.message);
      return sendRouteError(res, err, 'Error al actualizar premio canjeable');
    }
  });

  app.delete('/api/admin/premios-canjeables/:id', async (req, res) => {
    try {
      const auth = await requireAdminUser(req, res, adminDeps);
      if (!auth) return;

      const premioId = String(req.params.id ?? '').trim();
      if (!premioId) {
        return res.status(400).json({ error: 'id inválido' });
      }

      const existing = await getPremioCanjeableById(supabaseAdmin, premioId);
      if (!existing) {
        return res.status(404).json({ error: 'Premio no encontrado' });
      }

      const authSede = await requireSedeAdminForId(req, res, existing.sede_id, adminDeps);
      if (!authSede) return;

      const premio = await deactivatePremioCanjeable(supabaseAdmin, premioId);
      console.log(`✓ DELETE /api/admin/premios-canjeables/${premioId} — desactivado`);
      return res.json({ ok: true, premio });
    } catch (err) {
      console.error('❌ DELETE /api/admin/premios-canjeables/:id:', err.message);
      return sendRouteError(res, err, 'Error al desactivar premio canjeable');
    }
  });
}

export default mountPremiosCanjeablesRoutes;
