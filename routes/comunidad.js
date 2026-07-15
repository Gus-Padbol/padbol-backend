import { sendHttpError } from '../lib/httpErrors.js';
import { createComunidadService, isModeratorRole } from '../src/comunidad/comunidadService.js';

async function resolveAuthRole(user, { fetchUserRoleRowForAuthUser, legacySuperAdminEmails }) {
  const email = String(user.email || '').trim().toLowerCase();
  const row = await fetchUserRoleRowForAuthUser(user);
  if (!row && legacySuperAdminEmails.includes(email)) {
    return { rol: 'super_admin', sede_id: null };
  }
  const sedeIdRaw = row?.sede_id;
  const sedeIdNum = sedeIdRaw != null && sedeIdRaw !== '' ? Number(sedeIdRaw) : null;
  return {
    rol: String(row?.role || '').trim().toLowerCase() || null,
    sede_id: Number.isFinite(sedeIdNum) ? sedeIdNum : null,
  };
}

export function mountComunidadRoutes(app, {
  supabaseAdmin,
  getAuthenticatedUser,
  fetchUserRoleRowForAuthUser,
  legacySuperAdminEmails = [],
}) {
  const svc = createComunidadService({ supabaseAdmin });

  async function requireUser(req, res) {
    const { user, status, error: authError } = await getAuthenticatedUser(req);
    if (!user) {
      res.status(status).json({ error: authError });
      return null;
    }
    return user;
  }

  async function requireModerator(req, res) {
    const user = await requireUser(req, res);
    if (!user) return null;
    const role = await resolveAuthRole(user, { fetchUserRoleRowForAuthUser, legacySuperAdminEmails });
    if (!isModeratorRole(role)) {
      res.status(403).json({ error: 'Se requiere rol de moderador o Super Admin' });
      return null;
    }
    return { user, role };
  }

  app.get('/api/comunidad/feed', async (req, res) => {
    try {
      const { user } = await getAuthenticatedUser(req);
      const feed = await svc.getFeed(user, {
        cursor: req.query.cursor,
        limit: req.query.limit,
      });
      res.json(feed);
    } catch (err) {
      console.error('❌ GET /api/comunidad/feed:', err.message);
      return sendHttpError(res, err);
    }
  });

  app.post('/api/comunidad/publicaciones', async (req, res) => {
    try {
      const user = await requireUser(req, res);
      if (!user) return;
      const pub = await svc.createPublicacion(user, req.body || {});
      res.status(201).json(pub);
    } catch (err) {
      console.error('❌ POST /api/comunidad/publicaciones:', err.message);
      return sendHttpError(res, err);
    }
  });

  app.get('/api/comunidad/publicaciones/:id', async (req, res) => {
    try {
      const { user } = await getAuthenticatedUser(req);
      const pub = await svc.getPublicacion(user, req.params.id);
      res.json(pub);
    } catch (err) {
      console.error('❌ GET /api/comunidad/publicaciones/:id:', err.message);
      return sendHttpError(res, err);
    }
  });

  app.patch('/api/comunidad/publicaciones/:id', async (req, res) => {
    try {
      const user = await requireUser(req, res);
      if (!user) return;
      const pub = await svc.updatePublicacion(user, req.params.id, req.body || {});
      res.json(pub);
    } catch (err) {
      console.error('❌ PATCH /api/comunidad/publicaciones/:id:', err.message);
      return sendHttpError(res, err);
    }
  });

  app.delete('/api/comunidad/publicaciones/:id', async (req, res) => {
    try {
      const user = await requireUser(req, res);
      if (!user) return;
      const role = await resolveAuthRole(user, { fetchUserRoleRowForAuthUser, legacySuperAdminEmails });
      const result = await svc.deletePublicacion(user, req.params.id, {
        isModerator: isModeratorRole(role),
      });
      res.json(result);
    } catch (err) {
      console.error('❌ DELETE /api/comunidad/publicaciones/:id:', err.message);
      return sendHttpError(res, err);
    }
  });

  app.get('/api/comunidad/publicaciones/:id/comentarios', async (req, res) => {
    try {
      const { user } = await getAuthenticatedUser(req);
      const result = await svc.listComentarios(user, req.params.id, { limit: req.query.limit });
      res.json(result);
    } catch (err) {
      return sendHttpError(res, err);
    }
  });

  app.post('/api/comunidad/publicaciones/:id/comentarios', async (req, res) => {
    try {
      const user = await requireUser(req, res);
      if (!user) return;
      const result = await svc.createComentario(user, req.params.id, req.body || {});
      res.status(result.idempotent ? 200 : 201).json(result);
    } catch (err) {
      console.error('❌ POST comentarios:', err.message);
      return sendHttpError(res, err);
    }
  });

  app.delete('/api/comunidad/comentarios/:id', async (req, res) => {
    try {
      const user = await requireUser(req, res);
      if (!user) return;
      const role = await resolveAuthRole(user, { fetchUserRoleRowForAuthUser, legacySuperAdminEmails });
      const result = await svc.deleteComentario(user, req.params.id, {
        isModerator: isModeratorRole(role),
      });
      res.json(result);
    } catch (err) {
      return sendHttpError(res, err);
    }
  });

  app.post('/api/comunidad/publicaciones/:id/reaccion', async (req, res) => {
    try {
      const user = await requireUser(req, res);
      if (!user) return;
      const result = await svc.toggleReaccion(user, req.params.id);
      res.json(result);
    } catch (err) {
      return sendHttpError(res, err);
    }
  });

  app.post('/api/comunidad/usuarios/:userId/seguir', async (req, res) => {
    try {
      const user = await requireUser(req, res);
      if (!user) return;
      const result = await svc.seguir(user, req.params.userId);
      res.json(result);
    } catch (err) {
      return sendHttpError(res, err);
    }
  });

  app.delete('/api/comunidad/usuarios/:userId/seguir', async (req, res) => {
    try {
      const user = await requireUser(req, res);
      if (!user) return;
      const result = await svc.dejarDeSeguir(user, req.params.userId);
      res.json(result);
    } catch (err) {
      return sendHttpError(res, err);
    }
  });

  app.post('/api/comunidad/usuarios/:userId/bloquear', async (req, res) => {
    try {
      const user = await requireUser(req, res);
      if (!user) return;
      const result = await svc.bloquear(user, req.params.userId);
      res.json(result);
    } catch (err) {
      return sendHttpError(res, err);
    }
  });

  app.delete('/api/comunidad/usuarios/:userId/bloquear', async (req, res) => {
    try {
      const user = await requireUser(req, res);
      if (!user) return;
      const result = await svc.desbloquear(user, req.params.userId);
      res.json(result);
    } catch (err) {
      return sendHttpError(res, err);
    }
  });

  app.get('/api/comunidad/usuarios/:userId/resumen', async (req, res) => {
    try {
      const { user } = await getAuthenticatedUser(req);
      const result = await svc.usuarioResumen(user, req.params.userId);
      res.json(result);
    } catch (err) {
      return sendHttpError(res, err);
    }
  });

  app.post('/api/comunidad/denuncias', async (req, res) => {
    try {
      const user = await requireUser(req, res);
      if (!user) return;
      const result = await svc.crearDenuncia(user, req.body || {});
      res.status(201).json(result);
    } catch (err) {
      return sendHttpError(res, err);
    }
  });

  app.get('/api/comunidad/admin/denuncias', async (req, res) => {
    try {
      const auth = await requireModerator(req, res);
      if (!auth) return;
      const result = await svc.listDenunciasAdmin({
        estado: req.query.estado || 'pendiente',
        limit: req.query.limit,
      });
      res.json(result);
    } catch (err) {
      return sendHttpError(res, err);
    }
  });

  app.patch('/api/comunidad/admin/denuncias/:id', async (req, res) => {
    try {
      const auth = await requireModerator(req, res);
      if (!auth) return;
      const result = await svc.revisarDenuncia(auth.user, req.params.id, req.body || {});
      res.json(result);
    } catch (err) {
      return sendHttpError(res, err);
    }
  });

  console.log('Comunidad router registered at /api/comunidad');
}
