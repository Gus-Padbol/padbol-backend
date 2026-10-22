import { verifyMetaWebhookSignature, extractWhatsappInboundMessages } from './whatsappCloud.js';
import { createHmac, timingSafeEqual } from 'node:crypto';

// Verify Meta first, then authenticate a strictly filtered payload for production.
export const RELAY_PATH = '/api/webhooks/whatsapp-qa-relay';
const TARGET_PHONE = '1376102838911694';
const TARGET_WABA = '928900479733370';
const DESTINATION = `https://padbol-backend.onrender.com${RELAY_PATH}`;
const QA_REF = 'vxikhdulhuvghfqeutnp';
const QA_SERVICE = 'srv-dahbs0dbedkc73a0kf4g';
const PRODUCTION_REF = 'vpldffhsxhgnmitiikof';
const DOMAIN = 'padbol-qa-to-prod-v1\n';
const error = () => Object.assign(new Error('WhatsApp relay unavailable'), { code: 'WHATSAPP_RELAY_UNAVAILABLE', status: 503 });
const relayMac = (secret, timestamp, body) => createHmac('sha256', secret).update(DOMAIN).update(timestamp).update('\n').update(body).digest('hex');
function countUnsupportedWhatsappMessages(payload) {
  let count = 0;
  for (const entry of payload.entry) for (const change of entry.changes)
    for (const message of Array.isArray(change?.value?.messages) ? change.value.messages : [])
      if (message?.type && message.type !== 'text') count += 1;
  return count;
}

function selectTarget(payload) {
  if (!payload || payload.object !== 'whatsapp_business_account' || !Array.isArray(payload.entry)) return null;
  const entry = payload.entry.filter(item => item?.id === TARGET_WABA).map(item => ({ id: item.id, changes: Array.isArray(item?.changes)
    ? item.changes.filter(change => change?.field === 'messages' && change?.value?.metadata?.phone_number_id === TARGET_PHONE)
    : [] })).filter(item => item.changes.length);
  return entry.length ? { object: 'whatsapp_business_account', entry } : null;
}

export function createQaRelay({ env = process.env, fetchImpl = globalThis.fetch, timeoutMs = 8000, now = Date.now } = {}) {
  if (env.WHATSAPP_QA_RELAY_ENABLED !== 'true') return null;
  if (env.BACKEND_RUNTIME_MODE !== 'staging' || env.RENDER_SERVICE_ID !== QA_SERVICE ||
      env.STAGING_SUPABASE_PROJECT_REF !== QA_REF || env.SUPABASE_URL !== `https://${QA_REF}.supabase.co` ||
      env.WHATSAPP_META_QA_RESUBSCRIBE_ONCE !== 'false' ||
      !env.WHATSAPP_META_APP_SECRET || typeof fetchImpl !== 'function') throw error();
  const ticketSender = String(env.WHATSAPP_QA_MENU_TEST_RECIPIENT || '').trim();
  if (env.WHATSAPP_QA_RELAY_TICKET_REFERENCES_ENABLED === 'true' && !/^[1-9][0-9]{7,14}$/.test(ticketSender)) throw error();
  return async ({ rawBody, signature }) => {
    if (!verifyMetaWebhookSignature(rawBody, signature, env.WHATSAPP_META_APP_SECRET)) throw error();
    let payload;
    try { payload = JSON.parse(rawBody.toString('utf8')); } catch { throw error(); }
    const selected = selectTarget(payload);
    if (!selected) return { forwarded: false };
    const filteredBody = Buffer.from(JSON.stringify(selected));
    const timestamp = String(Math.floor(now() / 1000));
    const filteredSignature = relayMac(env.WHATSAPP_META_APP_SECRET, timestamp, filteredBody);
    try {
      const response = await fetchImpl(DESTINATION, { method: 'POST', redirect: 'error',
        headers: { 'content-type': 'application/json', 'x-padbol-relay-timestamp': timestamp, 'x-padbol-relay-signature': filteredSignature }, body: filteredBody,
        signal: AbortSignal.timeout(timeoutMs) });
      if (!response.ok || response.redirected || (response.url && response.url !== DESTINATION)) throw error();
      if (env.WHATSAPP_QA_RELAY_TICKET_REFERENCES_ENABLED !== 'true') return { forwarded: true };
      const body = await response.json();
      if (!body?.ok || !Array.isArray(body.references)) throw error();
      const expected = [...new Set(extractWhatsappInboundMessages(selected)
        .filter(message => !message.mediaType && message.fromWaId === ticketSender).map(message => message.providerMessageId))];
      const actual = new Map();
      for (const item of body.references) {
        if (!item || typeof item.providerMessageId !== 'string' || !/^PB-(?:[0-9A-F]{32}|[1-9][0-9]{5,11})$/.test(item.reference || '') || actual.has(item.providerMessageId)) throw error();
        actual.set(item.providerMessageId, item.reference);
      }
      if (actual.size !== expected.length || expected.some(id => !actual.has(id))) throw error();
      return { forwarded: true, references: actual };
    } catch { throw error(); }
  };
}

export function registerQaRelayReceiver(app, { env = process.env, whatsappService, now = Date.now, logger = console } = {}) {
  if (env.WHATSAPP_QA_RELAY_RECEIVE_ENABLED !== 'true') return;
  if (env.BACKEND_RUNTIME_MODE !== 'production' || env.RENDER_SERVICE_ID !== 'srv-d7brh3ea2pns73equ2ug' ||
      env.SUPABASE_URL !== `https://${PRODUCTION_REF}.supabase.co` ||
      !env.WHATSAPP_META_APP_SECRET || !whatsappService?.handleWebhook) throw error();
  app.post(RELAY_PATH, async (req, res) => {
    const timestamp = String(req.headers['x-padbol-relay-timestamp'] || '');
    const signature = String(req.headers['x-padbol-relay-signature'] || '');
    const age = Math.abs(Math.floor(now() / 1000) - Number(timestamp));
    if (!Buffer.isBuffer(req.rawBody) || !/^\d{10}$/.test(timestamp) || age > 300 || !/^[a-f0-9]{64}$/.test(signature) ||
      !timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(relayMac(env.WHATSAPP_META_APP_SECRET, timestamp, req.rawBody), 'hex')))
      return res.status(401).json({ code: 'WHATSAPP_SIGNATURE_INVALID' });
    let payload;
    try { payload = selectTarget(JSON.parse(req.rawBody.toString('utf8'))); }
    catch { return res.status(400).json({ code: 'WHATSAPP_PAYLOAD_INVALID' }); }
    if (!payload) return res.status(200).json({ ok: true, received: 0 });
    try {
      const unsupported = countUnsupportedWhatsappMessages(payload);
      if (unsupported) logger?.warn?.('[whatsapp-relay] unsupported incoming media', { code: 'WHATSAPP_UNSUPPORTED_MEDIA', count: unsupported });
      const result = await whatsappService.handleWebhook(payload);
      return res.status(200).json({ ok: true, received: result.received });
    } catch { return res.status(503).json({ code: 'WHATSAPP_RELAY_UNAVAILABLE' }); }
  });
}
