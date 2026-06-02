const WINDOW_DAYS = 30;
const WARNING_AT = 3;
const SUSPEND_AT = 5;
const SUSPEND_DAYS = 7;

function buildUserEmailOrIdFilters(user) {
  const filters = [];

  if (user.email) {
    filters.push(`email.eq."${String(user.email).replace(/"/g, '\\"')}"`);
  }

  filters.push(`user_id.eq.${user.id}`);
  return filters;
}

export async function computeJugadorReputacion(supabaseAdmin, user) {
  const since = new Date();
  since.setDate(since.getDate() - WINDOW_DAYS);

  const filters = buildUserEmailOrIdFilters(user);

  const { data, error } = await supabaseAdmin
    .from('reservas')
    .select('id, updated_at, created_at')
    .eq('estado', 'cancelada')
    .or(filters.join(','))
    .gte('updated_at', since.toISOString())
    .order('updated_at', { ascending: true });

  if (error) throw error;

  const cancellations = data ?? [];
  const count = cancellations.length;

  let suspendido = false;
  let suspendidoHasta = null;

  if (count >= SUSPEND_AT) {
    const fifth = cancellations[SUSPEND_AT - 1];
    const triggerAt = new Date(fifth?.updated_at ?? fifth?.created_at ?? Date.now());
    const hasta = new Date(triggerAt);
    hasta.setDate(hasta.getDate() + SUSPEND_DAYS);
    suspendidoHasta = hasta.toISOString();
    suspendido = Date.now() < hasta.getTime();
  }

  const advertencia = count >= WARNING_AT && !suspendido;

  return {
    cancelaciones_30d: count,
    cancelaciones: count,
    advertencia,
    suspendido,
    suspendido_hasta: suspendidoHasta,
    umbrales: {
      advertencia: WARNING_AT,
      suspension: SUSPEND_AT,
      suspension_dias: SUSPEND_DAYS,
      ventana_dias: WINDOW_DAYS,
    },
  };
}

export function mountJugadorReputacionRoutes(jugadorRouter, deps) {
  const { supabaseAdmin, getAuthenticatedUser } = deps;

  jugadorRouter.get('/reputacion', async (req, res) => {
    try {
      const { user, status, error: authError } = await getAuthenticatedUser(req);
      if (!user) {
        return res.status(status).json({ error: authError });
      }

      const reputacion = await computeJugadorReputacion(supabaseAdmin, user);
      res.json(reputacion);
    } catch (err) {
      console.error('❌ Error GET /api/jugador/reputacion:', err.message);
      res.status(500).json({ error: err.message });
    }
  });
}
