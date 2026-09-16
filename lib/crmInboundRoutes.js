import crypto from 'node:crypto';
import { emailEventToCrmIngest } from './crmInboundEmail.js';
import { formSubmissionToCrmIngest } from './crmInboundForm.js';

function inboundError(message, status = 400, code = 'CRM_INBOUND_INVALID') {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

function sameSecret(actual, expected) {
  const a = Buffer.from(String(actual || ''), 'utf8');
  const b = Buffer.from(String(expected || ''), 'utf8');
  return a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b);
}

// Endpoint deliberadamente independiente del proveedor. El adaptador externo debe
// transformar el webhook a este contrato canónico después de validar a su proveedor.
export function registerCrmInboundRoutes(app, {
  crmService,
  emailInboundSecret = '',
  logger = console,
} = {}) {
  if (!crmService) return;

  function requireInboundSecret(req) {
    if (!emailInboundSecret) {
      throw inboundError('La recepción CRM no está configurada.', 503, 'CRM_INBOUND_NOT_CONFIGURED');
    }
    const auth = String(req.headers.authorization || '');
    const supplied = auth.replace(/^Bearer\s+/i, '').trim();
    if (!sameSecret(supplied, emailInboundSecret)) {
      throw inboundError('No autorizado.', 401, 'CRM_INBOUND_UNAUTHENTICATED');
    }
  }

  function reject(res, error, source) {
    logger?.warn?.(`[crm-inbound-${source}] rejected`, { code: error?.code || 'CRM_INBOUND_UNAVAILABLE' });
    return res.status(Number(error?.status) || 503).json({
      error: error?.message || 'No disponible.',
      code: error?.code || 'CRM_INBOUND_UNAVAILABLE',
    });
  }

  app.post('/api/inbound/crm/email', async (req, res) => {
    try {
      requireInboundSecret(req);
      const ingest = emailEventToCrmIngest(req.body);
      if (!ingest) throw inboundError('Evento de correo inválido.');
      const result = await crmService.ingestInbound(ingest);
      return res.status(result.status === 'accepted' ? 201 : 200).json({
        ok: true,
        status: result.status,
        conversationId: result.conversation?.id || null,
      });
    } catch (error) { return reject(res, error, 'email'); }
  });

  app.post('/api/inbound/crm/form', async (req, res) => {
    try {
      requireInboundSecret(req);
      const ingest = formSubmissionToCrmIngest(req.body);
      if (!ingest) throw inboundError('Formulario inválido.');
      const result = await crmService.ingestInbound(ingest);
      return res.status(result.status === 'accepted' ? 201 : 200).json({
        ok: true,
        status: result.status,
        conversationId: result.conversation?.id || null,
      });
    } catch (error) { return reject(res, error, 'form'); }
  });
}
