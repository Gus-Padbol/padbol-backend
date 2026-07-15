import { requireAdminUser } from '../../lib/authAccess.js';
import { sendHttpError } from '../../lib/httpErrors.js';
import {
  buildPadcoinsCanjesCsv,
  buildPadcoinsCsvFilename,
  buildPadcoinsJugadoresCsv,
  buildPadcoinsMovimientosCsv,
  getPadcoinsReportesResumen,
  listPadcoinsReportesCanjes,
  listPadcoinsReportesJugadores,
  listPadcoinsReportesMovimientos,
} from '../padcoins/padcoinsReportesService.js';

function sendCsv(res, { filename, content }) {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  return res.status(200).send(content);
}

export function mountPadcoinsReportesRoutes(app, {
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

  app.get('/api/admin/padcoins-reportes/resumen', async (req, res) => {
    try {
      const auth = await requireAdminUser(req, res, adminDeps);
      if (!auth) return;
      const payload = await getPadcoinsReportesResumen(supabaseAdmin, {
        role: auth.role,
        query: req.query,
      });
      return res.json({ ok: true, ...payload });
    } catch (err) {
      return sendHttpError(res, err, { context: 'GET /api/admin/padcoins-reportes/resumen' });
    }
  });

  app.get('/api/admin/padcoins-reportes/movimientos', async (req, res) => {
    try {
      const auth = await requireAdminUser(req, res, adminDeps);
      if (!auth) return;
      const payload = await listPadcoinsReportesMovimientos(supabaseAdmin, {
        role: auth.role,
        query: req.query,
      });
      return res.json({ ok: true, ...payload });
    } catch (err) {
      return sendHttpError(res, err, { context: 'GET /api/admin/padcoins-reportes/movimientos' });
    }
  });

  app.get('/api/admin/padcoins-reportes/movimientos.csv', async (req, res) => {
    try {
      const auth = await requireAdminUser(req, res, adminDeps);
      if (!auth) return;
      const payload = await listPadcoinsReportesMovimientos(supabaseAdmin, {
        role: auth.role,
        query: req.query,
        forExport: true,
      });
      const content = buildPadcoinsMovimientosCsv(payload.movimientos);
      const filename = buildPadcoinsCsvFilename('movimientos', { sedeId: payload.sedeId });
      return sendCsv(res, { filename, content });
    } catch (err) {
      return sendHttpError(res, err, { context: 'GET /api/admin/padcoins-reportes/movimientos.csv' });
    }
  });

  app.get('/api/admin/padcoins-reportes/canjes', async (req, res) => {
    try {
      const auth = await requireAdminUser(req, res, adminDeps);
      if (!auth) return;
      const payload = await listPadcoinsReportesCanjes(supabaseAdmin, {
        role: auth.role,
        query: req.query,
      });
      return res.json({ ok: true, ...payload });
    } catch (err) {
      return sendHttpError(res, err, { context: 'GET /api/admin/padcoins-reportes/canjes' });
    }
  });

  app.get('/api/admin/padcoins-reportes/canjes.csv', async (req, res) => {
    try {
      const auth = await requireAdminUser(req, res, adminDeps);
      if (!auth) return;
      const payload = await listPadcoinsReportesCanjes(supabaseAdmin, {
        role: auth.role,
        query: req.query,
        forExport: true,
      });
      const content = buildPadcoinsCanjesCsv(payload.canjes);
      const filename = buildPadcoinsCsvFilename('canjes', { sedeId: payload.sedeId });
      return sendCsv(res, { filename, content });
    } catch (err) {
      return sendHttpError(res, err, { context: 'GET /api/admin/padcoins-reportes/canjes.csv' });
    }
  });

  app.get('/api/admin/padcoins-reportes/jugadores', async (req, res) => {
    try {
      const auth = await requireAdminUser(req, res, adminDeps);
      if (!auth) return;
      const payload = await listPadcoinsReportesJugadores(supabaseAdmin, {
        role: auth.role,
        query: req.query,
      });
      return res.json({ ok: true, ...payload });
    } catch (err) {
      return sendHttpError(res, err, { context: 'GET /api/admin/padcoins-reportes/jugadores' });
    }
  });

  app.get('/api/admin/padcoins-reportes/jugadores.csv', async (req, res) => {
    try {
      const auth = await requireAdminUser(req, res, adminDeps);
      if (!auth) return;
      const payload = await listPadcoinsReportesJugadores(supabaseAdmin, {
        role: auth.role,
        query: req.query,
        forExport: true,
      });
      const content = buildPadcoinsJugadoresCsv(payload.jugadores);
      const filename = buildPadcoinsCsvFilename('jugadores', { sedeId: payload.sedeId });
      return sendCsv(res, { filename, content });
    } catch (err) {
      return sendHttpError(res, err, { context: 'GET /api/admin/padcoins-reportes/jugadores.csv' });
    }
  });
}
