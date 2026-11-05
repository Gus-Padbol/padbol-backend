import multer from 'multer';

const BUCKET = 'crm-space-requests';
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024, files: 1 } });
const STATUSES = ['recibida', 'en_evaluacion', 'en_preparacion', 'enviada'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Managers see all requests; advisors use the same stored assignment as the commercial workspace.
const SCOPE = `exists (select 1 from public.crm_conversations c where c.id=r.conversation_id and c.test_hidden_at is null and c.email_return_linked_to is null) and ($1::boolean or (public.crm_commercial_form_is_allowed(r.conversation_id) and exists (select 1 from public.crm_commercial_form_cases f where f.conversation_id=r.conversation_id and f.assigned_user_id=$2::uuid)))`;

export function registerCrmSpaceAdminRoutes(app, { db, pool, authUserFromBearer, resolveTrustedSuperadmin, logger = console } = {}) {
  if (!db || !pool?.query || typeof authUserFromBearer !== 'function') return null;
  async function authorize(req, res, next) {
    try {
      const current = await authUserFromBearer(req);
      if (!current) return res.status(401).json({ error: 'Inicia sesión.', code: 'UNAUTHENTICATED' });
      if (!UUID.test(String(current.id || '')) || !current.email || !current.email_confirmed_at) return res.status(403).json({ error: 'Acceso no permitido.', code: 'FORBIDDEN' });
      if (typeof resolveTrustedSuperadmin !== 'function' || typeof db.rpc !== 'function') throw new Error('SPACE_ROLE_UNAVAILABLE');
      const trusted = (await resolveTrustedSuperadmin(current)) === true;
      const { data: role, error } = await db.rpc('crm_commercial_team_role', { p_actor: current.id, p_superadmin: trusted });
      if (error) throw new Error('SPACE_ROLE_UNAVAILABLE');
      if (!['manager', 'advisor'].includes(role)) return res.status(403).json({ error: 'Acceso no permitido.', code: 'FORBIDDEN' });
      req.spaceScope = [role === 'manager', current.id];
      return next();
    } catch { return res.status(503).json({ error: 'No se pudo verificar el acceso.', code: 'SPACE_ROLE_UNAVAILABLE' }); }
  }
  async function requestAccess(req, res, next) {
    if (!UUID.test(String(req.params.id || ''))) return res.status(400).json({ error: 'Solicitud inválida.' });
    try {
      const { rows } = await pool.query(`select r.id from public.crm_space_requests r where ${SCOPE} and r.id=$3`, [...req.spaceScope, req.params.id]);
      if (!rows?.[0]) return res.status(404).json({ error: 'Solicitud no disponible.' });
      return next();
    } catch { return res.status(503).json({ error: 'No se pudo verificar la solicitud.' }); }
  }
  app.get('/api/admin/crm/space-requests', authorize, async (req, res) => {
    try { const { rows } = await pool.query(`select r.* from public.crm_space_requests r where ${SCOPE} order by r.created_at desc limit 200`, req.spaceScope); return res.json({ requests: rows || [] }); }
    catch (error) { logger.error('[crm-space-admin]', { code: error?.code || 'LIST_FAILED' }); return res.status(503).json({ error: 'No se pudieron listar las solicitudes.' }); }
  });
  app.patch('/api/admin/crm/space-requests/:id/status', authorize, requestAccess, async (req, res) => {
    try {
      const status = String(req.body?.status || ''); if (!STATUSES.includes(status)) return res.status(400).json({ error: 'Estado inválido.' });
      const { rows } = await pool.query(`update public.crm_space_requests r set status=$4, updated_at=now() where ${SCOPE} and r.id=$3 and ($4 <> 'enviada' or r.simulation_path is not null) returning r.id,r.status`, [...req.spaceScope, req.params.id, status]);
      if (!rows?.[0]) return res.status(409).json({ error: 'Solicitud no disponible o simulación pendiente.' }); return res.json({ request: rows[0] });
    } catch { return res.status(503).json({ error: 'No se pudo actualizar el estado.' }); }
  });
  app.post('/api/admin/crm/space-requests/:id/simulation', authorize, requestAccess, upload.single('simulation'), async (req, res) => {
    let path = null;
    try {
      const file = req.file; if (!file) return res.status(400).json({ error: 'Adjunta una simulación.' });
      const ext = file.mimetype === 'application/pdf' ? 'pdf' : file.mimetype === 'image/png' ? 'png' : file.mimetype === 'image/webp' ? 'webp' : file.mimetype === 'image/jpeg' ? 'jpg' : null;
      if (!ext) return res.status(400).json({ error: 'Formato de simulación no permitido.' });
      path = `simulations/${req.params.id}-${Date.now()}.${ext}`;
      const { error } = await db.storage.from(BUCKET).upload(path, file.buffer, { contentType: file.mimetype, upsert: false }); if (error) throw error;
      const { rows } = await pool.query(`update public.crm_space_requests r set simulation_path=$4, status='en_preparacion', updated_at=now() where ${SCOPE} and r.id=$3 returning r.id,r.status,r.simulation_path`, [...req.spaceScope, req.params.id, path]);
      if (!rows?.[0]) { await db.storage.from(BUCKET).remove([path]); return res.status(404).json({ error: 'Solicitud no disponible.' }); }
      return res.status(201).json({ request: rows[0] });
    } catch (error) { if (path) await db.storage.from(BUCKET).remove([path]).catch(() => {}); logger.error('[crm-space-simulation]', { code: error?.code || 'UPLOAD_FAILED' }); return res.status(503).json({ error: 'No se pudo adjuntar la simulación.' }); }
  });
  app.post('/api/admin/crm/space-requests/:id/mark-sent', authorize, requestAccess, async (req, res) => {
    try {
      const { rows } = await pool.query(`update public.crm_space_requests r set status='enviada', updated_at=now() where ${SCOPE} and r.id=$3 and r.simulation_path is not null returning r.id,r.status`, [...req.spaceScope, req.params.id]);
      if (!rows?.[0]) return res.status(409).json({ error: 'La simulación debe estar adjunta antes de marcarla como enviada.' }); return res.json({ request: rows[0] });
    } catch { return res.status(503).json({ error: 'No se pudo actualizar el estado.' }); }
  });
  return { statuses: STATUSES };
}
