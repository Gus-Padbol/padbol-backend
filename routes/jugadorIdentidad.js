import { listAceptaciones, registrarAceptacion } from '../src/jugador/jugadorAceptacionesService.js';
import {
  getIdentidadPropia,
  upsertIdentidadPropia,
} from '../src/jugador/jugadorIdentidadService.js';
import { sendHttpError } from '../lib/httpErrors.js';

function extractRequestMeta(req) {
  const forwarded = String(req.headers['x-forwarded-for'] ?? '').split(',')[0]?.trim();
  return {
    ip: forwarded || req.ip || req.socket?.remoteAddress || null,
    userAgent: req.headers['user-agent'] ?? null,
  };
}

function handleIdentidadError(res, err) {
  if (err.status) {
    return res.status(err.status).json({
      error: err.message,
      code: err.code ?? undefined,
    });
  }
  return sendHttpError(res, err);
}

export function mountJugadorIdentidadRoutes(jugadorRouter, deps) {
  const { supabaseAdmin, getAuthenticatedUser } = deps;

  jugadorRouter.get('/identidad', async (req, res) => {
    try {
      const { user, status, error: authError } = await getAuthenticatedUser(req);
      if (!user) {
        return res.status(status ?? 401).json({ error: authError ?? 'No autorizado' });
      }

      const identidad = await getIdentidadPropia(supabaseAdmin, user.id);
      return res.json(identidad);
    } catch (err) {
      console.error('❌ Error GET /api/jugador/identidad:', err.message);
      return handleIdentidadError(res, err);
    }
  });

  jugadorRouter.put('/identidad', async (req, res) => {
    try {
      const { user, status, error: authError } = await getAuthenticatedUser(req);
      if (!user) {
        return res.status(status ?? 401).json({ error: authError ?? 'No autorizado' });
      }

      const identidad = await upsertIdentidadPropia(supabaseAdmin, user.id, req.body ?? {});
      console.log(`✓ PUT /api/jugador/identidad — user ${user.id}`);
      return res.json(identidad);
    } catch (err) {
      console.error('❌ Error PUT /api/jugador/identidad:', err.message);
      return handleIdentidadError(res, err);
    }
  });

  jugadorRouter.get('/aceptaciones', async (req, res) => {
    try {
      const { user, status, error: authError } = await getAuthenticatedUser(req);
      if (!user) {
        return res.status(status ?? 401).json({ error: authError ?? 'No autorizado' });
      }

      const aceptaciones = await listAceptaciones(supabaseAdmin, user.id);
      return res.json({ aceptaciones });
    } catch (err) {
      console.error('❌ Error GET /api/jugador/aceptaciones:', err.message);
      return handleIdentidadError(res, err);
    }
  });

  jugadorRouter.post('/aceptaciones', async (req, res) => {
    try {
      const { user, status, error: authError } = await getAuthenticatedUser(req);
      if (!user) {
        return res.status(status ?? 401).json({ error: authError ?? 'No autorizado' });
      }

      const result = await registrarAceptacion(
        supabaseAdmin,
        user.id,
        req.body ?? {},
        extractRequestMeta(req),
      );

      console.log(`✓ POST /api/jugador/aceptaciones — user ${user.id} tipo ${result.tipo}`);
      return res.status(result.already_accepted ? 200 : 201).json(result);
    } catch (err) {
      console.error('❌ Error POST /api/jugador/aceptaciones:', err.message);
      return handleIdentidadError(res, err);
    }
  });
}
