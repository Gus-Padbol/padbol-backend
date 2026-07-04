import express from 'express';
import {
  getPadcoinsSaldo,
  listPadcoinsMovimientos,
} from '../padcoins/padcoinsService.js';

function parseOptionalLimit(rawLimit) {
  if (rawLimit == null || rawLimit === '') return undefined;
  const parsed = Number.parseInt(String(rawLimit), 10);
  if (!Number.isInteger(parsed) || parsed <= 0) return undefined;
  return parsed;
}

export function createPadcoinsRouter({ supabaseAdmin, getAuthenticatedUser }) {
  const router = express.Router();

  router.get('/mi-saldo', async (req, res) => {
    try {
      const { user, status, error: authError } = await getAuthenticatedUser(req);
      if (!user) {
        return res.status(status ?? 401).json({ error: authError ?? 'No autorizado' });
      }

      const saldo = await getPadcoinsSaldo(supabaseAdmin, user.id);

      res.json({
        ok: true,
        saldo: {
          disponible: saldo.disponible,
          historico_total: saldo.historico_total,
        },
      });
    } catch (err) {
      console.error('❌ Error GET /api/padcoins/mi-saldo:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/historial', async (req, res) => {
    try {
      const { user, status, error: authError } = await getAuthenticatedUser(req);
      if (!user) {
        return res.status(status ?? 401).json({ error: authError ?? 'No autorizado' });
      }

      const limit = parseOptionalLimit(req.query.limit);
      const { movimientos } = await listPadcoinsMovimientos(supabaseAdmin, user.id, { limit });

      res.json({
        ok: true,
        movimientos,
      });
    } catch (err) {
      console.error('❌ Error GET /api/padcoins/historial:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}

export default createPadcoinsRouter;
