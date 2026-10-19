import { resolveWhatsappPermissions } from './whatsappAssistant.js';

// Explicitly authorized commercial forms operator. This grants no WhatsApp or global admin role.
export const CRM_COMMERCIAL_OPERATORS = Object.freeze([
  Object.freeze({ email: 'sm@padbol.com', userId: '7225442b-defd-42c1-a5a2-b9c1c339fa69' }),
]);

export const CRM_COMMERCIAL_FORM_ORIGINS = Object.freeze([
  'web_form:Consulta Padbol · Quiero una cancha Padbol',
  'web_form:Consulta Padbol · Quiero sumar Padbol a mi club',
  'web_form:Consulta Padbol · Quiero abrir un Punto Padbol exclusivo',
  'web_form:Consulta Padbol · Quiero representar Padbol en mi ciudad o región',
  'web_form:Consulta Padbol · Quiero representar Padbol en mi país',
  'web_form:solicitud_licencia',
  'web_form:dev_padbol_contacto_business',
]);

export function isCommercialFormConversation(conversation) {
  if (conversation?.source_channel !== 'email' || !CRM_COMMERCIAL_FORM_ORIGINS.includes(conversation?.origin)) return false;
  const data = conversation?.qualification_data;
  const workflows = [data?.routing?.workflow, data?.form_submission?.fields?.workflow].filter(Boolean);
  return workflows.every(value => value === 'commercial_lead');
}

export function commercialOperatorPermissions({ email, userId, operators = [] } = {}) {
  const entry = operators.find(operator => operator.email === String(email || '').trim().toLowerCase());
  if (!entry) return null;
  if (entry.userId !== userId) return { role: 'none', canOperate: false, canAudit: false, commercialOnly: true };
  return { role: 'commercial_operator', canOperate: true, canAudit: false, commercialOnly: true };
}

export function isRestrictedCommercialEmail(email) {
  return CRM_COMMERCIAL_OPERATORS.some(operator => operator.email === String(email || '').trim().toLowerCase());
}

export function commercialSafeWhatsappPermissions(context) {
  if (isRestrictedCommercialEmail(context?.email)) return { role: 'none', canOperate: false, canAudit: false };
  return resolveWhatsappPermissions(context);
}
