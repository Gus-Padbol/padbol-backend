import { resolveWhatsappPermissions } from './whatsappAssistant.js';

// Endpoints administrativos del CRM unificado. Reutiliza resolveWhatsappPermissions:
// - Nicolás (operador): bandeja, responder, derivar.
// - Gustavo (superadmin): auditoría global, no atiende.
// - Usuario común: 403.

function crmError(message, status = 403, code = 'CRM_ADMIN_FORBIDDEN') {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

const ACTIVITY_TYPES = new Set(['note', 'phone_call', 'zoom_meeting', 'in_person_meeting']);

function optionalText(value, max = 2000) {
  const text = String(value ?? '').trim();
  return text ? text.slice(0, max) : null;
}

function optionalDate(value) {
  if (value == null || value === '') return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw crmError('Fecha de seguimiento inválida.', 400, 'CRM_ACTIVITY_INVALID');
  return date.toISOString();
}

export function createCrmAdminService({
  repository,
  operators = new Set(),
  superAdminEmails = new Set(),
  resolvePermissions = resolveWhatsappPermissions,
} = {}) {
  if (!repository) throw crmError('El repositorio CRM no está configurado.', 503, 'CRM_ADMIN_UNAVAILABLE');

  function permissionsFor(email, role) {
    return resolvePermissions({ email, role, operators, superAdminEmails });
  }
  function requireOperator(email, role) {
    const p = permissionsFor(email, role);
    if (!p.canOperate) throw crmError('Solo el operador autorizado puede atender o derivar.');
    return p;
  }
  function requireAudit(email, role) {
    const p = permissionsFor(email, role);
    if (!p.canAudit) throw crmError('Solo el superadmin puede auditar.');
    return p;
  }

  return {
    getPermissions({ email, role }) {
      const p = permissionsFor(email, role);
      return { role: p.role, canOperate: p.canOperate, canAudit: p.canAudit };
    },
    async listInbox({ email, role, filters = {} }) {
      requireOperator(email, role);
      return repository.listConversations(filters);
    },
    async getInbox({ email, role, id }) {
      requireOperator(email, role);
      const conversation = await repository.getConversation(id);
      if (!conversation) throw crmError('Conversación no encontrada.', 404, 'CRM_NOT_FOUND');
      return conversation;
    },
    async reply({ email, role, id, body }) {
      requireOperator(email, role);
      const text = String(body ?? '').trim();
      if (!text) throw crmError('La respuesta no puede estar vacía.', 400, 'CRM_REPLY_INVALID');
      const conversation = await repository.getConversation(id);
      if (!conversation) throw crmError('Conversación no encontrada.', 404, 'CRM_NOT_FOUND');
      const reply = await repository.createReply({
        conversationId: conversation.id,
        body: text,
        operador: email,
        status: 'pending', // transporte apagado: nunca se envía
      });
      return { ok: true, status: 'pending', replyId: reply.id };
    },
    async handoff({ email, role, id }) {
      requireOperator(email, role);
      const conversation = await repository.getConversation(id);
      if (!conversation) throw crmError('Conversación no encontrada.', 404, 'CRM_NOT_FOUND');
      if (conversation.handoff_ready !== true || conversation.qualification_status !== 'qualified') {
        throw crmError('El contacto todavía no completó la calificación guiada.', 409, 'CRM_HANDOFF_NOT_READY');
      }
      await repository.markHandoff({ conversationId: conversation.id, operador: email });
      return { ok: true, disposition: 'handoff' };
    },
    async listActivities({ email, role, id }) {
      requireOperator(email, role);
      const conversation = await repository.getConversation(id);
      if (!conversation) throw crmError('Conversación no encontrada.', 404, 'CRM_NOT_FOUND');
      return repository.listActivities(conversation.id);
    },
    async createActivity({ email, role, id, activityType, summary, outcome, nextStep, followUpAt }) {
      requireOperator(email, role);
      const type = String(activityType ?? '').trim();
      const text = optionalText(summary);
      if (!ACTIVITY_TYPES.has(type) || !text) {
        throw crmError('Tipo y resumen de seguimiento son obligatorios.', 400, 'CRM_ACTIVITY_INVALID');
      }
      const conversation = await repository.getConversation(id);
      if (!conversation) throw crmError('Conversación no encontrada.', 404, 'CRM_NOT_FOUND');
      return repository.createActivity({
        contact_id: conversation.contact_id,
        conversation_id: conversation.id,
        activity_type: type,
        summary: text,
        outcome: optionalText(outcome),
        next_step: optionalText(nextStep),
        follow_up_at: optionalDate(followUpAt),
        author: String(email).trim().toLowerCase(),
      });
    },
    async audit({ email, role }) {
      requireAudit(email, role);
      return repository.listAuditActivity();
    },
  };
}

export function registerCrmAdminRoutes(app, { crmAdminService, authUserFromBearer, fetchUserRoleRow, logger = console } = {}) {
  if (!crmAdminService) return;

  async function adminContext(req) {
    const user = await authUserFromBearer(req);
    if (!user?.email) throw crmError('No autorizado.', 401, 'CRM_ADMIN_UNAUTHENTICATED');
    const row = await fetchUserRoleRow(user.email);
    return { email: user.email, role: row?.role ?? null };
  }
  function handle(res, error) {
    const status = Number(error?.status) || 503;
    logger?.error?.('[crm-admin] request failed', { code: error?.code || 'CRM_ADMIN_UNAVAILABLE' });
    return res.status(status).json({ error: error?.message || 'No disponible.', code: error?.code || 'CRM_ADMIN_UNAVAILABLE' });
  }

  app.get('/api/admin/crm/permissions', async (req, res) => {
    try { return res.json(crmAdminService.getPermissions(await adminContext(req))); }
    catch (e) { return handle(res, e); }
  });
  app.get('/api/admin/crm/inbox', async (req, res) => {
    try {
      const ctx = await adminContext(req);
      const filters = { sourceChannel: req.query.channel, estado: req.query.estado };
      return res.json(await crmAdminService.listInbox({ ...ctx, filters }));
    } catch (e) { return handle(res, e); }
  });
  app.get('/api/admin/crm/inbox/:id', async (req, res) => {
    try { return res.json(await crmAdminService.getInbox({ ...(await adminContext(req)), id: req.params.id })); }
    catch (e) { return handle(res, e); }
  });
  app.post('/api/admin/crm/inbox/:id/reply', async (req, res) => {
    try { return res.json(await crmAdminService.reply({ ...(await adminContext(req)), id: req.params.id, body: req.body?.body })); }
    catch (e) { return handle(res, e); }
  });
  app.post('/api/admin/crm/inbox/:id/handoff', async (req, res) => {
    try { return res.json(await crmAdminService.handoff({ ...(await adminContext(req)), id: req.params.id })); }
    catch (e) { return handle(res, e); }
  });
  app.get('/api/admin/crm/inbox/:id/activities', async (req, res) => {
    try { return res.json(await crmAdminService.listActivities({ ...(await adminContext(req)), id: req.params.id })); }
    catch (e) { return handle(res, e); }
  });
  app.post('/api/admin/crm/inbox/:id/activities', async (req, res) => {
    try {
      return res.status(201).json(await crmAdminService.createActivity({
        ...(await adminContext(req)), id: req.params.id,
        activityType: req.body?.type,
        summary: req.body?.summary,
        outcome: req.body?.outcome,
        nextStep: req.body?.next_step,
        followUpAt: req.body?.follow_up_at,
      }));
    } catch (e) { return handle(res, e); }
  });
  app.get('/api/admin/crm/audit', async (req, res) => {
    try { return res.json(await crmAdminService.audit(await adminContext(req))); }
    catch (e) { return handle(res, e); }
  });
}
