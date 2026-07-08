import {
  requireAdminUser,
  requireSuperAdminUser,
} from '../../lib/authAccess.js';
import {
  canReadPadbolMatchSetup,
  canWritePadbolMatchSetup,
  getSetupStatus,
  initializePadCoinsSetupForSede,
  markSetupStep,
  validateSetupForSede,
} from '../setup/padbolMatchSetupService.js';

function parseSedeId(raw) {
  const sid = Number.parseInt(String(raw ?? '').trim(), 10);
  return Number.isFinite(sid) && sid > 0 ? sid : null;
}

function sendRouteError(res, err, fallbackMessage) {
  const status = err.status || 500;
  return res.status(status).json({ error: err.message || fallbackMessage });
}

async function requireSetupReadAccess(req, res, sedeId, adminDeps) {
  const auth = await requireAdminUser(req, res, adminDeps);
  if (!auth) return null;

  if (!canReadPadbolMatchSetup(auth.role, sedeId)) {
    res.status(403).json({ error: 'No tenés permiso para ver el setup de esta sede' });
    return null;
  }

  return auth;
}

async function requireSetupWriteAccess(req, res, sedeId, adminDeps) {
  const auth = await requireSuperAdminUser(req, res, adminDeps);
  if (!auth) return null;

  if (!canWritePadbolMatchSetup(auth.role, sedeId)) {
    res.status(403).json({ error: 'Solo super_admin puede modificar el setup de la sede' });
    return null;
  }

  return auth;
}

export function mountPadbolMatchSetupRoutes(app, {
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

  app.get('/api/admin/setup/sedes/:sedeId/status', async (req, res) => {
    try {
      const sedeId = parseSedeId(req.params.sedeId);
      if (!sedeId) {
        return res.status(400).json({ error: 'sedeId inválido' });
      }

      const auth = await requireSetupReadAccess(req, res, sedeId, adminDeps);
      if (!auth) return;

      const result = await getSetupStatus(supabaseAdmin, sedeId);

      return res.json({
        ok: true,
        ...result,
      });
    } catch (err) {
      console.error('❌ GET /api/admin/setup/sedes/:sedeId/status:', err.message);
      return sendRouteError(res, err, 'Error al consultar estado de setup');
    }
  });

  app.post('/api/admin/setup/sedes/:sedeId/initialize-padcoins', async (req, res) => {
    try {
      const sedeId = parseSedeId(req.params.sedeId);
      if (!sedeId) {
        return res.status(400).json({ error: 'sedeId inválido' });
      }

      const auth = await requireSetupWriteAccess(req, res, sedeId, adminDeps);
      if (!auth) return;

      const body = req.body ?? {};
      const seedBeneficios = body.seed_beneficios === true
        || body.seedBeneficios === true
        || String(body.seed_beneficios ?? '').toLowerCase() === 'true';

      const result = await initializePadCoinsSetupForSede(supabaseAdmin, sedeId, {
        actor_user_id: auth.user.id,
        seed_beneficios: seedBeneficios,
        descripcion: body.descripcion ?? null,
      });

      return res.json(result);
    } catch (err) {
      console.error('❌ POST /api/admin/setup/sedes/:sedeId/initialize-padcoins:', err.message);
      return sendRouteError(res, err, 'Error al inicializar PadCoins para la sede');
    }
  });

  app.post('/api/admin/setup/sedes/:sedeId/validate', async (req, res) => {
    try {
      const sedeId = parseSedeId(req.params.sedeId);
      if (!sedeId) {
        return res.status(400).json({ error: 'sedeId inválido' });
      }

      const auth = await requireSetupReadAccess(req, res, sedeId, adminDeps);
      if (!auth) return;

      const validation = await validateSetupForSede(supabaseAdmin, sedeId);

      return res.json({
        ok: validation.ok,
        sede_id: validation.sede_id,
        checklist: validation.checklist,
        missing: validation.missing,
        next_actions: validation.next_actions,
        checklist_completo: validation.checklist_completo,
        sections: validation.sections,
        readiness_level: validation.readiness_level,
        persisted: validation.persisted,
      });
    } catch (err) {
      console.error('❌ POST /api/admin/setup/sedes/:sedeId/validate:', err.message);
      return sendRouteError(res, err, 'Error al validar setup de la sede');
    }
  });

  app.put('/api/admin/setup/sedes/:sedeId/steps', async (req, res) => {
    try {
      const sedeId = parseSedeId(req.params.sedeId);
      if (!sedeId) {
        return res.status(400).json({ error: 'sedeId inválido' });
      }

      const auth = await requireSetupWriteAccess(req, res, sedeId, adminDeps);
      if (!auth) return;

      const body = req.body ?? {};
      const step = body.step ?? body.key;
      const value = body.value;

      if (step == null || typeof value !== 'boolean') {
        return res.status(400).json({ error: 'step y value (boolean) son requeridos' });
      }

      const result = await markSetupStep(supabaseAdmin, sedeId, step, value, {
        notes: body.notes ?? null,
      });

      return res.json({
        ok: true,
        ...result,
      });
    } catch (err) {
      console.error('❌ PUT /api/admin/setup/sedes/:sedeId/steps:', err.message);
      return sendRouteError(res, err, 'Error al actualizar paso de setup');
    }
  });
}

export default mountPadbolMatchSetupRoutes;
