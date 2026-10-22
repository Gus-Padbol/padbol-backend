// Keep menu state and transport confined to the explicitly scoped QA sandbox.
export function isWhatsappQaMenuEnabled(env, { atomicMenuStore, qaRelay, sandboxFactory, outboundEnabled } = {}) {
  return env?.BACKEND_RUNTIME_MODE === 'staging'
    && env.STAGING_SUPABASE_PROJECT_REF === 'vxikhdulhuvghfqeutnp'
    && env.SUPABASE_URL === 'https://vxikhdulhuvghfqeutnp.supabase.co'
    && env.CRM_WHATSAPP_LANGUAGE_MENU_ENABLED === 'true'
    && env.WHATSAPP_MENU_ATOMIC_QA_ENABLED === 'true'
    && env.WHATSAPP_QA_MENU_AUTOMATION_ENABLED === 'true'
    && Boolean(atomicMenuStore) && typeof qaRelay === 'function'
    && typeof sandboxFactory === 'function' && outboundEnabled === true;
}
