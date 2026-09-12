import {
  buildWhatsappTextPayload,
  createSupabaseWhatsappRepository,
  createWhatsappCloudService,
  describeWhatsappRecipient,
} from './whatsappCloud.js';

export const WHATSAPP_QA_SANDBOX_SEND_FLAG = 'WHATSAPP_QA_SANDBOX_SEND_ENABLED';
const QA = Object.freeze({
  project: 'vxikhdulhuvghfqeutnp', service: 'srv-dahbs0dbedkc73a0kf4g',
  origin: 'https://padbol-backend-qa.onrender.com', graphVersion: 'v26.0',
  organization: '067d7269-27e3-4aaf-9da4-c80ba56e1d2a',
  tenant: '3a2e5306-e1fc-4b24-b03b-fe965fc37e97',
  channel: '81bba438-eb65-4f70-bdf9-32f6c113d5bf',
  phone: '1300908966439481', waba: '1384040043841797',
  // Destinatario permitido por Meta para el ensayo QA (error 131030 evita otros).
  recipient: '54221156280711',
  reply: 'Prueba técnica de Padbol Match recibida correctamente.',
});
const SEND_URL = `https://graph.facebook.com/${QA.graphVersion}/${QA.phone}/messages`;
const fail = (code = 'WHATSAPP_QA_SANDBOX_SCOPE_REQUIRED') => {
  throw Object.assign(new Error('El ensayo de WhatsApp QA no está disponible.'), { status: 503, code });
};
const configured = value => typeof value === 'string' && Boolean(value.trim());
const exactChannel = channel => channel?.id === QA.channel && channel.tenant_id === QA.tenant
  && channel.meta_phone_number_id === QA.phone && channel.meta_waba_id === QA.waba
  && channel.credential_ref === 'TEST' && channel.auto_reply_text === QA.reply
  && channel.active === true && channel.whatsapp_tenants?.status === 'active'
  && channel.whatsapp_tenants.organization_id === QA.organization;
const exactRowScope = row => row?.tenant_id === QA.tenant && row.channel_id === QA.channel;
const DIAGNOSTIC_PHASES = new Set(['before_transport', 'sender_validation_rejected', 'transport_invoked', 'transport_failed', 'http_response', 'provider_rejection', 'ack_validated', 'persistence_failed', 'timeout']);
const boundedDiagnosticCode = value => Number.isSafeInteger(value) && value >= 0 && value <= 9999999999 ? value : null;

function createSendDiagnostic(logger) {
  return event => {
    if (!DIAGNOSTIC_PHASES.has(event?.phase)) return;
    const recipient = event.recipient && typeof event.recipient === 'object'
      ? {
          digitCount: Number.isInteger(event.recipient.digitCount) && event.recipient.digitCount >= 0 ? event.recipient.digitCount : null,
          last4: typeof event.recipient.last4 === 'string' ? event.recipient.last4.slice(0, 4) : null,
          hash: typeof event.recipient.hash === 'string' ? event.recipient.hash.slice(0, 64) : null,
          masked: typeof event.recipient.masked === 'string' ? event.recipient.masked.slice(0, 20) : null,
        }
      : null;
    const safe = {
      phase: event.phase,
      httpStatus: Number.isInteger(event.httpStatus) && event.httpStatus >= 100 && event.httpStatus <= 599 ? event.httpStatus : null,
      providerCode: boundedDiagnosticCode(event.providerCode),
      providerSubcode: boundedDiagnosticCode(event.providerSubcode),
      recipient,
    };
    try { Promise.resolve(logger(JSON.stringify(safe))).catch(() => {}); } catch { /* Diagnostics never change delivery state. */ }
  };
}

// Capture before installStagingFetchGuard. The captured transport stays private:
// callers receive only a factory for the signed webhook's restricted service.
// This does not relax the general outbound, payment, push or background gates.
export function createWhatsappQaSandboxServiceFactory({
  env = process.env, fetchImpl = globalThis.fetch, now = () => new Date(),
  logger = line => console.info('[whatsapp-qa-send-diagnostic]', line),
} = {}) {
  if (env[WHATSAPP_QA_SANDBOX_SEND_FLAG] !== 'true') return null;
  if (env.BACKEND_RUNTIME_MODE !== 'staging' || env.STAGING_SUPABASE_PROJECT_REF !== QA.project
    || env.SUPABASE_URL !== `https://${QA.project}.supabase.co`
    || env.RENDER_SERVICE_ID !== QA.service || env.RENDER_EXTERNAL_URL !== QA.origin
    || env.WHATSAPP_META_GRAPH_VERSION !== QA.graphVersion
    || env.WHATSAPP_CLOUD_SEND_ENABLED !== 'true'
    || env.WHATSAPP_CLOUD_MAX_SEND_ATTEMPTS !== '1'
    || ['OUTBOUND_DELIVERY_ENABLED', 'BACKGROUND_JOBS_ENABLED', 'PUSH_SEND_ENABLED']
      .some(key => env[key] !== 'false')
    || ['WHATSAPP_META_TOKEN_TEST', 'WHATSAPP_META_APP_SECRET', 'WHATSAPP_META_VERIFY_TOKEN']
      .some(key => !configured(env[key])) || typeof fetchImpl !== 'function') {
    fail('WHATSAPP_QA_SANDBOX_CONFIGURATION_INVALID');
  }
  const accessToken = env.WHATSAPP_META_TOKEN_TEST.trim();
  const diagnostic = createSendDiagnostic(logger);

  return function createService({ supabaseAdmin }) {
    const repository = createSupabaseWhatsappRepository(supabaseAdmin);
    if (!repository) fail('WHATSAPP_QA_SANDBOX_STORAGE_REQUIRED');
    const findChannel = async () => {
      const { data, error } = await supabaseAdmin.from('whatsapp_tenant_channels')
        .select('id, tenant_id, meta_phone_number_id, meta_waba_id, credential_ref, auto_reply_text, active, whatsapp_tenants!inner(status, organization_id)')
        .eq('id', QA.channel).eq('tenant_id', QA.tenant)
        .eq('meta_phone_number_id', QA.phone).eq('meta_waba_id', QA.waba)
        .eq('credential_ref', 'TEST').eq('active', true)
        .eq('whatsapp_tenants.status', 'active')
        .eq('whatsapp_tenants.organization_id', QA.organization).maybeSingle();
      if (error) fail('WHATSAPP_QA_SANDBOX_STORAGE_UNAVAILABLE');
      return exactChannel(data) ? data : null;
    };

    // No queue sweep or sender is exposed. Each signed webhook gets ephemeral
    // permits tied to its persisted inbound and successful one-attempt claim.
    return Object.freeze({
      async handleWebhook(payload) {
        if (payload?.object !== 'whatsapp_business_account') fail();
        for (const entry of Array.isArray(payload.entry) ? payload.entry : []) {
          if (entry?.id !== QA.waba) fail();
          for (const change of Array.isArray(entry.changes) ? entry.changes : []) {
            if (change?.field === 'messages' && change.value?.metadata?.phone_number_id !== QA.phone) fail();
          }
        }
        const inboundProof = new Map();
        const outboxProof = new Map();
        const permits = new Map();
        const permitKey = (providerId, recipient) => JSON.stringify([providerId, recipient]);
        const validOutbox = (row, inbound) => exactRowScope(row)
          && row.inbound_message_id === inbound.id && row.to_wa_id === inbound.from_wa_id
          && row.reply_to_provider_message_id === inbound.provider_message_id
          && row.text_body === QA.reply && row.message_type === 'text';
        const scopedRepository = {
          ...repository,
          findActiveChannelByPhoneNumberId: phone => phone === QA.phone ? findChannel() : null,
          findActiveChannelById: (tenant, channel) => tenant === QA.tenant && channel === QA.channel
            ? findChannel() : null,
          async recordInbound(args) {
            if (!exactChannel(args.channel) || args.inbound.phoneNumberId !== QA.phone) fail();
            const stored = await repository.recordInbound(args);
            if (!exactRowScope(stored.row) || stored.row.provider_message_id !== args.inbound.providerMessageId
              || stored.row.from_wa_id !== args.inbound.fromWaId) fail();
            inboundProof.set(stored.row.id, stored.row);
            return stored;
          },
          async ensureOutbox(args) {
            const inbound = inboundProof.get(args.inboundRow?.id);
            if (!inbound || !exactChannel(args.channel) || args.body !== QA.reply) fail();
            const stored = await repository.ensureOutbox(args);
            if (!validOutbox(stored.row, inbound)) fail();
            outboxProof.set(stored.row.id, inbound);
            return stored;
          },
          async claimPendingOutbox(row, at) {
            const inbound = outboxProof.get(row.id);
            if (!inbound || !validOutbox(row, inbound) || row.attempts !== 0) fail();
            const claimed = await repository.claimPendingOutbox(row, at);
            if (claimed) {
              if (!validOutbox(claimed, inbound) || claimed.status !== 'sending' || claimed.attempts !== 1) fail();
              permits.set(permitKey(inbound.provider_message_id, inbound.from_wa_id), claimed);
            }
            return claimed;
          },
        };
        const sender = {
          async sendText({ channel, toWaId, body, replyToProviderMessageId }) {
            const key = permitKey(replyToProviderMessageId, toWaId);
            const claimed = permits.get(key);
            permits.delete(key); // Consume before I/O, including uncertain failures.
            const expiresAt = new Date(claimed?.customer_service_window_expires_at).getTime();
            if (!claimed || !exactChannel(channel) || body !== QA.reply
              || !Number.isFinite(expiresAt) || now().getTime() >= expiresAt) {
              diagnostic({ phase: 'sender_validation_rejected' });
              fail();
            }
            const controller = new AbortController();
            let timer;
            try {
              const request = (async () => {
                // El ensayo QA debe dirigirse únicamente al destinatario que Meta autoriza,
                // sin depender del `from` del webhook entrante ni alterar los registros.
                const recipient = QA.recipient;
                const options = {
                  method: 'POST', redirect: 'error', signal: controller.signal,
                  headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
                  body: JSON.stringify(buildWhatsappTextPayload({ toWaId: recipient, body: QA.reply, replyToProviderMessageId })),
                };
                let response;
                try {
                  diagnostic({ phase: 'transport_invoked', recipient: describeWhatsappRecipient(recipient) });
                  response = await fetchImpl(SEND_URL, options);
                } catch (error) {
                  if (!controller.signal.aborted) diagnostic({ phase: 'transport_failed' });
                  throw error;
                }
                if (!controller.signal.aborted) diagnostic({ phase: 'http_response', httpStatus: response.status });
                if (response.redirected || response.status >= 300 && response.status < 400
                  || response.url && response.url !== SEND_URL) {
                  fail('WHATSAPP_QA_SANDBOX_SEND_UNCERTAIN');
                }
                if (!response.ok) {
                  const rejected = await response.json().catch(() => null);
                  if (!controller.signal.aborted) diagnostic({ phase: 'provider_rejection', httpStatus: response.status,
                    providerCode: rejected?.error?.code, providerSubcode: rejected?.error?.error_subcode });
                  fail('WHATSAPP_QA_SANDBOX_SEND_UNCERTAIN');
                }
                const json = await response.json();
                const providerMessageId = json?.messages?.[0]?.id;
                if (typeof providerMessageId !== 'string' || !providerMessageId.trim() || providerMessageId.length > 512) {
                  fail('WHATSAPP_QA_SANDBOX_SEND_UNCERTAIN');
                }
                if (!controller.signal.aborted) diagnostic({ phase: 'ack_validated' });
                return { providerMessageId };
              })();
              const timeout = new Promise((_, reject) => {
                timer = setTimeout(() => {
                  diagnostic({ phase: 'timeout' });
                  controller.abort();
                  reject(Object.assign(new Error('WhatsApp QA timeout'), { code: 'WHATSAPP_QA_SANDBOX_SEND_UNCERTAIN' }));
                }, 15000);
              });
              return await Promise.race([request, timeout]);
            } catch { fail('WHATSAPP_QA_SANDBOX_SEND_UNCERTAIN'); }
            finally { clearTimeout(timer); controller.abort(); }
          },
        };
        const service = createWhatsappCloudService({ repository: scopedRepository, sender,
          sendEnabled: true, maxSendAttempts: 1, now, onSendDiagnostic: diagnostic });
        return service.handleWebhook(payload);
      },
    });
  };
}
