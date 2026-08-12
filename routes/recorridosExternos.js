import { randomUUID } from 'node:crypto';
import multer from 'multer';
import { requireAuthenticatedUser, requireSuperAdminUser } from '../lib/authAccess.js';
import { createNotificacion } from '../utils/notificaciones.js';

const BUCKET = 'recorridos-externos';
const CATEGORIES = new Set(['categoria_nivel', 'ranking', 'puntos', 'partidos', 'torneos_posiciones', 'estadisticas', 'logros']);
const STATES = new Set(['en_revision', 'requiere_informacion', 'aprobado', 'rechazado']);
const MIME_EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'application/pdf': 'pdf' };
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024, files: 5 },
  fileFilter: (_req, file, cb) => cb(MIME_EXT[file.mimetype] ? null : new Error('Formato no permitido'), Boolean(MIME_EXT[file.mimetype])),
});

function categoriesFrom(raw) {
  let values = raw;
  if (typeof raw === 'string') {
    try { values = JSON.parse(raw); } catch { values = raw.split(','); }
  }
  return Array.isArray(values)
    ? [...new Set(values.map((value) => String(value || '').trim()).filter((value) => CATEGORIES.has(value)))]
    : [];
}

async function notify(supabaseAdmin, userId, tipo, titulo, mensaje) {
  await createNotificacion(supabaseAdmin, {
    user_id: userId, tipo, titulo, mensaje, link: '/mi-perfil/recorrido',
  });
}

export function mountRecorridosExternosRoutes(app, deps) {
  const { supabaseAdmin, getAuthenticatedUser } = deps;

  app.get('/api/recorrido-externo/mio', async (req, res) => {
    try {
      const user = await requireAuthenticatedUser(req, res, getAuthenticatedUser); if (!user) return;
      const { data, error } = await supabaseAdmin.from('recorridos_externos')
        .select('id,origen,categorias,comentario,estado,datos_reconocidos,nota_revision,revisar_antes_de,revisado_at,created_at,updated_at')
        .eq('user_id', user.id).order('created_at', { ascending: false });
      if (error) throw error;
      return res.json({ solicitudes: data || [] });
    } catch (error) {
      console.error('GET /api/recorrido-externo/mio', error.message);
      return res.status(500).json({ error: 'No se pudieron cargar tus solicitudes' });
    }
  });

  app.post('/api/recorrido-externo', upload.array('capturas', 5), async (req, res) => {
    const uploadedPaths = [];
    try {
      const user = await requireAuthenticatedUser(req, res, getAuthenticatedUser); if (!user) return;
      const origen = String(req.body?.origen || '').trim().slice(0, 160);
      const comentario = String(req.body?.comentario || '').trim().slice(0, 1000) || null;
      const categorias = categoriesFrom(req.body?.categorias);
      const files = Array.isArray(req.files) ? req.files : [];
      if (!origen) return res.status(400).json({ error: 'Indica de dónde viene tu recorrido.' });
      if (!categorias.length) return res.status(400).json({ error: 'Elegí al menos un dato para reconocer.' });
      if (!files.length) return res.status(400).json({ error: 'Subí al menos una captura.' });

      const { data: active, error: activeError } = await supabaseAdmin.from('recorridos_externos')
        .select('id').eq('user_id', user.id).in('estado', ['recibido', 'en_revision']).limit(1).maybeSingle();
      if (activeError) throw activeError;
      if (active) return res.status(409).json({ error: 'Ya tenés un recorrido en revisión.' });

      const requestKey = `${Date.now()}-${randomUUID()}`;
      for (let index = 0; index < files.length; index += 1) {
        const file = files[index];
        const path = `${user.id}/${requestKey}/${String(index + 1).padStart(2, '0')}.${MIME_EXT[file.mimetype]}`;
        const { error } = await supabaseAdmin.storage.from(BUCKET).upload(path, file.buffer, { contentType: file.mimetype, upsert: false });
        if (error) throw error;
        uploadedPaths.push(path);
      }

      const revisarAntesDe = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
      const { data, error } = await supabaseAdmin.from('recorridos_externos').insert({
        user_id: user.id, email: user.email || null, origen, categorias, comentario,
        capturas_paths: uploadedPaths, estado: 'recibido', revisar_antes_de: revisarAntesDe,
      }).select('id,origen,categorias,estado,revisar_antes_de,created_at').single();
      if (error) throw error;
      await notify(supabaseAdmin, user.id, 'recorrido_externo_recibido', 'Recibimos tu recorrido', 'Revisaremos tus capturas y te avisaremos dentro de las próximas 24 horas.');
      return res.status(201).json({ ok: true, solicitud: data });
    } catch (error) {
      if (uploadedPaths.length) await supabaseAdmin.storage.from(BUCKET).remove(uploadedPaths).catch(() => {});
      console.error('POST /api/recorrido-externo', error.message);
      return res.status(error.message === 'Formato no permitido' ? 400 : 500).json({ error: error.message === 'Formato no permitido' ? error.message : 'No se pudo enviar el recorrido' });
    }
  });

  app.get('/api/admin/recorridos-externos', async (req, res) => {
    try {
      const auth = await requireSuperAdminUser(req, res, deps); if (!auth) return;
      let query = supabaseAdmin.from('recorridos_externos').select('*').order('created_at', { ascending: false });
      if (req.query?.estado) query = query.eq('estado', String(req.query.estado));
      const { data, error } = await query; if (error) throw error;
      const solicitudes = await Promise.all((data || []).map(async (row) => ({
        ...row,
        capturas: await Promise.all((row.capturas_paths || []).map(async (path) => {
          const { data: signed } = await supabaseAdmin.storage.from(BUCKET).createSignedUrl(path, 900);
          return { path, url: signed?.signedUrl || null };
        })),
      })));
      return res.json({ solicitudes });
    } catch (error) {
      console.error('GET /api/admin/recorridos-externos', error.message);
      return res.status(500).json({ error: 'No se pudo cargar la bandeja' });
    }
  });

  app.patch('/api/admin/recorridos-externos/:id', async (req, res) => {
    try {
      const auth = await requireSuperAdminUser(req, res, deps); if (!auth) return;
      const id = Number(req.params.id), estado = String(req.body?.estado || '').trim();
      const nota = String(req.body?.nota_revision || '').trim().slice(0, 1200) || null;
      if (!Number.isInteger(id) || id < 1 || !STATES.has(estado)) return res.status(400).json({ error: 'Resolución inválida' });
      if (['requiere_informacion', 'rechazado'].includes(estado) && !nota) return res.status(400).json({ error: 'Escribí una explicación para el jugador.' });
      const datos = req.body?.datos_reconocidos && typeof req.body.datos_reconocidos === 'object' ? req.body.datos_reconocidos : {};
      const { data, error } = await supabaseAdmin.from('recorridos_externos').update({
        estado, nota_revision: nota, datos_reconocidos: datos, revisado_por: auth.user.id,
        revisado_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      }).eq('id', id).select('*').single();
      if (error) throw error;
      const copy = {
        aprobado: ['¡Tu recorrido ya está reconocido!', 'Incorporamos a tu ficha los datos que pudimos verificar. Tu nivel podrá ajustarse con tus próximos partidos.'],
        requiere_informacion: ['Necesitamos otra captura', nota], rechazado: ['No pudimos verificar tu recorrido', nota],
        en_revision: ['Estamos revisando tu recorrido', 'Tu solicitud ya está siendo revisada.'],
      }[estado];
      await notify(supabaseAdmin, data.user_id, `recorrido_externo_${estado}`, copy[0], copy[1]);
      return res.json({ ok: true, solicitud: data });
    } catch (error) {
      console.error('PATCH /api/admin/recorridos-externos/:id', error.message);
      return res.status(500).json({ error: 'No se pudo actualizar la solicitud' });
    }
  });
}
