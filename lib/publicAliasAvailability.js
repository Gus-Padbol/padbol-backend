import { createRateLimiter } from './rateLimit.js';

export function mountAliasAvailabilityRoute(app, { supabaseAdmin, authUserFromBearer }) {
  const limit = createRateLimiter({ name: 'alias-availability', windowMs: 60_000, max: 120 });
  app.get('/api/registro/alias-disponible', limit, async (req, res) => {
    try {
      const alias = String(req.query?.alias || '').trim();
      if (!alias || alias.length > 80 || alias.includes('@')) return res.json({ available: false });
      let user = null;
      if (req.headers?.authorization) {
        user = await authUserFromBearer(req);
        if (!user?.id) return res.status(401).json({ error: 'No autorizado' });
      }
      const literal = alias.replace(/[\\%_]/g, '\\$&');
      const { data, error } = await supabaseAdmin.from('jugadores_perfil').select('user_id')
        .ilike('alias', literal).limit(2);
      if (error) return res.status(503).json({ error: 'No se pudo comprobar el alias' });
      const taken = (data || []).some(row => !user?.id || row.user_id !== user.id);
      return res.json({ available: !taken });
    } catch { return res.status(503).json({ error: 'No se pudo comprobar el alias' }); }
  });
}
