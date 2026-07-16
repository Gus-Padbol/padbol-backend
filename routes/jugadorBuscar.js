import { sendHttpError } from '../lib/httpErrors.js';
import {
  mapLegacyEquiposBuscar,
  mapLegacyUsuariosBuscar,
  searchJugadoresPublicos,
} from '../lib/jugadorSearchPublic.js';

export function mountJugadorBuscarRoutes(app, {
  supabaseAdmin,
  getAuthenticatedUser,
  isSolicitudPendienteActiva = null,
}) {
  app.get('/api/jugadores/buscar', async (req, res) => {
    try {
      const { user, status, error: authError } = await getAuthenticatedUser(req);
      if (!user) return res.status(status).json({ error: authError });

      const result = await searchJugadoresPublicos(supabaseAdmin, {
        q: req.query.q,
        viewerId: user.id,
        page: req.query.page,
        limit: req.query.limit,
        sedeId: req.query.sede_id ? parseInt(req.query.sede_id, 10) : null,
        pais: req.query.pais || null,
        nivel: req.query.nivel || null,
        deporte: req.query.deporte || null,
        excluirUserId: req.query.excluir_user_id || null,
        contexto: req.query.contexto || 'perfil',
        partidoId: req.query.partido_id ? parseInt(req.query.partido_id, 10) : null,
        isSolicitudPendienteActiva,
        strictMinChars: false,
      });

      res.json({
        jugadores: result.items,
        page: result.page,
        limit: result.limit,
        q: result.q,
        contexto: result.contexto,
        has_more: result.has_more,
      });
    } catch (err) {
      console.error('❌ GET /api/jugadores/buscar:', err.message);
      return sendHttpError(res, err);
    }
  });

  console.log('Jugador buscar registered at GET /api/jugadores/buscar');
}

/** Wrapper legacy shape for usuariosRouter.get('/buscar') */
export async function handleLegacyUsuariosBuscar(req, res, {
  supabaseAdmin,
  getAuthenticatedUser,
  isSolicitudPendienteActiva = null,
}) {
  try {
    const { user, status, error: authError } = await getAuthenticatedUser(req);
    if (!user) return res.status(status).json({ error: authError });

    const result = await searchJugadoresPublicos(supabaseAdmin, {
      q: req.query.q,
      viewerId: user.id,
      page: 1,
      limit: 10,
      contexto: Number.isFinite(partidoId) ? 'partido' : 'perfil',
      partidoId: Number.isFinite(partidoId) ? partidoId : null,
      isSolicitudPendienteActiva,
      strictMinChars: false,
    });

    // Legacy ocultaba jugadores ya en el partido / invitados.
    const filtered = Number.isFinite(partidoId)
      ? result.items.filter((item) => item.puede_invitar_partido)
      : result.items;

    res.json(filtered.map(mapLegacyUsuariosBuscar).filter(Boolean));
  } catch (err) {
    console.error('❌ Error GET /api/usuarios/buscar:', err.message);
    return sendHttpError(res, err);
  }
}

export async function handleLegacyEquiposBuscarJugador(req, res, {
  supabaseAdmin,
  getAuthenticatedUser,
}) {
  try {
    const { user, status, error: authError } = await getAuthenticatedUser(req);
    if (!user) return res.status(status).json({ error: authError });

    const result = await searchJugadoresPublicos(supabaseAdmin, {
      q: req.query.query ?? req.query.q,
      viewerId: user.id,
      page: 1,
      limit: 10,
      contexto: 'equipo',
      strictMinChars: false,
    });

    res.json(result.items.map(mapLegacyEquiposBuscar).filter(Boolean));
  } catch (err) {
    console.error('❌ Error GET /api/equipos/buscar-jugador:', err.message);
    return sendHttpError(res, err);
  }
}
