import express from 'express';
import { resolveArenaLogrosTargetUserId } from '../../lib/arenaLogrosAuth.js';
import { verificarLogrosArena } from '../arena/arenaLogrosService.js';
import { actualizarRango } from '../rangos/rangosService.js';

export function createArenaRouter({ supabaseAdmin, getAuthenticatedUser }) {
  const router = express.Router();

  router.post('/logros', async (req, res) => {
    try {
      const { user, status, error: authError } = await getAuthenticatedUser(req);
      if (!user) {
        return res.status(status ?? 401).json({ error: authError ?? 'No autorizado' });
      }

      const targetUserId = resolveArenaLogrosTargetUserId(user, req.body);
      if (!targetUserId) {
        return res.status(401).json({ error: 'No autorizado' });
      }
      const context = req.body?.context ?? {};

      const desbloqueados = await verificarLogrosArena(supabaseAdmin, targetUserId, context);
      const rango = await actualizarRango(supabaseAdmin, targetUserId);
      res.json({ desbloqueados, rango });
    } catch (err) {
      console.error('❌ Error POST /api/arena/logros:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}

export default createArenaRouter;
