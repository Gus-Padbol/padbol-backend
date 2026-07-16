import { getJugadorHistorial } from '../lib/jugadorHistorialService.js';

function sendHistorialError(res, err, fallback) {
  const status = Number(err?.status) || 500;
  const body = { error: err?.message || fallback };
  if (err?.code) body.code = err.code;
  return res.status(status).json(body);
}

/**
 * GET /api/jugador/historial — historial privado unificado (FASE 1).
 */
export function mountJugadorHistorialRoutes(jugadorRouter, {
  supabaseAdmin,
  getAuthenticatedUser,
}) {
  jugadorRouter.get('/historial', async (req, res) => {
    try {
      const { user, status, error: authError } = await getAuthenticatedUser(req);
      if (!user) {
        return res.status(status ?? 401).json({ error: authError ?? 'No autorizado' });
      }

      const result = await getJugadorHistorial(supabaseAdmin, user, req.query);
      return res.json({
        ok: true,
        data: result.data,
      });
    } catch (err) {
      console.error('❌ GET /api/jugador/historial:', err.message);
      return sendHistorialError(res, err, 'Error al obtener historial');
    }
  });
}
