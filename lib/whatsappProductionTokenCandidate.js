// Reuse the existing CRM token only for the single verified production channel.
// No fallback to QA or any other tenant/channel is allowed.
export function productionMenuTokenResolver(env = {}) {
  return channel => {
    if (env.BACKEND_RUNTIME_MODE !== 'production'
        || env.CRM_WHATSAPP_PHONE_NUMBER_ID !== '1376102838911694'
        || env.CRM_WHATSAPP_WABA_ID !== '928900479733370'
        || env.CRM_WHATSAPP_CHANNEL_ID !== '1bad838f-b5cc-4ae4-b28d-e63c998c6474'
        || channel?.id !== env.CRM_WHATSAPP_CHANNEL_ID
        || channel?.meta_phone_number_id !== env.CRM_WHATSAPP_PHONE_NUMBER_ID
        || channel?.credential_ref !== 'PRODUCTION') return null;
    const token = String(env.CRM_WHATSAPP_ACCESS_TOKEN || '').trim();
    return token && token.length <= 4000 ? token : null;
  };
}
