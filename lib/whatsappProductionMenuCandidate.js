import { createCrmFunnel } from './whatsappProductionFunnelCandidate.js';
import { SPANISH_MENU, ENGLISH_MENU, renderLanguageMenu } from './whatsappLanguageMenuCandidate.js';

// Inert candidate: integrations must explicitly enable and supply the durable
// production store; it neither owns nor invokes a transport.
export function createProductionMenuCandidate({ enabled = false, crmService, atomicMenuStore, env = {}, fetchImpl } = {}) {
  if (!enabled) return null;
  if (env.BACKEND_RUNTIME_MODE !== 'production' || !crmService?.ingestInbound
      || !atomicMenuStore?.findByInbound || !atomicMenuStore?.commit) throw new Error('WA_MENU_PRODUCTION_CONFIGURATION_INVALID');
  // Spanish-only launch: do not offer an English option that cannot respond.
  // Do not infer the customer's language or produce an unreviewed translation.
  const languageMenu = {englishPreviewAvailable:false, routeEnglishToHuman:true, async resolve() { return {language:'es',menu:SPANISH_MENU,body:renderLanguageMenu(SPANISH_MENU)}; }};
  const funnel = createCrmFunnel({crmService, languageMenu, atomicMenuStore, requireTicketReference:true});
  // Private English review is restricted to one explicitly configured full number.
  const pilotNumber = String(env.CRM_WHATSAPP_ENGLISH_PILOT_PHONE || '').trim();
  if (pilotNumber && !/^[1-9][0-9]{7,14}$/.test(pilotNumber)) throw new Error('WA_ENGLISH_PILOT_NUMBER_INVALID');
  const pilotMenu = { englishPreviewAvailable:true, routeEnglishToHuman:false, async resolve(input) {
    const english = /^(?:hi|hello|hey|english|en|2|good morning|good afternoon|good evening)[.!?,\s]*$/iu.test(String(input || '').trim());
    const menu = english ? ENGLISH_MENU : SPANISH_MENU;
    return {language:english?'en':'es',menu,body:renderLanguageMenu(menu)};
  }};
  const pilotFunnel = createCrmFunnel({crmService, languageMenu:pilotMenu, atomicMenuStore, requireTicketReference:true});
  return Object.freeze({async ingestWhatsapp(input) {
    if (!input?.menuDelivery?.inboundId || !/^[a-f0-9]{64}$/.test(input.menuDelivery.idempotencyKey || ''))
      throw new Error('WA_MENU_PRODUCTION_ATOMIC_REQUIRED');
    return (pilotNumber && input.fromWaId === pilotNumber ? pilotFunnel : funnel).ingestWhatsapp(input);
  }});
}
