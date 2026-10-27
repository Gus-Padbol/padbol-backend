// Review remains active when the automatic sender is stopped during recovery.
export function resolveWhatsappProductionMenuFlags(env = {}) {
  const sendEnabled = env.WHATSAPP_PRODUCTION_MENU_ENABLED === 'true';
  const reviewEnabled = env.WHATSAPP_MENU_REVIEW_ENABLED === 'true';
  if (sendEnabled && !reviewEnabled) throw new Error('WA_MENU_REVIEW_MUST_BE_ENABLED');
  return { sendEnabled, reviewEnabled };
}
