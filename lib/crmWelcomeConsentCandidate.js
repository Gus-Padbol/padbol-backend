// The UI must show the exact language-specific consent text below before the
// unchecked checkbox can be selected. Version changes require a new record.
export const WELCOME_CONSENT_VERSION = 'contacto-whatsapp-consulta-v1';
export const WELCOME_CONSENT_TEXT = Object.freeze({
  es: 'Acepto que Padbol International me contacte por WhatsApp para responder y dar seguimiento a esta consulta. Puedo retirar mi autorización en cualquier momento.',
  en: 'I agree that Padbol International may contact me on WhatsApp to answer and follow up on this enquiry. I can withdraw my consent at any time.',
});

export function buildWelcomeConsent(input, {source, now = () => new Date()} = {}) {
  if (input?.consentWhatsapp !== true) return { accepted: false };
  const language = String(input.whatsappConsentLanguage || '').trim().toLowerCase();
  if (!Object.hasOwn(WELCOME_CONSENT_TEXT, language)) return { accepted: false, error: 'unsupported_consent_language' };
  if (input.whatsappConsentVersion !== WELCOME_CONSENT_VERSION || input.whatsappConsentText !== WELCOME_CONSENT_TEXT[language]) return { accepted: false, error: 'consent_text_mismatch' };
  // Source is a trusted route constant, never a browser-provided value.
  if (typeof source !== 'string' || !/^web:[a-z0-9_-]{1,60}$/.test(source)) throw new Error('trusted consent source required');
  const timestamp = now();
  if (!(timestamp instanceof Date) || !Number.isFinite(timestamp.valueOf())) throw new Error('invalid server clock');
  return {accepted:true, version:WELCOME_CONSENT_VERSION, text:WELCOME_CONSENT_TEXT[language], language, source, acceptedAt:timestamp.toISOString(), purpose:'consultation_followup'};
}
