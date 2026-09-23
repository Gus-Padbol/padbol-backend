import { buildWhatsappTextPayload, describeWhatsappRecipient } from './whatsappCloud.js';

export const WHATSAPP_QA_CRM_MANUAL_SEND_FLAG = 'WHATSAPP_QA_CRM_MANUAL_SEND_ENABLED';

const QA = Object.freeze({
  project: 'vxikhdulhuvghfqeutnp',
  service: 'srv-dahbs0dbedkc73a0kf4g',
  origin: 'https://padbol-backend-qa.onrender.com',
  graphVersion: 'v26.0',
  organization: '067d7269-27e3-4aaf-9da4-c80ba56e1d2a',
  tenant: '3a2e5306-e1fc-4b24-b03b-fe965fc37e97',
  channel: '81bba438-eb65-4f70-bdf9-32f6c113d5bf',
  phone: '1376102838911694',
  waba: '1044713588190882',
});

const fail = (code, message = 'El envío manual de WhatsApp QA no está disponible.', status = 503) => {
  throw Object.assign(new Error(message), { code, status });
};

function exactEnvironment(env) {
  return env.BACKEND_RUNTIME_MODE === 'staging'
    && env.STAGING_SUPABASE_PROJECT_REF === QA.project
    && env.SUPABASE_URL === `https://${QA.project}.supabase.co`
    && env.RENDER_SERVICE_ID === QA.service
    && env.RENDER_EXTERNAL_URL === QA.origin
    && env.WHATSAPP_META_GRAPH_VERSION === QA.graphVersion
    && env.WHATSAPP_CLOUD_SEND_ENABLED === 'true'
    && env.WHATSAPP_CLOUD_MAX_SEND_ATTEMPTS === '1'
    && env.OUTBOUND_DELIVERY_ENABLED === 'false'
    && env.BACKGROUND_JOBS_ENABLED === 'false'
    && env.PUSH_SEND_ENABLED === 'false'
    && typeof env.WHATSAPP_META_TOKEN_TEST === 'string'
    && Boolean(env.WHATSAPP_META_TOKEN_TEST.trim());
}

export function createWhatsappQaCrmManualSender({
  env = process.env,
  fetchImpl = globalThis.fetch,
  now = () => new Date(),
  logger = console,
} = {}) {
  // This module ships only on the dedicated QA release branch. Enable it automatically
  // for the exact Render QA service, while retaining an immediate kill switch.
  if (env[WHATSAPP_QA_CRM_MANUAL_SEND_FLAG] === 'false') return null;
  if (env[WHATSAPP_QA_CRM_MANUAL_SEND_FLAG] !== 'true' && env.RENDER_SERVICE_ID !== QA.service) return null;
  if (!exactEnvironment(env) || typeof fetchImpl !== 'function') {
    fail('WHATSAPP_QA_CRM_MANUAL_CONFIGURATION_INVALID');
  }
  const accessToken = env.WHATSAPP_META_TOKEN_TEST.trim();
  const sendUrl = `https://graph.facebook.com/${QA.graphVersion}/${QA.phone}/messages`;

  return function bindWhatsappQaCrmManualSender({ supabaseAdmin } = {}) {
    if (!supabaseAdmin?.from) fail('WHATSAPP_QA_CRM_MANUAL_STORAGE_REQUIRED');
    return async function sendWhatsappReply({ conversation, body } = {}) {
      const recipient = String(conversation?.identity_used || '').replace(/\D/g, '');
      const text = String(body || '').trim();
      const receivedAt = new Date(conversation?.received_at || conversation?.updated_at || 0).getTime();
      if (conversation?.source_channel !== 'whatsapp'
        || conversation?.origin !== `whatsapp:${QA.phone}`
        || !/^\d{8,15}$/.test(recipient)
        || !text || text.length > 4096
        || !Number.isFinite(receivedAt)
        || now().getTime() - receivedAt >= 24 * 60 * 60 * 1000) {
        fail('WHATSAPP_QA_CRM_MANUAL_SCOPE_REQUIRED', 'La conversación no está habilitada para respuesta manual.', 409);
      }

      const { data: channel, error } = await supabaseAdmin.from('whatsapp_tenant_channels')
        .select('id, tenant_id, meta_phone_number_id, meta_waba_id, credential_ref, active, whatsapp_tenants!inner(status, organization_id)')
        .eq('id', QA.channel).eq('tenant_id', QA.tenant)
        .eq('meta_phone_number_id', QA.phone)
        .eq('credential_ref', 'TEST').eq('active', true)
        .eq('whatsapp_tenants.status', 'active')
        .eq('whatsapp_tenants.organization_id', QA.organization).maybeSingle();
      // Sending uses the exact Cloud API phone-number endpoint. Do not make a
      // stale informational WABA column in QA block a reply from that phone.
      if (error || !channel) fail('WHATSAPP_QA_CRM_MANUAL_CHANNEL_INVALID', 'El canal de WhatsApp QA no está disponible.', 503);

      logger?.info?.('[whatsapp-qa-crm] send attempt', {
        code: 'WHATSAPP_QA_CRM_SEND_ATTEMPT',
        recipient: describeWhatsappRecipient(recipient),
      });
      const response = await fetchImpl(sendUrl, {
        method: 'POST',
        redirect: 'error',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(buildWhatsappTextPayload({
          toWaId: recipient,
          body: text,
          replyToProviderMessageId: conversation.source_ref,
        })),
      });
      const json = await response.json().catch(() => ({}));
      if (!response.ok || response.redirected || response.url && response.url !== sendUrl) {
        const providerCode = Number.isSafeInteger(Number(json?.error?.code)) ? Number(json.error.code) : null;
        const providerSubcode = Number.isSafeInteger(Number(json?.error?.error_subcode)) ? Number(json.error.error_subcode) : null;
        logger?.warn?.('[whatsapp-qa-crm] provider rejected', {
          code: 'WHATSAPP_QA_CRM_PROVIDER_REJECTED',
          httpStatus: response.status,
          providerCode,
          providerSubcode,
        });
        const diagnostic = [providerCode && `código ${providerCode}`, providerSubcode && `subcódigo ${providerSubcode}`]
          .filter(Boolean).join(', ');
        fail('WHATSAPP_QA_CRM_SEND_FAILED', `Meta no aceptó la respuesta de WhatsApp${diagnostic ? ` (${diagnostic})` : ''}.`, 502);
      }
      const providerMessageId = String(json?.messages?.[0]?.id || '').trim();
      if (!providerMessageId || providerMessageId.length > 512) {
        fail('WHATSAPP_QA_CRM_RESPONSE_INVALID', 'Meta no confirmó la respuesta de WhatsApp.', 502);
      }
      logger?.info?.('[whatsapp-qa-crm] send accepted', { code: 'WHATSAPP_QA_CRM_SEND_ACCEPTED' });
      return { providerMessageId };
    };
  };
}
