import express from 'express';
import {
  requireAdminUser,
  requireSedeAdminForId,
  requireSuperAdminUser,
} from '../../lib/authAccess.js';
import {
  adjustPadcoins,
  getPadcoinsSaldo,
  listPadcoinsMovimientos,
} from '../padcoins/padcoinsService.js';
import { PADCOINS_ORIGINS } from '../padcoins/padcoinsConfig.js';
import { listMisCanjesPadcoins } from '../padcoins/padcoinsCanjesService.js';
import {
  listPadcoinsGlobalConfig,
  updatePadcoinsGlobalConfig,
} from '../padcoins/padcoinsGlobalConfigService.js';
import {
  getPadcoinsSedeConfig,
  listPadcoinsSedeConfig,
  upsertPadcoinsSedeConfig,
} from '../padcoins/padcoinsSedeConfigService.js';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseRequiredSedeId(raw) {
  const sid = Number.parseInt(String(raw ?? '').trim(), 10);
  return Number.isFinite(sid) && sid > 0 ? sid : null;
}

async function requirePadcoinsSedeConfigReadAccess(req, res, sedeId, adminDeps) {
  const auth = await requireAdminUser(req, res, adminDeps);
  if (!auth) return null;

  if (auth.role.rol === 'super_admin') {
    return auth;
  }

  if (auth.role.rol === 'admin_club' && Number(auth.role.sede_id) === Number(sedeId)) {
    return auth;
  }

  res.status(403).json({ error: 'No tenés permiso para ver la configuración de esta sede' });
  return null;
}

function parseOptionalSedeId(raw) {
  if (raw == null || raw === '') return null;
  const sid = Number.parseInt(String(raw), 10);
  return Number.isFinite(sid) && sid > 0 ? sid : undefined;
}

function parseAdjustAmount(raw) {
  const amount = Number.parseInt(String(raw), 10);
  if (!Number.isInteger(amount) || amount === 0) return null;
  return amount;
}

function sendRouteError(res, err, fallbackMessage) {
  const status = err.status || (String(err.message ?? '').includes('insuficiente') ? 400 : 500);
  return res.status(status).json({ error: err.message || fallbackMessage });
}

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

  router.get('/mis-canjes', async (req, res) => {
    try {
      const { user, status, error: authError } = await getAuthenticatedUser(req);
      if (!user) {
        return res.status(status ?? 401).json({ error: authError ?? 'No autorizado' });
      }

      const limit = parseOptionalLimit(req.query.limit);
      const estado = req.query.estado ? String(req.query.estado).trim() : undefined;
      const { canjes } = await listMisCanjesPadcoins(supabaseAdmin, user.id, { limit, estado });

      res.json({
        ok: true,
        canjes,
      });
    } catch (err) {
      console.error('❌ Error GET /api/padcoins/mis-canjes:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}

export function mountPadcoinsAdminRoutes(app, {
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

  app.post('/api/admin/padcoins/ajuste', async (req, res) => {
    try {
      const auth = await requireAdminUser(req, res, adminDeps);
      if (!auth) return;

      const body = req.body ?? {};
      const userId = String(body.user_id ?? '').trim();
      if (!UUID_REGEX.test(userId)) {
        return res.status(400).json({ error: 'user_id inválido' });
      }

      const amount = parseAdjustAmount(body.amount);
      if (amount == null) {
        return res.status(400).json({ error: 'amount debe ser un entero distinto de 0' });
      }

      const sedeId = parseOptionalSedeId(body.sede_id ?? body.sedeId);
      if (body.sede_id != null || body.sedeId != null) {
        if (sedeId === undefined) {
          return res.status(400).json({ error: 'sede_id inválido' });
        }
        if (sedeId != null) {
          const authSede = await requireSedeAdminForId(req, res, sedeId, adminDeps);
          if (!authSede) return;
        }
      }

      const descripcionRaw = body.descripcion != null ? String(body.descripcion).trim() : '';
      const descripcion = descripcionRaw
        ? descripcionRaw.slice(0, 500)
        : (amount > 0 ? 'Ajuste admin PadCoins' : 'Descuento admin PadCoins');

      const result = await adjustPadcoins(supabaseAdmin, userId, amount, {
        referencia_tipo: PADCOINS_ORIGINS.BONUS_ADMIN,
        sede_id: sedeId,
        descripcion,
        created_by: auth.user.id,
      });

      console.log(`✓ POST /api/admin/padcoins/ajuste — user ${userId}, amount ${amount}`);
      return res.json({
        ok: true,
        saldo: {
          disponible: Number(result.saldo?.disponible ?? 0),
          historico_total: Number(result.saldo?.historico_total ?? 0),
        },
        movimiento: result.movimiento,
      });
    } catch (err) {
      console.error('❌ POST /api/admin/padcoins/ajuste:', err.message);
      return sendRouteError(res, err, 'Error al ajustar PadCoins');
    }
  });

  app.get('/api/admin/padcoins-config', async (req, res) => {
    try {
      const auth = await requireSuperAdminUser(req, res, adminDeps);
      if (!auth) return;

      const config = await listPadcoinsGlobalConfig(supabaseAdmin);

      return res.json({
        ok: true,
        config,
      });
    } catch (err) {
      console.error('❌ GET /api/admin/padcoins-config:', err.message);
      return sendRouteError(res, err, 'Error al listar configuración PadCoins');
    }
  });

  app.put('/api/admin/padcoins-config', async (req, res) => {
    try {
      const auth = await requireSuperAdminUser(req, res, adminDeps);
      if (!auth) return;

      const updates = req.body?.updates;
      const config = await updatePadcoinsGlobalConfig(
        supabaseAdmin,
        updates,
        auth.user.id,
      );

      console.log(`✓ PUT /api/admin/padcoins-config — ${config.length} regla(s) actualizada(s)`);
      return res.json({
        ok: true,
        config,
      });
    } catch (err) {
      console.error('❌ PUT /api/admin/padcoins-config:', err.message);
      return sendRouteError(res, err, 'Error al actualizar configuración PadCoins');
    }
  });

  app.get('/api/admin/padcoins-sedes-config', async (req, res) => {
    try {
      const auth = await requireSuperAdminUser(req, res, adminDeps);
      if (!auth) return;

      const sedes = await listPadcoinsSedeConfig(supabaseAdmin);

      return res.json({
        ok: true,
        sedes,
      });
    } catch (err) {
      console.error('❌ GET /api/admin/padcoins-sedes-config:', err.message);
      return sendRouteError(res, err, 'Error al listar participación PadCoins por sede');
    }
  });

  app.get('/api/admin/padcoins-sedes-config/:sedeId', async (req, res) => {
    try {
      const sedeId = parseRequiredSedeId(req.params.sedeId);
      if (!sedeId) {
        return res.status(400).json({ error: 'sedeId inválido' });
      }

      const auth = await requirePadcoinsSedeConfigReadAccess(req, res, sedeId, adminDeps);
      if (!auth) return;

      const config = await getPadcoinsSedeConfig(supabaseAdmin, sedeId);

      return res.json({
        ok: true,
        config,
      });
    } catch (err) {
      console.error('❌ GET /api/admin/padcoins-sedes-config/:sedeId:', err.message);
      return sendRouteError(res, err, 'Error al obtener participación PadCoins de la sede');
    }
  });

  app.put('/api/admin/padcoins-sedes-config/:sedeId', async (req, res) => {
    try {
      const auth = await requireSuperAdminUser(req, res, adminDeps);
      if (!auth) return;

      const sedeId = parseRequiredSedeId(req.params.sedeId);
      if (!sedeId) {
        return res.status(400).json({ error: 'sedeId inválido' });
      }

      const body = req.body ?? {};
      if (typeof body.activo !== 'boolean') {
        return res.status(400).json({ error: 'activo debe ser boolean' });
      }

      const config = await upsertPadcoinsSedeConfig(supabaseAdmin, {
        sede_id: sedeId,
        activo: body.activo,
        descripcion: body.descripcion,
        fecha_inicio: body.fecha_inicio,
        fecha_fin: body.fecha_fin,
        updated_by: auth.user.id,
      });

      console.log(`✓ PUT /api/admin/padcoins-sedes-config/${sedeId} — activo=${config.activo}`);
      return res.json({
        ok: true,
        config,
      });
    } catch (err) {
      console.error('❌ PUT /api/admin/padcoins-sedes-config/:sedeId:', err.message);
      return sendRouteError(res, err, 'Error al actualizar participación PadCoins de la sede');
    }
  });
}

export default createPadcoinsRouter;
