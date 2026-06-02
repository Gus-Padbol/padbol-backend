import express from 'express';
import { getHistorialXP, getXPJugador } from '../xp/xpService.js';

export function createXpRouter({ supabaseAdmin, getAuthenticatedUser }) {
  const router = express.Router();

  router.get('/mi-xp', async (req, res) => {
    try {
      const { user, status, error: authError } = await getAuthenticatedUser(req);
      if (!user) {
        return res.status(status ?? 401).json({ error: authError ?? 'No autorizado' });
      }

      const xp = await getXPJugador(supabaseAdmin, user.id);
      res.json(xp);
    } catch (err) {
      console.error('❌ Error GET /api/xp/mi-xp:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/historial', async (req, res) => {
    try {
      const { user, status, error: authError } = await getAuthenticatedUser(req);
      if (!user) {
        return res.status(status ?? 401).json({ error: authError ?? 'No autorizado' });
      }

      const transacciones = await getHistorialXP(supabaseAdmin, user.id);
      res.json(transacciones);
    } catch (err) {
      console.error('❌ Error GET /api/xp/historial:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}

export default createXpRouter;
