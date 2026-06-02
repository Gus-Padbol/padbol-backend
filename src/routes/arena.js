import express from 'express';
import { verificarLogrosArena } from '../arena/arenaLogrosService.js';

export function createArenaRouter({ supabaseAdmin, getAuthenticatedUser }) {
  const router = express.Router();

  router.post('/logros', async (req, res) => {
    try {
      const { user, status, error: authError } = await getAuthenticatedUser(req);
      if (!user) {
        return res.status(status ?? 401).json({ error: authError ?? 'No autorizado' });
      }

      const targetUserId = req.body?.user_id ?? user.id;
      const context = req.body?.context ?? {};

      const desbloqueados = await verificarLogrosArena(supabaseAdmin, targetUserId, context);
      res.json({ desbloqueados });
    } catch (err) {
      console.error('❌ Error POST /api/arena/logros:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}

export default createArenaRouter;
