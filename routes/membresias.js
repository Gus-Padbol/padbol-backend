import express from 'express';

const PLANES = [
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

const VALID_PLAN_IDS = new Set(PLANES.map((plan) => plan.id));

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
        planes: PLANES.map((plan) => ({
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

      console.log(`✓ POST /api/membresias/suscribir — ${user.email ?? user.id} → ${planId}`);
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

export default createMembresiasRouter;
