import { createRateLimiter } from './rateLimit.js';
import { isHandleTaken, normalizeHandle } from './publicAliasNamespace.js';

export function mountAliasAvailabilityRoute(app, { supabaseAdmin, authUserFromBearer }) {
  const limit = createRateLimiter({ name: 'alias-availability', windowMs: 60_000, max: 120 });
  app.get('/api/registro/alias-disponible', limit, async (req, res) => {
    try {
      const alias = normalizeHandle(req.query?.alias);
      if (!alias) return res.json({ available: false });
      let user = null;
      if (req.headers?.authorization) {
        user = await authUserFromBearer(req);
        if (!user?.id) return res.status(401).json({ error: 'No autorizado' });
      }
      const result = await isHandleTaken({ supabaseAdmin, handle: alias, userId: user?.id || null });
      if (result.error) return res.status(503).json({ error: 'No se pudo comprobar el alias' });
      return res.json({ available: !result.taken });
    } catch { return res.status(503).json({ error: 'No se pudo comprobar el alias' }); }
  });
}
