import { createCrmFunnel } from './whatsappProductionFunnelCandidate.js';
import { SPANISH_MENU, ENGLISH_MENU, renderLanguageMenu } from './whatsappLanguageMenuCandidate.js';

// Inert candidate: integrations must explicitly enable and supply the durable
// production store; it neither owns nor invokes a transport.
export function createProductionMenuCandidate({ enabled = false, crmService, atomicMenuStore, env = {}, fetchImpl, commercialChivi = null } = {}) {
  if (!enabled) return null;
  if (env.BACKEND_RUNTIME_MODE !== 'production' || !crmService?.ingestInbound
      || !atomicMenuStore?.findByInbound || !atomicMenuStore?.commit) throw new Error('WA_MENU_PRODUCTION_CONFIGURATION_INVALID');
  // Only Spanish and English are offered. Ambiguous messages get an explicit choice.
  const languageMenu = {englishPreviewAvailable:true, routeEnglishToHuman:false, async resolve(value) {
    const text = String(value || '').trim();
    const english = /^(?:2|hi|hello|hey|english|en|good morning|good afternoon|good evening)[.!?,\s]*$/iu.test(text)
      || /\b(?:i (?:want|would like|need|have|am|can)|could you|can you|please help|i'm|my (?:club|court|account))\b/iu.test(text);
    const spanish = /^(?:1|hola|buenas|español|espanol|spanish|es|buenos días|buenas tardes|buenas noches)[.!?,\s]*$/iu.test(text)
      || /\b(?:quiero|necesito|tengo|quisiera|puedo|podrían|podrian|ayuda|mi (?:club|cancha|cuenta))\b/iu.test(text);
    if (english === spanish) return null;
    const menu = english ? ENGLISH_MENU : SPANISH_MENU;
    return {language:english?'en':'es',menu,body:renderLanguageMenu(menu)};
  }};
  const funnel = createCrmFunnel({crmService, languageMenu, atomicMenuStore, requireTicketReference:true, commercialChivi});
  return Object.freeze({async ingestWhatsapp(input) {
    if (!input?.menuDelivery?.inboundId || !/^[a-f0-9]{64}$/.test(input.menuDelivery.idempotencyKey || ''))
      throw new Error('WA_MENU_PRODUCTION_ATOMIC_REQUIRED');
    return funnel.ingestWhatsapp(input);
  }});
}
