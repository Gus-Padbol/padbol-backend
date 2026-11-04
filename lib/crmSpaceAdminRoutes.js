import multer from 'multer';

const BUCKET = 'crm-space-requests';
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024, files: 1 } });
const STATUSES = ['recibida', 'en_evaluacion', 'en_preparacion', 'enviada'];

export function registerCrmSpaceAdminRoutes(app, { db, pool, authUserFromBearer, logger = console } = {}) {
  if (!db || !pool?.query || typeof authUserFromBearer !== 'function') return null;
  async function user(req, res) {
    const current = await authUserFromBearer(req);
    if (!current) { res.status(401).json({ error: 'Iniciá sesión.', code: 'UNAUTHENTICATED' }); return null; }
    return current;
  }
  app.get('/api/admin/crm/space-requests', async (req, res) => {
    try { if (!await user(req, res)) return; const { rows } = await pool.query('select * from public.crm_space_requests order by created_at desc limit 200'); return res.json({ requests: rows || [] }); }
    catch (error) { logger.error('[crm-space-admin]', { code: error?.code || 'LIST_FAILED' }); return res.status(503).json({ error: 'No se pudieron listar las solicitudes.' }); }
  });
  app.patch('/api/admin/crm/space-requests/:id/status', async (req, res) => {
    try { if (!await user(req, res)) return; const status = String(req.body?.status || ''); if (!STATUSES.includes(status)) return res.status(400).json({ error: 'Estado inválido.' }); const { rows } = await pool.query('update public.crm_space_requests set status=$1, updated_at=now() where id=$2 returning id,status', [status, req.params.id]); if (!rows?.[0]) return res.status(404).json({ error: 'Solicitud no encontrada.' }); return res.json({ request: rows[0] }); }
    catch { return res.status(503).json({ error: 'No se pudo actualizar el estado.' }); }
  });
  app.post('/api/admin/crm/space-requests/:id/simulation', upload.single('simulation'), async (req, res) => {
    try { if (!await user(req, res)) return; const file = req.file; if (!file) return res.status(400).json({ error: 'Adjuntá una simulación.' }); const ext = file.mimetype === 'application/pdf' ? 'pdf' : file.mimetype === 'image/png' ? 'png' : file.mimetype === 'image/webp' ? 'webp' : 'jpg'; const path = `simulations/${req.params.id}-${Date.now()}.${ext}`; const { error } = await db.storage.from(BUCKET).upload(path, file.buffer, { contentType: file.mimetype, upsert: false }); if (error) throw error; const { rows } = await pool.query("update public.crm_space_requests set simulation_path=$1, status='en_preparacion', updated_at=now() where id=$2 returning id,status,simulation_path", [path, req.params.id]); if (!rows?.[0]) return res.status(404).json({ error: 'Solicitud no encontrada.' }); return res.status(201).json({ request: rows[0] }); }
    catch (error) { logger.error('[crm-space-simulation]', { code: error?.code || 'UPLOAD_FAILED' }); return res.status(503).json({ error: 'No se pudo adjuntar la simulación.' }); }
  });
  app.post('/api/admin/crm/space-requests/:id/mark-sent', async (req, res) => {
    try { if (!await user(req, res)) return; const { rows } = await pool.query("update public.crm_space_requests set status='enviada', updated_at=now() where id=$1 and simulation_path is not null returning id,status", [req.params.id]); if (!rows?.[0]) return res.status(409).json({ error: 'La simulación debe estar adjunta antes de marcarla como enviada.' }); return res.json({ request: rows[0] }); }
    catch { return res.status(503).json({ error: 'No se pudo actualizar el estado.' }); }
  });
  return { statuses: STATUSES };
}
