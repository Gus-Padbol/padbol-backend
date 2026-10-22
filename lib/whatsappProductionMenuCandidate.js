import { createCrmFunnel } from './whatsappProductionFunnelCandidate.js';
import { createWhatsappLanguageMenu } from './whatsappLanguageMenuCandidate.js';

// Inert candidate: integrations must explicitly enable and supply the durable
// production store; it neither owns nor invokes a transport.
export function createProductionMenuCandidate({ enabled = false, crmService, atomicMenuStore, env = {}, fetchImpl } = {}) {
  if (!enabled) return null;
  if (env.BACKEND_RUNTIME_MODE !== 'production' || !crmService?.ingestInbound
      || !atomicMenuStore?.findByInbound || !atomicMenuStore?.commit) throw new Error('WA_MENU_PRODUCTION_CONFIGURATION_INVALID');
  // This user-facing English version remains QA-only pending human review.
  const languageMenu = createWhatsappLanguageMenu({env:{...env, CRM_WHATSAPP_ENGLISH_MENU_QA_PREVIEW:'false'}, ...(fetchImpl ? {fetchImpl} : {})});
  const funnel = createCrmFunnel({crmService, languageMenu, atomicMenuStore, requireTicketReference:true});
  return Object.freeze({async ingestWhatsapp(input) {
    if (!input?.menuDelivery?.inboundId || !/^[a-f0-9]{64}$/.test(input.menuDelivery.idempotencyKey || ''))
      throw new Error('WA_MENU_PRODUCTION_ATOMIC_REQUIRED');
    return funnel.ingestWhatsapp(input);
  }});
}
