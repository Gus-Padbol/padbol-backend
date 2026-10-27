import { buildWhatsappTextPayload } from './whatsappCloud.js';

const unavailable = (code, status = 503) => Object.assign(new Error('No se pudo confirmar el envío de WhatsApp. Revisá el historial antes de volver a intentar.'), { code, status });
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// This isolated manual sender never runs the automatic outbox or background worker.
export function createCrmWhatsappManualSender({ env = process.env, fetchImpl = globalThis.fetch, now = () => Date.now(), timeoutMs = 10000 } = {}) {
  if (env.CRM_WHATSAPP_MANUAL_SEND_ENABLED !== 'true' || env.CRM_WHATSAPP_MANUAL_SECURITY_APPROVED !== 'true') return null;
  const phone = env.CRM_WHATSAPP_PHONE_NUMBER_ID || '';
  const waba = env.CRM_WHATSAPP_WABA_ID || '';
  const channelId = env.CRM_WHATSAPP_CHANNEL_ID || '';
  const organization = env.CRM_WHATSAPP_ORGANIZATION_ID || '';
  const version = env.WHATSAPP_META_GRAPH_VERSION || '';
  const token = String(env.CRM_WHATSAPP_ACCESS_TOKEN || '').trim();
  if (env.BACKEND_RUNTIME_MODE !== 'production' || env.OUTBOUND_DELIVERY_ENABLED !== 'true' ||
      !/^\d{5,30}$/.test(phone) || !/^\d{5,30}$/.test(waba) || !uuid.test(channelId) || !uuid.test(organization) ||
      !/^v\d{1,3}\.0$/.test(version) || !token || typeof fetchImpl !== 'function' || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) throw unavailable('CRM_WHATSAPP_CONFIG_INVALID');
  const url = `https://graph.facebook.com/${version}/${phone}/messages`;
  return ({ supabaseAdmin }) => async ({ conversation, body }) => {
    const recipient = String(conversation?.identity_used || '');
    const text = String(body || '').trim();
    if (conversation?.source_channel !== 'whatsapp' || conversation.origin !== `whatsapp:${phone}` ||
        !/^\d{8,15}$/.test(recipient) || !text || text.length > 4096) throw unavailable('CRM_WHATSAPP_SCOPE_INVALID', 409);
    const channelResult = await supabaseAdmin.from('whatsapp_tenant_channels')
      .select('id,meta_phone_number_id,meta_waba_id,active,whatsapp_tenants!inner(status,organization_id)')
      .eq('id', channelId).eq('meta_phone_number_id', phone).eq('meta_waba_id', waba).eq('active', true)
      .eq('whatsapp_tenants.status', 'active').eq('whatsapp_tenants.organization_id', organization).maybeSingle();
    if (channelResult.error || !channelResult.data) throw unavailable('CRM_WHATSAPP_CHANNEL_INVALID');
    const eventResult = await supabaseAdmin.from('crm_inbound_events').select('received_at')
      .eq('conversation_id', conversation.id).eq('source_channel', 'whatsapp').eq('origin', conversation.origin)
      .order('received_at', { ascending: false }).limit(1).maybeSingle();
    const received = Date.parse(eventResult.data?.received_at || '');
    const age = now() - received;
    if (eventResult.error || !Number.isFinite(age) || age < 0 || age >= 24 * 60 * 60 * 1000)
      throw unavailable('CRM_WHATSAPP_WINDOW_CLOSED', 409);
    const controller = new AbortController();
    let timer;
    try {
      const operation = (async () => {
        const response = await fetchImpl(url, { method: 'POST', redirect: 'error', signal: controller.signal,
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(buildWhatsappTextPayload({ toWaId: recipient, body: text })) });
        const data = await response.json();
        if (!response.ok || response.redirected || (response.url && response.url !== url)) throw unavailable('CRM_WHATSAPP_SEND_UNCONFIRMED');
        const providerMessageId = typeof data?.messages?.[0]?.id === 'string' ? data.messages[0].id.trim() : '';
        if (!providerMessageId || providerMessageId.length > 512) throw unavailable('CRM_WHATSAPP_SEND_UNCONFIRMED');
        return { providerMessageId };
      })();
      const deadline = new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(unavailable('CRM_WHATSAPP_SEND_UNCONFIRMED'));
        }, timeoutMs);
      });
      return await Promise.race([operation, deadline]);
    } catch { throw unavailable('CRM_WHATSAPP_SEND_UNCONFIRMED'); }
    finally { clearTimeout(timer); }
  };
}
