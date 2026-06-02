import express from 'express';
import { getMiRangoPayload } from '../rangos/rangosService.js';

export function createRangosRouter({ supabaseAdmin, getAuthenticatedUser }) {
  const router = express.Router();

  router.get('/mi-rango', async (req, res) => {
    try {
      const { user, status, error: authError } = await getAuthenticatedUser(req);
      if (!user) {
        return res.status(status ?? 401).json({ error: authError ?? 'No autorizado' });
      }

      const payload = await getMiRangoPayload(supabaseAdmin, user.id);
      res.json(payload);
    } catch (err) {
      console.error('❌ Error GET /api/rangos/mi-rango:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}

export default createRangosRouter;
