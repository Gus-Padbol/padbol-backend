import { sendHttpError } from '../lib/httpErrors.js';
import multer from 'multer';
import { createComunidadService, isModeratorRole } from '../src/comunidad/comunidadService.js';

const COMUNIDAD_MEDIA_BUCKET = 'comunidad-media';
const COMUNIDAD_MEDIA_MIME_TYPES = new Set([
  'image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'video/quicktime',
]);
const comunidadMediaUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024, files: 1 },
});

function mediaExtension(mimeType) {
  return ({
    'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp',
    'video/mp4': 'mp4', 'video/quicktime': 'mov',
  })[mimeType] || 'bin';
}

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

  /** Attach one photo or video to a post owned by the authenticated user. */
  app.post('/api/comunidad/publicaciones/:id/media', comunidadMediaUpload.single('media'), async (req, res) => {
    let storagePath = null;
    try {
      const user = await requireUser(req, res);
      if (!user) return;
      if (!req.file?.buffer) return res.status(400).json({ error: 'Seleccioná una foto o video.' });

      const publicacionId = Number(req.params.id);
      if (!Number.isSafeInteger(publicacionId) || publicacionId <= 0) {
        return res.status(400).json({ error: 'Publicación inválida.' });
      }
      const mimeType = String(req.file.mimetype || '').toLowerCase();
      if (!COMUNIDAD_MEDIA_MIME_TYPES.has(mimeType)) {
        return res.status(400).json({ error: 'Formato no permitido. Usá JPG, PNG, WebP, MP4 o MOV.' });
      }
      const tipo = mimeType.startsWith('image/') ? 'foto' : 'video';
      const durationMs = Number(req.body?.duration_ms);
      if (tipo === 'video' && Number.isFinite(durationMs) && durationMs > 45_000) {
        return res.status(400).json({ error: 'El video puede durar hasta 45 segundos.' });
      }

      const { data: pub, error: pubError } = await supabaseAdmin
        .from('comunidad_publicaciones')
        .select('id,autor_user_id')
        .eq('id', publicacionId)
        .maybeSingle();
      if (pubError) throw pubError;
      if (!pub) return res.status(404).json({ error: 'La publicación ya no existe.' });
      if (String(pub.autor_user_id) !== String(user.id)) {
        return res.status(403).json({ error: 'No podés adjuntar medios a esta publicación.' });
      }

      storagePath = `${user.id}/${publicacionId}/${Date.now()}-${Math.random().toString(36).slice(2, 10)}.${mediaExtension(mimeType)}`;
      const { error: storageError } = await supabaseAdmin.storage
        .from(COMUNIDAD_MEDIA_BUCKET)
        .upload(storagePath, req.file.buffer, { contentType: mimeType, upsert: false });
      if (storageError) throw storageError;

      const { data: media, error: mediaError } = await supabaseAdmin
        .from('comunidad_medios')
        .insert({
          publicacion_id: publicacionId,
          tipo,
          storage_path: storagePath,
          mime_type: mimeType,
          bytes: req.file.size || null,
          duracion_ms: tipo === 'video' && Number.isFinite(durationMs) && durationMs > 0
            ? Math.round(durationMs)
            : null,
          orden: 0,
          estado: 'listo',
        })
        .select('*')
        .single();
      if (mediaError) throw mediaError;

      const { data: signed, error: signedError } = await supabaseAdmin.storage
        .from(COMUNIDAD_MEDIA_BUCKET)
        .createSignedUrl(storagePath, 60 * 60 * 24 * 7);
      if (signedError || !signed?.signedUrl) throw signedError || new Error('No se pudo generar el acceso al archivo.');

      if (tipo === 'foto') {
        const { error: updateError } = await supabaseAdmin
          .from('comunidad_publicaciones')
          .update({ imagen_url: signed.signedUrl, updated_at: new Date().toISOString() })
          .eq('id', publicacionId);
        if (updateError) throw updateError;
      }

      return res.status(201).json({ media, url: signed.signedUrl });
    } catch (err) {
      if (storagePath) {
        await supabaseAdmin.storage.from(COMUNIDAD_MEDIA_BUCKET).remove([storagePath]).catch(() => {});
      }
      console.error('❌ POST /api/comunidad/publicaciones/:id/media:', err.message);
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
