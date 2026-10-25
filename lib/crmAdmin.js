import { resolveWhatsappPermissions } from './whatsappAssistant.js';
import { saveManualContact } from './crmManualContact.js';
import { createHash } from 'node:crypto';
import {isSupportConversation,supportOperatorPermission} from './crmSupportMailbox.js';
import { commercialOperatorPermissions, isCommercialConversation, CRM_COMMERCIAL_FORM_ORIGINS } from './crmCommercialScope.js';

// Endpoints administrativos del CRM unificado. Reutiliza resolveWhatsappPermissions:
// - Nicolás (operador): bandeja, responder, derivar.
// - Gustavo: auditoría global y respuesta explícita por canales autorizados.
// - Usuario común: 403.

function crmError(message, status = 403, code = 'CRM_ADMIN_FORBIDDEN') {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function ticketReferenceFromId(id) {
  return UUID_PATTERN.test(String(id || '')) ? `PB-${String(id).replaceAll('-', '').toUpperCase()}` : null;
}
export function conversationIdFromTicketReference(reference) {
  const match = /^PB-([0-9A-F]{32})$/i.exec(String(reference || '').trim());
  if (!match) throw crmError('Referencia de consulta inválida.', 400, 'CRM_TICKET_REFERENCE_INVALID');
  const value = match[1].toLowerCase();
  return `${value.slice(0,8)}-${value.slice(8,12)}-${value.slice(12,16)}-${value.slice(16,20)}-${value.slice(20)}`;
}
export function shortTicketReference(value) {
  const text = String(value ?? '');
  return /^[1-9][0-9]{5,11}$/.test(text) ? `PB-${text}` : null;
}
function withTicketReference(conversation) {
  const reference = ticketReferenceFromId(conversation?.id);
  const shortReference = shortTicketReference(conversation?.ticket_number);
  return reference ? { ...conversation, ticket_reference: reference, ...(shortReference ? { short_ticket_reference: shortReference } : {}) } : conversation;
}

export function isOwnerEmailConversation(conversation){
 if(conversation?.source_channel!=='email')return false;
 if(conversation.origin==='support_email')return isSupportConversation(conversation);
 if(conversation.origin==='institutional_email'||CRM_COMMERCIAL_FORM_ORIGINS.includes(conversation.origin))return true;
 const form=conversation?.qualification_data?.form_submission?.form;
 return typeof form==='string'&&form.trim().length>0&&conversation.origin===`web_form:${form}`;
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
  commercialOperators = [],
  supportOperators = [],
  whatsappMenuReviewEnabled = false,
} = {}) {
  if (!repository) throw crmError('El repositorio CRM no está configurado.', 503, 'CRM_ADMIN_UNAVAILABLE');

  function permissionsFor(email, role, userId, ownerIdentityVerified = false) {
    const commercial = commercialOperatorPermissions({ email, userId, operators: commercialOperators });
    if (commercial) return {...commercial,canManageVisibility:false};
    const permissions = {...resolvePermissions({ email, role, userId, operators, superAdminEmails }), ...(supportOperatorPermission({email,userId,role},supportOperators) ? {canOperateSupport:true} : {})};
    permissions.canManageVisibility = permissions.canAudit === true && String(email || '').trim().toLowerCase() === 'padbolinternacional@gmail.com' && userId === '8beebdbe-e1d7-4607-9bb0-9a7d64701408' && role === 'super_admin';
    if (String(email || '').trim().toLowerCase() === 'padbolinternacional@gmail.com' && userId === '8beebdbe-e1d7-4607-9bb0-9a7d64701408' && role === 'super_admin') {permissions.canOperateWhatsapp = true;if(ownerIdentityVerified===true)permissions.canOperateEmail=true;}
    return superAdminCanOperate && permissions.canAudit
      ? { ...permissions, canOperate: true }
      : permissions;
  }
  function requireOperator(email, role, userId) {
    const p = permissionsFor(email, role, userId);
    if (!p.canOperate) throw crmError('Solo el operador autorizado puede atender o derivar.');
    return p;
  }
  function requireAudit(email, role, userId) {
    const p = permissionsFor(email, role, userId);
    if (!p.canAudit) throw crmError('Solo el superadmin puede auditar.');
    return p;
  }
  function requireReader(email, role, userId, ownerIdentityVerified = false) {
    const p = permissionsFor(email, role, userId, ownerIdentityVerified);
    if (!p.canOperate && !p.canAudit) throw crmError('No tienes acceso a esta conversación.');
    return p;
  }

  function assertConversationScope(permissions, conversation) {
    if (permissions.commercialOnly && !isCommercialConversation(conversation)) throw crmError('Conversación no encontrada.', 404, 'CRM_NOT_FOUND');
  }

  function assertConversationOperator(permissions, conversation, allowWhatsappReply = false) {
    const scopedWhatsapp = allowWhatsappReply && permissions.canOperateWhatsapp && conversation.source_channel === 'whatsapp' && conversation.origin === 'whatsapp:1376102838911694';
    const scopedEmail=allowWhatsappReply&&permissions.canOperateEmail&&isOwnerEmailConversation(conversation);
    if (!permissions.canOperate && !scopedWhatsapp && !scopedEmail && !(permissions.canOperateSupport && isSupportConversation(conversation))) throw crmError('No tienes permiso para operar esta conversación.');
  }

  return {
    async createManual({ email, role, userId, input }) {
      const permissions = requireOperator(email, role, userId);
      if (permissions.commercialOnly) throw crmError('El alta manual no está habilitada para este acceso.', 403);
      return saveManualContact(repository, input);
    },
    getPermissions({ email, role, userId, ownerIdentityVerified }) {
      const p = permissionsFor(email, role, userId, ownerIdentityVerified);
      return {
        role: p.role,
        canOperate: p.canOperate,
        canAudit: p.canAudit,
        canManageVisibility: p.canManageVisibility === true,
        ...(p.canOperateSupport ? {canOperateSupport:true} : {}),
        ...(p.canOperateWhatsapp ? {canOperateWhatsapp:true} : {}),
        ...(p.canOperateEmail ? {canOperateEmail:true} : {}),
        whatsappSendEnabled: !p.commercialOnly && typeof sendWhatsappReply === 'function',
        whatsappAutomationResumeEnabled: Boolean(whatsappMenuReviewEnabled && !p.commercialOnly && (p.canOperate || p.canOperateWhatsapp)),
        ...(p.commercialOnly ? { commercialOnly: true, allowedAreas: ['commercial'], canCreateManual: false } : {}),
        emailSendEnabled: sendEmailReply?.channelCapabilities?.commercial ?? typeof sendEmailReply === 'function',
        ...(sendEmailReply?.channelCapabilities ? {supportEmailSendEnabled:!p.commercialOnly && sendEmailReply.channelCapabilities.support} : {}),
        leadAnalysisEnabled: typeof leadAnalyzer === 'function',
      };
    },
    async listInbox({ email, role, userId, filters = {} }) {
      const permissions = requireReader(email, role, userId);
      if (filters.hiddenOnly && !permissions.canAudit) throw crmError('Solo el superadmin puede consultar pruebas ocultas.');
      const scoped = permissions.commercialOnly ? { ...filters } : { ...filters };
      if (scoped.ticketReference !== undefined) {
        const short = /^PB-([1-9][0-9]{5,11})$/i.exec(String(scoped.ticketReference || '').trim());
        if (short) scoped.ticketNumber = short[1];
        else scoped.conversationId = conversationIdFromTicketReference(scoped.ticketReference);
        delete scoped.ticketReference;
      }
      const rows = permissions.commercialOnly && typeof repository.listCommercialConversations === 'function'
        ? await repository.listCommercialConversations(scoped)
        : await repository.listConversations(permissions.commercialOnly
          ? { ...scoped, origins: [...CRM_COMMERCIAL_FORM_ORIGINS] }
          : scoped);
      const visible = (permissions.commercialOnly ? rows.filter(isCommercialConversation) : rows).map(withTicketReference);
      if (whatsappMenuReviewEnabled) {
        const whatsapp = visible.filter(row=>row.source_channel==='whatsapp');
        for (const row of whatsapp) row.whatsapp_message_order_review = row.qualification_data?.whatsapp_message_order_review?.required === true ? 'required' : 'clear';
        if (whatsapp.length) {
          try { const flagged=new Set(await repository.whatsappMenuReviewBatch(whatsapp.map(row=>row.id)));
            for (const row of whatsapp) row.whatsapp_delivery_review=flagged.has(row.id)?'required':'clear';
          } catch { for (const row of whatsapp) row.whatsapp_delivery_review='unknown'; }
        }
      }
      return visible;
    },
    async setTestVisibility({ email, role, userId, id, hide, expectedVersion }) {
      const permissions = permissionsFor(email, role, userId);
      if (!permissions.canManageVisibility) throw crmError('Solo el titular puede ocultar o restaurar conversaciones.');
      if (!UUID_PATTERN.test(String(id || '')) || !UUID_PATTERN.test(String(userId || '')) || typeof hide !== 'boolean' || (hide && (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0))) throw crmError('Solicitud inválida.', 400, 'CRM_TEST_VISIBILITY_INVALID');
      const conversation = await repository.getConversation(id);
      if (!conversation) throw crmError('Conversación no encontrada.', 404, 'CRM_NOT_FOUND');
      return { changed: await repository.setTestVisibility(id, hide, userId, expectedVersion ?? null) };
    },
    async getInbox({ email, role, userId, id }) {
      const permissions = requireReader(email, role, userId);
      const conversation = await repository.getConversation(id);
      if (!conversation) throw crmError('Conversación no encontrada.', 404, 'CRM_NOT_FOUND');
      assertConversationScope(permissions, conversation);
      const result = withTicketReference(conversation);
      if (whatsappMenuReviewEnabled && conversation.source_channel === 'whatsapp') {
        result.whatsapp_message_order_review = conversation.qualification_data?.whatsapp_message_order_review?.required === true ? 'required' : 'clear';
        try { result.whatsapp_delivery_review = await repository.whatsappMenuNeedsReview(id) ? 'required' : 'clear'; }
        catch { result.whatsapp_delivery_review = 'unknown'; }
      }
      return result;
    },
    async resumeWhatsappAutomation({email,role,userId,id}) {
      const permissions=requireReader(email,role,userId);
      if (!whatsappMenuReviewEnabled || !UUID_PATTERN.test(String(id||'')) || !UUID_PATTERN.test(String(userId||''))) throw crmError('Automatización no disponible.',400,'CRM_REVIEW_INVALID');
      const conversation=await repository.getConversation(id);
      if (!conversation || conversation.source_channel!=='whatsapp') throw crmError('Conversación no encontrada.',404,'CRM_NOT_FOUND');
      assertConversationScope(permissions,conversation);
      assertConversationOperator(permissions,conversation,true);
      return repository.resumeWhatsappAutomation({conversationId:id,actorId:userId});
    },
    async reconcileWhatsappMenu({email,role,userId,id,outcome,evidence,providerId}) {
      requireAudit(email,role,userId);
      if (!whatsappMenuReviewEnabled || !UUID_PATTERN.test(String(id||'')) || !UUID_PATTERN.test(String(userId||''))) throw crmError('Revisión no disponible.',400,'CRM_REVIEW_INVALID');
      const proof=String(evidence||'').trim();const provider=String(providerId||'').trim();
      if (!['delivered','not_delivered'].includes(outcome) || proof.length<10 || proof.length>2048 || (outcome==='delivered' && (!provider || provider.length>512)) || (outcome==='not_delivered' && provider)) throw crmError('Indica el resultado y la evidencia revisada.',400,'CRM_REVIEW_INVALID');
      const conversation=await repository.getConversation(id);
      if (!conversation || conversation.source_channel!=='whatsapp') throw crmError('Conversación no encontrada.',404,'CRM_NOT_FOUND');
      return repository.reconcileWhatsappMenu({conversationId:id,reviewerId:userId,outcome,evidenceHash:createHash('sha256').update(proof).digest('hex'),providerId:provider||null});
    },
    async getWhatsappHistory({ email, role, userId, id }) {
      const permissions = requireReader(email, role, userId);
      const conversation = await repository.getConversation(id);
      if (!conversation) throw crmError('Conversación no encontrada.', 404, 'CRM_NOT_FOUND');
      assertConversationScope(permissions, conversation);
      if (conversation.source_channel !== 'whatsapp') throw crmError('Conversación no encontrada.', 404, 'CRM_NOT_FOUND');
      return repository.listWhatsappHistory(conversation.id);
    },
    async reply({ email, role, userId, id, body, requestId, ownerIdentityVerified }) {
      const permissions = requireReader(email, role, userId, ownerIdentityVerified);
      const text = String(body ?? '').trim();
      if (!text) throw crmError('La respuesta no puede estar vacía.', 400, 'CRM_REPLY_INVALID');
      const conversation = await repository.getConversation(id);
      if (!conversation) throw crmError('Conversación no encontrada.', 404, 'CRM_NOT_FOUND');
      assertConversationScope(permissions, conversation);
      assertConversationOperator(permissions, conversation, true);
      // Commercial advisors coordinate the human conversation from their own
      // work phone. This CRM scope must never acquire Meta send capability.
      if (permissions.commercialOnly && conversation.source_channel === 'whatsapp') {
        throw crmError('La conversación comercial se atiende desde el teléfono del asesor.', 409, 'CRM_COMMERCIAL_WHATSAPP_PHONE_ONLY');
      }
      if (conversation.source_channel !== 'whatsapp' && typeof sendEmailReply !== 'function') {
        throw crmError(
          'Esta consulta llegó por formulario web. La respuesta por email todavía no está habilitada.',
          409,
          'CRM_REPLY_CHANNEL_DISABLED',
        );
      }
      let claim = null;
      if (conversation.source_channel !== 'whatsapp' || typeof sendWhatsappReply === 'function') {
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(requestId || ''))) {
          throw crmError('La respuesta necesita una referencia válida para evitar envíos duplicados.', 400, 'CRM_REPLY_REFERENCE_REQUIRED');
        }
        const hex = createHash('sha256').update(`${conversation.id}:${requestId.toLowerCase()}`).digest('hex');
        const replyId = `${hex.slice(0,8)}-${hex.slice(8,12)}-4${hex.slice(13,16)}-8${hex.slice(17,20)}-${hex.slice(20,32)}`;
        claim = await (conversation.source_channel === 'whatsapp'
          ? repository.claimWhatsappReply({ id: replyId, conversationId: conversation.id, body: text, operador: email })
          : repository.claimEmailReply({ id: replyId, conversationId: conversation.id, body: text, operador: email }));
        if (claim.blocked) throw crmError('Hay una respuesta pendiente de confirmar en esta conversación. Revisá su estado antes de volver a enviar.', 409, 'CRM_WHATSAPP_PENDING_REVIEW');
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
        await repository.updateReplyStatus?.(reply.id, 'sent', sent?.providerMessageId || null, { strictProviderId: true });
        return { ok: true, status: 'sent', replyId: reply.id, providerMessageId: sent?.providerMessageId || null };
      } catch (error) {
        if (conversation.source_channel === 'whatsapp' && typeof sendWhatsappReply === 'function') {
          if (accepted?.providerMessageId || error?.code === 'CRM_WHATSAPP_SEND_UNCONFIRMED') throw crmError('No se pudo confirmar el envío o guardar su comprobante. Revisá el historial antes de volver a intentar.', 503, 'CRM_WHATSAPP_AUDIT_PENDING');
        }
        if (conversation.source_channel !== 'whatsapp') {
          if (accepted?.providerMessageId) throw crmError('El correo fue aceptado, pero no pudo actualizarse el historial. Revisa el estado antes de intentar nuevamente.', 503, 'CRM_EMAIL_AUDIT_PENDING');
          if (error?.code === 'CRM_EMAIL_SEND_UNCONFIRMED') throw error;
        }
        await repository.updateReplyStatus?.(reply.id, 'cancelled', null);
        throw error;
      }
    },
    async handoff({ email, role, userId, id }) {
      const permissions = requireReader(email, role, userId);
      const conversation = await repository.getConversation(id);
      if (!conversation) throw crmError('Conversación no encontrada.', 404, 'CRM_NOT_FOUND');
      assertConversationScope(permissions, conversation);
      assertConversationOperator(permissions, conversation);
      if (conversation.handoff_ready !== true || conversation.qualification_status !== 'qualified') {
        throw crmError('El contacto todavía no completó la calificación guiada.', 409, 'CRM_HANDOFF_NOT_READY');
      }
      await repository.markHandoff({ conversationId: conversation.id, operador: email });
      return { ok: true, disposition: 'handoff' };
    },
    async listActivities({ email, role, userId, id }) {
      const permissions = requireReader(email, role, userId);
      const conversation = await repository.getConversation(id);
      if (!conversation) throw crmError('Conversación no encontrada.', 404, 'CRM_NOT_FOUND');
      assertConversationScope(permissions, conversation);
      return repository.listActivities(conversation.id);
    },
    async createActivity({ email, role, userId, id, activityType, summary, outcome, nextStep, followUpAt, conversationState }) {
      const permissions = requireReader(email, role, userId);
      const type = String(activityType ?? '').trim();
      const text = optionalText(summary);
      if (!ACTIVITY_TYPES.has(type) || !text) {
        throw crmError('Tipo y resumen de seguimiento son obligatorios.', 400, 'CRM_ACTIVITY_INVALID');
      }
      const conversation = await repository.getConversation(id);
      if (!conversation) throw crmError('Conversación no encontrada.', 404, 'CRM_NOT_FOUND');
      assertConversationScope(permissions, conversation);
      assertConversationOperator(permissions, conversation);
      if (conversationState !== undefined && !['nuevo', 'en_atencion', 'derivado', 'cerrado'].includes(conversationState)) throw crmError('Estado de consulta inválido.', 400, 'CRM_ACTIVITY_INVALID');
      const payload = {
        contact_id: conversation.contact_id,
        conversation_id: conversation.id,
        activity_type: type,
        summary: text,
        outcome: optionalText(outcome),
        next_step: optionalText(nextStep),
        follow_up_at: optionalDate(followUpAt),
        author: String(email).trim().toLowerCase(),
      };
      return conversationState === undefined ? repository.createActivity(payload) : repository.createActivityWithState(payload, conversationState);
    },
    async audit({ email, role, userId }) {
      requireAudit(email, role, userId);
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
    const ownerIdentityVerified=Boolean(user.email_confirmed_at&&user.id==='8beebdbe-e1d7-4607-9bb0-9a7d64701408'&&String(user.email).trim().toLowerCase()==='padbolinternacional@gmail.com'&&row?.user_id===user.id&&String(row?.email||'').trim().toLowerCase()===String(user.email).trim().toLowerCase()&&row?.role==='super_admin');
    return { email: user.email, role: row?.role ?? null, userId: user.id,ownerIdentityVerified };
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
      const filters = { hiddenOnly: req.query.hidden === 'true', sourceChannel: req.query.channel, estado: req.query.estado, ...(req.query.ticket_reference !== undefined ? { ticketReference: req.query.ticket_reference } : {}) };
      return res.json(await crmAdminService.listInbox({ ...ctx, filters }));
    } catch (e) { return handle(res, e); }
  });
  app.post('/api/admin/crm/inbox/:id/test-visibility', async (req, res) => {
    try { return res.json(await crmAdminService.setTestVisibility({ ...(await adminContext(req)), id:req.params.id, hide:req.body?.hide, expectedVersion:req.body?.expectedVersion })); }
    catch (e) { return handle(res,e); }
  });
  app.get('/api/admin/crm/inbox/:id', async (req, res) => {
    try { return res.json(await crmAdminService.getInbox({ ...(await adminContext(req)), id: req.params.id })); }
    catch (e) { return handle(res, e); }
  });
  app.post('/api/admin/crm/inbox/:id/whatsapp-delivery-review', async (req,res)=>{
    try { return res.json(await crmAdminService.reconcileWhatsappMenu({...(await adminContext(req)),id:req.params.id,outcome:req.body?.outcome,evidence:req.body?.evidence,providerId:req.body?.providerId})); }
    catch(e) { return handle(res,e); }
  });
  app.post('/api/admin/crm/inbox/:id/whatsapp-automation-resume', async (req,res)=>{
    try { return res.json(await crmAdminService.resumeWhatsappAutomation({...(await adminContext(req)),id:req.params.id})); }
    catch(e) { return handle(res,e); }
  });
  app.get('/api/admin/crm/inbox/:id/whatsapp-history', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try { return res.json(await crmAdminService.getWhatsappHistory({ ...(await adminContext(req)), id: req.params.id })); }
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
        conversationState: req.body?.conversation_state,
      }));
    } catch (e) { return handle(res, e); }
  });
  app.get('/api/admin/crm/audit', async (req, res) => {
    try { return res.json(await crmAdminService.audit(await adminContext(req))); }
    catch (e) { return handle(res, e); }
  });
}
