import express from 'express';
import { sendHttpError } from '../lib/httpErrors.js';
import { resolveAuthRoleForUser } from '../lib/authAccess.js';
import { createMembresiasSedeService } from '../src/membresias/membresiasService.js';

const PLANES_LEGACY = [
  {
    id: 'gratuito',
    nombre: 'Gratuito',
    precio_mensual: 0,
    moneda: 'ARS',
    recomendado: false,
    features: [
      'Reservas ilimitadas',
      'Torneos básicos',
    ],
  },
  {
    id: 'premium',
    nombre: 'Premium',
    precio_mensual: 4999,
    moneda: 'ARS',
    recomendado: true,
    features: [
      'Reservas con descuento 10%',
      'Torneos premium',
      'Estadísticas avanzadas',
    ],
  },
  {
    id: 'elite',
    nombre: 'Elite',
    precio_mensual: 9999,
    moneda: 'ARS',
    recomendado: false,
    features: [
      'Todo Premium',
      'Clases gratis',
      'Acceso anticipado torneos FIPA',
    ],
  },
];

const VALID_PLAN_IDS = new Set(PLANES_LEGACY.map((plan) => plan.id));

async function getUserPlanId(user, supabaseAdmin) {
  const { data, error } = await supabaseAdmin
    .from('membresias')
    .select('plan_id, estado')
    .eq('user_id', user.id)
    .maybeSingle();

  if (error) throw error;

  if (!data || data.estado !== 'activa') {
    return 'gratuito';
  }

  return VALID_PLAN_IDS.has(data.plan_id) ? data.plan_id : 'gratuito';
}

/** Legacy nativa: GET/POST /api/membresias/* (catálogo global mock). */
export function createMembresiasRouter({ supabaseAdmin, getAuthenticatedUser }) {
  const router = express.Router();

  router.get('/planes', async (req, res) => {
    try {
      const { user, status, error: authError } = await getAuthenticatedUser(req);
      if (!user) {
        return res.status(status).json({ error: authError });
      }

      const planActual = await getUserPlanId(user, supabaseAdmin);

      res.json({
        plan_actual: planActual,
        planes: PLANES_LEGACY.map((plan) => ({
          ...plan,
          es_actual: plan.id === planActual,
        })),
      });
    } catch (err) {
      console.error('❌ Error GET /api/membresias/planes:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/suscribir', async (req, res) => {
    try {
      const { user, status, error: authError } = await getAuthenticatedUser(req);
      if (!user) {
        return res.status(status).json({ error: authError });
      }

      const planId = String(req.body?.plan_id ?? '').trim().toLowerCase();
      if (!VALID_PLAN_IDS.has(planId)) {
        return res.status(400).json({ error: 'plan_id inválido' });
      }

      const now = new Date().toISOString();
      const { data, error } = await supabaseAdmin
        .from('membresias')
        .upsert([{
          user_id: user.id,
          email: user.email ?? null,
          plan_id: planId,
          estado: 'activa',
          updated_at: now,
        }], { onConflict: 'user_id' })
        .select('plan_id, estado, started_at, updated_at')
        .single();

      if (error) throw error;

      console.log(`✓ POST /api/membresias/suscribir — user ${user.id} → plan ${planId}`);
      res.json({
        success: true,
        plan_id: data.plan_id,
        plan_actual: data.plan_id,
        estado: data.estado,
      });
    } catch (err) {
      console.error('❌ Error POST /api/membresias/suscribir:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}

/** Endpoints sede / admin / jugador (nuevo módulo). */
export function mountMembresiasSedeRoutes(app, {
  supabaseAdmin,
  getAuthenticatedUser,
  fetchUserRoleRowForAuthUser,
  legacySuperAdminEmails = [],
}) {
  const svc = createMembresiasSedeService({ supabaseAdmin });

  async function requireUser(req, res) {
    const { user, status, error: authError } = await getAuthenticatedUser(req);
    if (!user) {
      res.status(status).json({ error: authError });
      return null;
    }
    return user;
  }

  async function requireAdmin(req, res) {
    const user = await requireUser(req, res);
    if (!user) return null;
    const role = await resolveAuthRoleForUser(user, {
      fetchUserRoleRowForAuthUser,
      legacySuperAdminEmails,
    });
    if (role.rol !== 'super_admin' && role.rol !== 'admin_club') {
      res.status(403).json({ error: 'No tenés permiso de administración' });
      return null;
    }
    return { user, role };
  }

  app.get('/api/admin/membresias/planes', async (req, res) => {
    try {
      const auth = await requireAdmin(req, res);
      if (!auth) return;
      const sedeId = req.query.sede_id ?? auth.role.sede_id;
      const result = await svc.listPlanesAdmin(auth.role, {
        sedeId,
        includeInactive: String(req.query.include_inactive || '1') !== '0',
      });
      res.json(result);
    } catch (err) {
      return sendHttpError(res, err);
    }
  });

  app.post('/api/admin/membresias/planes', async (req, res) => {
    try {
      const auth = await requireAdmin(req, res);
      if (!auth) return;
      const body = { ...(req.body || {}) };
      if (auth.role.rol === 'admin_club') body.sede_id = auth.role.sede_id;
      const plan = await svc.createPlan(auth.role, body, auth.user);
      res.status(201).json(plan);
    } catch (err) {
      return sendHttpError(res, err);
    }
  });

  app.patch('/api/admin/membresias/planes/:id', async (req, res) => {
    try {
      const auth = await requireAdmin(req, res);
      if (!auth) return;
      const plan = await svc.updatePlan(auth.role, req.params.id, req.body || {});
      res.json(plan);
    } catch (err) {
      return sendHttpError(res, err);
    }
  });

  app.get('/api/admin/membresias', async (req, res) => {
    try {
      const auth = await requireAdmin(req, res);
      if (!auth) return;
      const sedeId = req.query.sede_id ?? auth.role.sede_id;
      const result = await svc.listMembresiasAdmin(auth.role, {
        sedeId,
        estado: req.query.estado,
        limit: req.query.limit,
      });
      res.json(result);
    } catch (err) {
      return sendHttpError(res, err);
    }
  });

  app.post('/api/admin/membresias/asignar', async (req, res) => {
    try {
      const auth = await requireAdmin(req, res);
      if (!auth) return;
      const body = { ...(req.body || {}) };
      if (auth.role.rol === 'admin_club') body.sede_id = auth.role.sede_id;
      const membresia = await svc.asignar(auth.role, body, auth.user);
      res.status(201).json({ membresia });
    } catch (err) {
      return sendHttpError(res, err);
    }
  });

  app.post('/api/admin/membresias/:id/renovar', async (req, res) => {
    try {
      const auth = await requireAdmin(req, res);
      if (!auth) return;
      const membresia = await svc.renovar(auth.role, req.params.id, req.body || {});
      res.json({ membresia });
    } catch (err) {
      return sendHttpError(res, err);
    }
  });

  app.post('/api/admin/membresias/:id/suspender', async (req, res) => {
    try {
      const auth = await requireAdmin(req, res);
      if (!auth) return;
      const membresia = await svc.suspender(auth.role, req.params.id);
      res.json({ membresia });
    } catch (err) {
      return sendHttpError(res, err);
    }
  });

  app.post('/api/admin/membresias/:id/cancelar', async (req, res) => {
    try {
      const auth = await requireAdmin(req, res);
      if (!auth) return;
      const membresia = await svc.cancelar(auth.role, req.params.id);
      res.json({ membresia });
    } catch (err) {
      return sendHttpError(res, err);
    }
  });

  app.get('/api/jugador/membresias', async (req, res) => {
    try {
      const user = await requireUser(req, res);
      if (!user) return;
      const result = await svc.listJugador(user);
      res.json(result);
    } catch (err) {
      return sendHttpError(res, err);
    }
  });

  app.get('/api/sedes/:sedeId/membresias/planes', async (req, res) => {
    try {
      const result = await svc.listPlanesPublicos(req.params.sedeId);
      res.json(result);
    } catch (err) {
      return sendHttpError(res, err);
    }
  });

  console.log('Membresías sede routes registered (/api/admin/membresias, /api/jugador/membresias)');
}

export default createMembresiasRouter;
