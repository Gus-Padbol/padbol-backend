import {
  requireAdminUser,
  requireSedeAdminForId,
} from '../../lib/authAccess.js';
import {
  createPremioCanjeable,
  deactivatePremioCanjeable,
  getPremioCanjeableById,
  listPremiosCanjeables,
  listPremiosCanjeablesPublicos,
  mapPremioCanjeableAdmin,
  mapPremioCanjeablePublico,
  updatePremioCanjeable,
} from '../padcoins/premiosCanjeablesService.js';
import {
  aprobarCanjePadcoins,
  canjearPremioPadcoins,
  cancelarCanjePadcoins,
  entregarCanjePadcoins,
  getCanjePadcoinsById,
  listCanjesAdminSede,
  validarCanjePadcoinsAdmin,
} from '../padcoins/padcoinsCanjesService.js';
import {
  isPadcoinsActiveForSede,
  PADCOINS_SEDE_INACTIVE_MESSAGE,
} from '../padcoins/padcoinsSedeConfigService.js';

function parseSedeId(raw) {
  const sid = Number.parseInt(String(raw ?? '').trim(), 10);
  return Number.isFinite(sid) && sid > 0 ? sid : null;
}

function resolveAdminListSedeId(role, query = {}) {
  if (role.rol === 'admin_club') {
    if (role.sede_id == null) {
      const err = new Error('Admin de club sin sede asignada');
      err.status = 403;
      throw err;
    }

    const requested = parseSedeId(query.sede_id ?? query.sedeId);
    if (requested && Number(requested) !== Number(role.sede_id)) {
      const err = new Error('No tenés permiso para administrar esta sede');
      err.status = 403;
      throw err;
    }

    return role.sede_id;
  }

  if (role.rol === 'super_admin') {
    const sedeId = parseSedeId(query.sede_id ?? query.sedeId);
    if (!sedeId) {
      const err = new Error('sede_id es requerido');
      err.status = 400;
      throw err;
    }
    return sedeId;
  }

  const err = new Error('No autorizado');
  err.status = 403;
  throw err;
}

function parseOptionalLimit(rawLimit) {
  if (rawLimit == null || rawLimit === '') return undefined;
  const parsed = Number.parseInt(String(rawLimit), 10);
  if (!Number.isInteger(parsed) || parsed <= 0) return undefined;
  return parsed;
}

function parseOptionalOffset(rawOffset) {
  if (rawOffset == null || rawOffset === '') return undefined;
  const parsed = Number.parseInt(String(rawOffset), 10);
  if (!Number.isInteger(parsed) || parsed < 0) return undefined;
  return parsed;
}

function sendRouteError(res, err, fallbackMessage) {
  const status = err.status || 500;
  return res.status(status).json({ error: err.message || fallbackMessage });
}

function buildSedeInactiveError() {
  const err = new Error(PADCOINS_SEDE_INACTIVE_MESSAGE);
  err.status = 403;
  return err;
}

/** Admin club bloqueado si sede no participa; Super Admin puede preparar premios antes de activar. */
function assertCanMutatePremiosForSede(role, padcoinsActive) {
  if (padcoinsActive) return;
  if (role.rol === 'super_admin') return;
  throw buildSedeInactiveError();
}

export function mountPremiosCanjeablesRoutes(app, {
  supabaseAdmin,
  getAuthenticatedUser,
  fetchUserRoleRowForAuthUser,
  legacySuperAdminEmails = [],
}) {
  const adminDeps = {
    getAuthenticatedUser,
    fetchUserRoleRowForAuthUser,
    legacySuperAdminEmails,
  };

  app.get('/api/premios-canjeables', async (req, res) => {
    try {
      const sedeId = parseSedeId(req.query.sede_id ?? req.query.sedeId);
      if (!sedeId) {
        return res.status(400).json({ error: 'sede_id es requerido' });
      }

      const padcoinsActivo = await isPadcoinsActiveForSede(supabaseAdmin, sedeId);
      if (!padcoinsActivo) {
        return res.json({
          ok: true,
          premios: [],
          padcoins_activo: false,
        });
      }

      const premios = await listPremiosCanjeablesPublicos(supabaseAdmin, { sede_id: sedeId });
      return res.json({ ok: true, premios, padcoins_activo: true });
    } catch (err) {
      console.error('❌ GET /api/premios-canjeables:', err.message);
      return sendRouteError(res, err, 'Error al listar premios canjeables');
    }
  });

  app.get('/api/premios-canjeables/:id', async (req, res) => {
    try {
      const premioId = String(req.params.id ?? '').trim();
      if (!premioId) {
        return res.status(400).json({ error: 'id inválido' });
      }

      const premio = await getPremioCanjeableById(supabaseAdmin, premioId);
      if (!premio || !premio.activo) {
        return res.status(404).json({ error: 'Premio no encontrado' });
      }

      const padcoinsActivo = await isPadcoinsActiveForSede(supabaseAdmin, premio.sede_id);
      if (!padcoinsActivo) {
        return res.status(404).json({ error: 'Premio no encontrado' });
      }

      return res.json({
        ok: true,
        premio: mapPremioCanjeablePublico(premio),
      });
    } catch (err) {
      console.error('❌ GET /api/premios-canjeables/:id:', err.message);
      return sendRouteError(res, err, 'Error al obtener premio canjeable');
    }
  });

  app.post('/api/premios-canjeables/:id/canjear', async (req, res) => {
    try {
      const { user, status, error: authError } = await getAuthenticatedUser(req);
      if (!user) {
        return res.status(status ?? 401).json({ error: authError ?? 'No autorizado' });
      }

      const premioId = String(req.params.id ?? '').trim();
      if (!premioId) {
        return res.status(400).json({ error: 'id inválido' });
      }

      const body = req.body ?? {};
      if (
        body.amount != null
        || body.padcoins != null
        || body.costo_padcoins != null
        || body.monto != null
      ) {
        return res.status(400).json({
          error: 'El monto del canje lo define el backend según el premio; no se aceptan montos en el request',
        });
      }

      const premio = await getPremioCanjeableById(supabaseAdmin, premioId);
      if (!premio) {
        return res.status(404).json({ error: 'Premio no encontrado' });
      }

      const padcoinsActivo = await isPadcoinsActiveForSede(supabaseAdmin, premio.sede_id);
      if (!padcoinsActivo) {
        return res.status(403).json({ error: PADCOINS_SEDE_INACTIVE_MESSAGE });
      }

      const result = await canjearPremioPadcoins(supabaseAdmin, user.id, premioId);
      console.log(`✓ POST /api/premios-canjeables/${premioId}/canjear — canje ${result.canje.id}`);
      return res.status(201).json({
        ok: true,
        canje: result.canje,
        codigo: result.codigo,
        saldo: result.saldo,
        qr_payload: result.qr_payload ?? null,
        qr_data: result.qr_data ?? null,
        verify_path: result.verify_path ?? null,
      });
    } catch (err) {
      console.error('❌ POST /api/premios-canjeables/:id/canjear:', err.message);
      return sendRouteError(res, err, 'Error al canjear premio');
    }
  });

  app.get('/api/admin/premios-canjeables', async (req, res) => {
    try {
      const auth = await requireAdminUser(req, res, adminDeps);
      if (!auth) return;

      const sedeId = resolveAdminListSedeId(auth.role, req.query ?? {});
      const padcoinsActivo = await isPadcoinsActiveForSede(supabaseAdmin, sedeId);
      const premios = await listPremiosCanjeables(supabaseAdmin, { sede_id: sedeId });

      return res.json({ ok: true, premios: premios.map((row) => mapPremioCanjeableAdmin(row)), padcoins_activo: padcoinsActivo });
    } catch (err) {
      console.error('❌ GET /api/admin/premios-canjeables:', err.message);
      return sendRouteError(res, err, 'Error al listar premios canjeables admin');
    }
  });

  app.post('/api/admin/premios-canjeables', async (req, res) => {
    try {
      const auth = await requireAdminUser(req, res, adminDeps);
      if (!auth) return;

      const body = req.body ?? {};
      const role = auth.role;
      let sedeId = parseSedeId(body.sede_id ?? body.sedeId);

      if (role.rol === 'admin_club') {
        if (role.sede_id == null) {
          return res.status(403).json({ error: 'Admin de club sin sede asignada' });
        }
        sedeId = role.sede_id;
      } else if (role.rol === 'super_admin' && !sedeId) {
        return res.status(400).json({ error: 'sede_id es requerido' });
      }

      const authSede = await requireSedeAdminForId(req, res, sedeId, adminDeps);
      if (!authSede) return;

      const padcoinsActivo = await isPadcoinsActiveForSede(supabaseAdmin, sedeId);
      assertCanMutatePremiosForSede(role, padcoinsActivo);

      const premio = await createPremioCanjeable(supabaseAdmin, {
        ...body,
        sede_id: sedeId,
      });

      console.log(`✓ POST /api/admin/premios-canjeables — sede ${sedeId}, premio ${premio.id}`);
      return res.status(201).json({ ok: true, premio });
    } catch (err) {
      console.error('❌ POST /api/admin/premios-canjeables:', err.message);
      return sendRouteError(res, err, 'Error al crear premio canjeable');
    }
  });

  app.put('/api/admin/premios-canjeables/:id', async (req, res) => {
    try {
      const auth = await requireAdminUser(req, res, adminDeps);
      if (!auth) return;

      const premioId = String(req.params.id ?? '').trim();
      if (!premioId) {
        return res.status(400).json({ error: 'id inválido' });
      }

      const existing = await getPremioCanjeableById(supabaseAdmin, premioId);
      if (!existing) {
        return res.status(404).json({ error: 'Premio no encontrado' });
      }

      const authSede = await requireSedeAdminForId(req, res, existing.sede_id, adminDeps);
      if (!authSede) return;

      const padcoinsActivo = await isPadcoinsActiveForSede(supabaseAdmin, existing.sede_id);
      assertCanMutatePremiosForSede(auth.role, padcoinsActivo);

      const body = { ...(req.body ?? {}) };
      if (auth.role.rol === 'admin_club') {
        delete body.sede_id;
        delete body.sedeId;
      } else if (body.sede_id != null || body.sedeId != null) {
        const nextSedeId = parseSedeId(body.sede_id ?? body.sedeId);
        if (!nextSedeId) {
          return res.status(400).json({ error: 'sede_id inválido' });
        }
        const authNextSede = await requireSedeAdminForId(req, res, nextSedeId, adminDeps);
        if (!authNextSede) return;
      }

      const premio = await updatePremioCanjeable(supabaseAdmin, premioId, body);
      console.log(`✓ PUT /api/admin/premios-canjeables/${premioId}`);
      return res.json({ ok: true, premio });
    } catch (err) {
      console.error('❌ PUT /api/admin/premios-canjeables/:id:', err.message);
      return sendRouteError(res, err, 'Error al actualizar premio canjeable');
    }
  });

  app.delete('/api/admin/premios-canjeables/:id', async (req, res) => {
    try {
      const auth = await requireAdminUser(req, res, adminDeps);
      if (!auth) return;

      const premioId = String(req.params.id ?? '').trim();
      if (!premioId) {
        return res.status(400).json({ error: 'id inválido' });
      }

      const existing = await getPremioCanjeableById(supabaseAdmin, premioId);
      if (!existing) {
        return res.status(404).json({ error: 'Premio no encontrado' });
      }

      const authSede = await requireSedeAdminForId(req, res, existing.sede_id, adminDeps);
      if (!authSede) return;

      const padcoinsActivo = await isPadcoinsActiveForSede(supabaseAdmin, existing.sede_id);
      assertCanMutatePremiosForSede(auth.role, padcoinsActivo);

      const premio = await deactivatePremioCanjeable(supabaseAdmin, premioId);
      console.log(`✓ DELETE /api/admin/premios-canjeables/${premioId} — desactivado`);
      return res.json({ ok: true, premio });
    } catch (err) {
      console.error('❌ DELETE /api/admin/premios-canjeables/:id:', err.message);
      return sendRouteError(res, err, 'Error al desactivar premio canjeable');
    }
  });

  app.get('/api/admin/padcoins-canjes/validar', async (req, res) => {
    try {
      const auth = await requireAdminUser(req, res, adminDeps);
      if (!auth) return;

      const codigo = req.query.codigo ?? req.query.code ?? null;
      const canjeId = req.query.canje_id ?? req.query.id ?? null;

      if (!codigo && !canjeId) {
        return res.status(400).json({ error: 'codigo o canje_id es requerido' });
      }

      const validation = await validarCanjePadcoinsAdmin(supabaseAdmin, {
        codigo,
        canjeId,
      });

      const authSede = await requireSedeAdminForId(req, res, validation.canje.sede_id, adminDeps);
      if (!authSede) return;

      return res.json({ ok: true, ...validation });
    } catch (err) {
      console.error('❌ GET /api/admin/padcoins-canjes/validar:', err.message);
      return sendRouteError(res, err, 'Error al validar canje');
    }
  });

  app.get('/api/admin/padcoins-canjes/:id', async (req, res) => {
    try {
      const auth = await requireAdminUser(req, res, adminDeps);
      if (!auth) return;

      const canjeId = String(req.params.id ?? '').trim();
      if (!canjeId) {
        return res.status(400).json({ error: 'id inválido' });
      }

      const validation = await validarCanjePadcoinsAdmin(supabaseAdmin, { canjeId });
      const authSede = await requireSedeAdminForId(req, res, validation.canje.sede_id, adminDeps);
      if (!authSede) return;

      return res.json({ ok: true, ...validation });
    } catch (err) {
      console.error('❌ GET /api/admin/padcoins-canjes/:id:', err.message);
      return sendRouteError(res, err, 'Error al obtener canje admin');
    }
  });

  app.get('/api/admin/padcoins-canjes', async (req, res) => {
    try {
      const auth = await requireAdminUser(req, res, adminDeps);
      if (!auth) return;

      const sedeId = resolveAdminListSedeId(auth.role, req.query ?? {});
      const limit = parseOptionalLimit(req.query.limit);
      const offset = parseOptionalOffset(req.query.offset);
      const estado = req.query.estado ? String(req.query.estado).trim() : undefined;
      const user_id = req.query.user_id ?? req.query.usuario_id ?? req.query.jugador_id ?? undefined;
      const padcoinsActivo = await isPadcoinsActiveForSede(supabaseAdmin, sedeId);
      const result = await listCanjesAdminSede(supabaseAdmin, sedeId, {
        limit,
        offset,
        estado,
        user_id,
      });

      return res.json({ ok: true, ...result, padcoins_activo: padcoinsActivo });
    } catch (err) {
      console.error('❌ GET /api/admin/padcoins-canjes:', err.message);
      return sendRouteError(res, err, 'Error al listar canjes admin');
    }
  });

  app.post('/api/admin/padcoins-canjes/:id/aprobar', async (req, res) => {
    try {
      const auth = await requireAdminUser(req, res, adminDeps);
      if (!auth) return;

      const canjeId = String(req.params.id ?? '').trim();
      if (!canjeId) {
        return res.status(400).json({ error: 'id inválido' });
      }

      const existing = await getCanjePadcoinsById(supabaseAdmin, canjeId);
      if (!existing) {
        return res.status(404).json({ error: 'Canje no encontrado' });
      }

      const authSede = await requireSedeAdminForId(req, res, existing.sede_id, adminDeps);
      if (!authSede) return;

      const canje = await aprobarCanjePadcoins(supabaseAdmin, canjeId, auth.user.id);
      console.log(`✓ POST /api/admin/padcoins-canjes/${canjeId}/aprobar`);
      return res.json({ ok: true, canje });
    } catch (err) {
      console.error('❌ POST /api/admin/padcoins-canjes/:id/aprobar:', err.message);
      return sendRouteError(res, err, 'Error al aprobar canje');
    }
  });

  app.post('/api/admin/padcoins-canjes/:id/entregar', async (req, res) => {
    try {
      const auth = await requireAdminUser(req, res, adminDeps);
      if (!auth) return;

      const canjeId = String(req.params.id ?? '').trim();
      if (!canjeId) {
        return res.status(400).json({ error: 'id inválido' });
      }

      const existing = await getCanjePadcoinsById(supabaseAdmin, canjeId);
      if (!existing) {
        return res.status(404).json({ error: 'Canje no encontrado' });
      }

      const authSede = await requireSedeAdminForId(req, res, existing.sede_id, adminDeps);
      if (!authSede) return;

      const canje = await entregarCanjePadcoins(supabaseAdmin, canjeId, auth.user.id);
      console.log(`✓ POST /api/admin/padcoins-canjes/${canjeId}/entregar`);
      return res.json({ ok: true, canje });
    } catch (err) {
      console.error('❌ POST /api/admin/padcoins-canjes/:id/entregar:', err.message);
      return sendRouteError(res, err, 'Error al entregar canje');
    }
  });

  app.post('/api/admin/padcoins-canjes/:id/cancelar', async (req, res) => {
    try {
      const auth = await requireAdminUser(req, res, adminDeps);
      if (!auth) return;

      const canjeId = String(req.params.id ?? '').trim();
      if (!canjeId) {
        return res.status(400).json({ error: 'id inválido' });
      }

      const existing = await getCanjePadcoinsById(supabaseAdmin, canjeId);
      if (!existing) {
        return res.status(404).json({ error: 'Canje no encontrado' });
      }

      const authSede = await requireSedeAdminForId(req, res, existing.sede_id, adminDeps);
      if (!authSede) return;

      const reason = req.body?.reason ?? req.body?.motivo ?? null;
      const canje = await cancelarCanjePadcoins(supabaseAdmin, canjeId, auth.user.id, reason);
      console.log(`✓ POST /api/admin/padcoins-canjes/${canjeId}/cancelar`);
      return res.json({ ok: true, canje });
    } catch (err) {
      console.error('❌ POST /api/admin/padcoins-canjes/:id/cancelar:', err.message);
      return sendRouteError(res, err, 'Error al cancelar canje');
    }
  });
}

export default mountPremiosCanjeablesRoutes;
