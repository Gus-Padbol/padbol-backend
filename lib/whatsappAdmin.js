import { createHash } from 'node:crypto';
import { resolveWhatsappPermissions } from './whatsappAssistant.js';

// Administración del asistente WhatsApp:
// - bandeja del operador (atender/derivar) — sólo canOperate;
// - auditoría global — sólo canAudit.
// El envío real queda gobernado por dispatchAllowed / WHATSAPP_CLOUD_SEND_ENABLED.

const WHATSAPP_CUSTOMER_SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_REPLY_LENGTH = 4096;

function adminError(message, status = 403, code = 'WHATSAPP_ADMIN_FORBIDDEN') {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

export function operatorReplyIdempotencyKey(tenantId, inboundId, body) {
  return createHash('sha256')
    .update(`operator-reply:${tenantId}:${inboundId}:${body}`)
    .digest('hex');
}

function cleanText(value, maxLength = 4096) {
  const text = String(value ?? '').trim();
  return text ? text.slice(0, maxLength) : null;
}

export function createWhatsappAdminService({
  repository,
  operators = new Set(),
  superAdminEmails = new Set(),
  resolvePermissions = resolveWhatsappPermissions,
} = {}) {
  if (!repository) {
    throw adminError('El repositorio del asistente no está configurado.', 503, 'WHATSAPP_ADMIN_UNAVAILABLE');
  }

  function permissionsFor(email, role) {
    return resolvePermissions({ email, role, operators, superAdminEmails });
  }

  function requireOperator(email, role) {
    const perms = permissionsFor(email, role);
    if (!perms.canOperate) {
      throw adminError('Solo el operador autorizado puede atender o derivar.');
    }
    return perms;
  }

  function requireAudit(email, role) {
    const perms = permissionsFor(email, role);
    if (!perms.canAudit) {
      throw adminError('Solo el superadmin puede auditar la actividad de WhatsApp.');
    }
    return perms;
  }

  return {
    getPermissions({ email, role } = {}) {
      const perms = permissionsFor(email, role);
      return { role: perms.role, canOperate: perms.canOperate, canAudit: perms.canAudit };
    },

    async listOperatorInbox({ email, role, limit = 50 } = {}) {
      requireOperator(email, role);
      const bounded = Math.max(1, Math.min(100, Number(limit) || 50));
      const items = await repository.listInbound({ limit: bounded });
      return { items };
    },

    async operatorReply({ email, role, inboundId, body } = {}) {
      requireOperator(email, role);
      const text = cleanText(body, MAX_REPLY_LENGTH);
      if (!text) {
        throw adminError('La respuesta no puede estar vacía.', 400, 'WHATSAPP_ADMIN_REPLY_INVALID');
      }
      const inbound = await repository.getInbound(inboundId);
      if (!inbound) {
        throw adminError('Conversación no encontrada.', 404, 'WHATSAPP_ADMIN_NOT_FOUND');
      }
      const idempotencyKey = operatorReplyIdempotencyKey(inbound.tenant_id, inbound.id, text);
      const outbox = await repository.createOperatorReply({ inbound, body: text, idempotencyKey });
      return { ok: true, outboxId: outbox.id, status: outbox.status ?? 'pending' };
    },

    async operatorHandoff({ email, role, inboundId } = {}) {
      requireOperator(email, role);
      const inbound = await repository.getInbound(inboundId);
      if (!inbound) {
        throw adminError('Conversación no encontrada.', 404, 'WHATSAPP_ADMIN_NOT_FOUND');
      }
      const classification = await repository.recordHandoff({ inbound, operatorEmail: email });
      return { ok: true, classificationId: classification.id, disposition: 'handoff' };
    },

    async listAudit({ email, role } = {}) {
      requireAudit(email, role);
      return repository.listAuditActivity();
    },
  };
}

export function createSupabaseWhatsappAdminRepository(supabaseAdmin) {
  if (!supabaseAdmin?.from) return null;
  const q = async (builder) => {
    const { data, error } = await builder;
    if (error) {
      throw adminError('No se pudo leer la actividad de WhatsApp.', 503, 'WHATSAPP_ADMIN_UNAVAILABLE');
    }
    return data;
  };

  return {
    async listInbound({ limit }) {
      return q(supabaseAdmin
        .from('whatsapp_inbound_messages')
        .select('id, tenant_id, channel_id, from_wa_id, text_body, received_at')
        .order('received_at', { ascending: false })
        .limit(limit));
    },

    async getInbound(id) {
      const { data, error } = await supabaseAdmin
        .from('whatsapp_inbound_messages')
        .select('id, tenant_id, channel_id, provider_message_id, from_wa_id, text_body, received_at')
        .eq('id', id)
        .maybeSingle();
      if (error) throw adminError('No se pudo leer la conversación.', 503, 'WHATSAPP_ADMIN_UNAVAILABLE');
      return data || null;
    },

    async createOperatorReply({ inbound, body, idempotencyKey }) {
      const receivedAt = new Date(inbound.received_at).getTime();
      const windowExpiresAt = new Date(receivedAt + WHATSAPP_CUSTOMER_SERVICE_WINDOW_MS).toISOString();
      const { data, error } = await supabaseAdmin
        .from('whatsapp_outbox')
        .insert({
          tenant_id: inbound.tenant_id,
          channel_id: inbound.channel_id,
          inbound_message_id: inbound.id,
          idempotency_key: idempotencyKey,
          to_wa_id: inbound.from_wa_id,
          reply_to_provider_message_id: inbound.provider_message_id,
          message_type: 'text',
          text_body: body,
          status: 'pending',
          customer_service_window_expires_at: windowExpiresAt,
        })
        .select('id, status')
        .single();
      if (error && error.code !== '23505') {
        throw adminError('No se pudo guardar la respuesta.', 503, 'WHATSAPP_ADMIN_UNAVAILABLE');
      }
      if (error && error.code === '23505') {
        const existing = await supabaseAdmin
          .from('whatsapp_outbox')
          .select('id, status')
          .eq('tenant_id', inbound.tenant_id)
          .eq('idempotency_key', idempotencyKey)
          .maybeSingle();
        if (existing.data) return existing.data;
      }
      return data;
    },

    async recordHandoff({ inbound, operatorEmail }) {
      const { data, error } = await supabaseAdmin
        .from('whatsapp_assistant_classifications')
        .insert({
          inbound_message_id: inbound.id,
          tenant_id: inbound.tenant_id,
          disposition: 'handoff',
        })
        .select('id, disposition')
        .single();
      if (error) throw adminError('No se pudo registrar la derivación.', 503, 'WHATSAPP_ADMIN_UNAVAILABLE');
      return data;
    },

    async listAuditActivity() {
      const [inbound, outbox, classifications, operators, config] = await Promise.all([
        q(supabaseAdmin.from('whatsapp_inbound_messages')
          .select('id, tenant_id, channel_id, from_wa_id, text_body, received_at')
          .order('received_at', { ascending: false }).limit(200)),
        q(supabaseAdmin.from('whatsapp_outbox')
          .select('id, tenant_id, inbound_message_id, to_wa_id, text_body, status, attempts, last_error, sent_at, created_at')
          .order('created_at', { ascending: false }).limit(200)),
        q(supabaseAdmin.from('whatsapp_assistant_classifications')
          .select('id, inbound_message_id, tenant_id, topic_slug, disposition, created_at')
          .order('created_at', { ascending: false }).limit(200)),
        q(supabaseAdmin.from('whatsapp_assistant_operators')
          .select('id, display_name, external_id, active, created_at')),
        q(supabaseAdmin.from('whatsapp_assistant_config').select('key, value, updated_at')),
      ]);
      return { inbound, outbox, classifications, operators, config };
    },
  };
}

export function registerWhatsappAdminRoutes(app, {
  whatsappAdminService,
  authUserFromBearer,
  fetchUserRoleRow,
  logger = console,
} = {}) {
  if (!whatsappAdminService) return;

  async function adminContext(req) {
    const user = await authUserFromBearer(req);
    if (!user?.email) {
      throw adminError('No autorizado.', 401, 'WHATSAPP_ADMIN_UNAUTHENTICATED');
    }
    const row = await fetchUserRoleRow(user.email);
    return { email: user.email, role: row?.role ?? null };
  }

  function handle(res, error) {
    const status = Number(error?.status) || 503;
    logger?.error?.('[whatsapp-admin] request failed', { code: error?.code || 'WHATSAPP_ADMIN_UNAVAILABLE' });
    return res.status(status).json({
      error: error?.message || 'No disponible.',
      code: error?.code || 'WHATSAPP_ADMIN_UNAVAILABLE',
    });
  }

  app.get('/api/admin/whatsapp/permissions', async (req, res) => {
    try {
      const { email, role } = await adminContext(req);
      return res.json(whatsappAdminService.getPermissions({ email, role }));
    } catch (error) {
      return handle(res, error);
    }
  });

  app.get('/api/admin/whatsapp/inbox', async (req, res) => {
    try {
      const { email, role } = await adminContext(req);
      const result = await whatsappAdminService.listOperatorInbox({
        email,
        role,
        limit: Number(req.query.limit) || 50,
      });
      return res.json(result);
    } catch (error) {
      return handle(res, error);
    }
  });

  app.post('/api/admin/whatsapp/inbox/:id/reply', async (req, res) => {
    try {
      const { email, role } = await adminContext(req);
      const result = await whatsappAdminService.operatorReply({
        email,
        role,
        inboundId: req.params.id,
        body: req.body?.body,
      });
      return res.json(result);
    } catch (error) {
      return handle(res, error);
    }
  });

  app.post('/api/admin/whatsapp/inbox/:id/handoff', async (req, res) => {
    try {
      const { email, role } = await adminContext(req);
      const result = await whatsappAdminService.operatorHandoff({
        email,
        role,
        inboundId: req.params.id,
      });
      return res.json(result);
    } catch (error) {
      return handle(res, error);
    }
  });

  app.get('/api/admin/whatsapp/audit', async (req, res) => {
    try {
      const { email, role } = await adminContext(req);
      const result = await whatsappAdminService.listAudit({ email, role });
      return res.json(result);
    } catch (error) {
      return handle(res, error);
    }
  });
}
