import { calculateSurgePrice } from '../src/surge.js';

export function mountSurgeRoutes(app, { supabaseAdmin }) {
  app.get('/api/surge/:sedeId/:duracion', async (req, res) => {
    try {
      const result = await calculateSurgePrice(
        supabaseAdmin,
        req.params.sedeId,
        req.params.duracion,
      );
      return res.json(result);
    } catch (err) {
      const st = err.status || 500;
      console.error('❌ GET /api/surge/:sedeId/:duracion:', err.message);
      return res.status(st).json({ error: err.message || 'Error al calcular Surge' });
    }
  });
}
