import { resolveWhatsappPermissions } from './whatsappAssistant.js';
import { saveManualContact } from './crmManualContact.js';
import { createHash } from 'node:crypto';

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
  sendWhatsappReply = null,
  sendEmailReply = null,
  leadAnalyzer = null,
  superAdminCanOperate = false,
} = {}) {
  if (!repository) throw crmError('El repositorio CRM no está configurado.', 503, 'CRM_ADMIN_UNAVAILABLE');

  function permissionsFor(email, role) {
    const permissions = resolvePermissions({ email, role, operators, superAdminEmails });
    return superAdminCanOperate && permissions.canAudit
      ? { ...permissions, canOperate: true }
      : permissions;
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
  function requireReader(email, role) {
    const p = permissionsFor(email, role);
    if (!p.canOperate && !p.canAudit) throw crmError('No tienes acceso a esta conversación.');
    return p;
  }

  return {
    async createManual({ email, role, input }) {
      requireOperator(email, role);
      return saveManualContact(repository, input);
    },
    getPermissions({ email, role }) {
      const p = permissionsFor(email, role);
      return {
        role: p.role,
        canOperate: p.canOperate,
        canAudit: p.canAudit,
        whatsappSendEnabled: typeof sendWhatsappReply === 'function',
        emailSendEnabled: typeof sendEmailReply === 'function',
        leadAnalysisEnabled: typeof leadAnalyzer === 'function',
      };
    },
    async listInbox({ email, role, filters = {} }) {
      requireReader(email, role);
      return repository.listConversations(filters);
    },
    async getInbox({ email, role, id }) {
      requireReader(email, role);
      const conversation = await repository.getConversation(id);
      if (!conversation) throw crmError('Conversación no encontrada.', 404, 'CRM_NOT_FOUND');
      return conversation;
    },
    async reply({ email, role, id, body, requestId }) {
      requireOperator(email, role);
      const text = String(body ?? '').trim();
      if (!text) throw crmError('La respuesta no puede estar vacía.', 400, 'CRM_REPLY_INVALID');
      const conversation = await repository.getConversation(id);
      if (!conversation) throw crmError('Conversación no encontrada.', 404, 'CRM_NOT_FOUND');
      if (conversation.source_channel !== 'whatsapp' && typeof sendEmailReply !== 'function') {
        throw crmError(
          'Esta consulta llegó por formulario web. La respuesta por email todavía no está habilitada.',
          409,
          'CRM_REPLY_CHANNEL_DISABLED',
        );
      }
      let claim = null;
      if (conversation.source_channel !== 'whatsapp') {
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(requestId || ''))) {
          throw crmError('La respuesta necesita una referencia válida para evitar envíos duplicados.', 400, 'CRM_REPLY_REFERENCE_REQUIRED');
        }
        const hex = createHash('sha256').update(`${conversation.id}:${requestId.toLowerCase()}`).digest('hex');
        const replyId = `${hex.slice(0,8)}-${hex.slice(8,12)}-4${hex.slice(13,16)}-8${hex.slice(17,20)}-${hex.slice(20,32)}`;
        claim = await repository.claimEmailReply({ id: replyId, conversationId: conversation.id, body: text, operador: email });
        if (!claim.created) {
          if (claim.reply.body !== text || claim.reply.operador !== email) throw crmError('La referencia ya corresponde a otra respuesta.', 409, 'CRM_REPLY_REFERENCE_CONFLICT');
          if (claim.reply.status === 'sent') return { ok: true, status: 'sent', replyId: claim.reply.id, providerMessageId: claim.reply.provider_message_id || null, repeated: true };
          throw crmError('Esta respuesta ya tiene un intento registrado. Revisa su estado antes de volver a enviar.', 409, 'CRM_REPLY_ALREADY_ATTEMPTED');
        }
      }
      const reply = claim?.reply || await repository.createReply({
        conversationId: conversation.id,
        body: text,
        operador: email,
        status: 'pending',
      });
      if (conversation.source_channel === 'whatsapp' && typeof sendWhatsappReply !== 'function') {
        return { ok: true, status: 'pending', replyId: reply.id };
      }
      let accepted = null;
      try {
        const sender = conversation.source_channel === 'whatsapp' ? sendWhatsappReply : sendEmailReply;
        const sent = await sender({ conversation, body: text, operador: email, replyId: reply.id });
        accepted = sent;
        await repository.updateReplyStatus?.(reply.id, 'sent', sent?.providerMessageId || null, { strictProviderId: conversation.source_channel !== 'whatsapp' });
        return { ok: true, status: 'sent', replyId: reply.id, providerMessageId: sent?.providerMessageId || null };
      } catch (error) {
        if (conversation.source_channel !== 'whatsapp') {
          if (accepted?.providerMessageId) throw crmError('El correo fue aceptado, pero no pudo actualizarse el historial. Revisa el estado antes de intentar nuevamente.', 503, 'CRM_EMAIL_AUDIT_PENDING');
          if (error?.code === 'CRM_EMAIL_SEND_UNCONFIRMED') throw error;
        }
        await repository.updateReplyStatus?.(reply.id, 'cancelled', null);
        throw error;
      }
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
      requireReader(email, role);
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

export function registerCrmAdminRoutes(app, {
  crmAdminService,
  authUserFromBearer,
  fetchUserRoleRow,
  fetchUserRoleRowForAuthUser,
  logger = console,
} = {}) {
  if (!crmAdminService) return;

  async function adminContext(req) {
    const user = await authUserFromBearer(req);
    if (!user?.email) throw crmError('No autorizado.', 401, 'CRM_ADMIN_UNAUTHENTICATED');
    // Resolver primero por `user_id` verificado evita perder el rol cuando el
    // email autenticado fue recuperado/cambiado o el registro conserva casing
    // histórico. Se mantiene el callback por email para compatibilidad.
    const row = typeof fetchUserRoleRowForAuthUser === 'function'
      ? await fetchUserRoleRowForAuthUser(user)
      : await fetchUserRoleRow(user.email);
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
  app.post('/api/admin/crm/manual', async (req, res) => {
    try {
      const result = await crmAdminService.createManual({ ...(await adminContext(req)), input: req.body });
      return res.status(result.existing ? 200 : 201).json(result);
    } catch (e) { return handle(res, e); }
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
    try { return res.json(await crmAdminService.reply({ ...(await adminContext(req)), id: req.params.id, body: req.body?.body, requestId: req.body?.requestId })); }
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
