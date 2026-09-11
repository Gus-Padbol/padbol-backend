import {
  createHash,
  createHmac,
  timingSafeEqual,
} from 'node:crypto';

export const WHATSAPP_CLOUD_WEBHOOK_PATH = '/api/webhooks/whatsapp-cloud';
export const WHATSAPP_CUSTOMER_SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_WHATSAPP_AUTO_REPLY =
  'Gracias por escribir a Padbol Match. Recibimos tu mensaje y continuaremos por aquí.';

const META_SIGNATURE_PATTERN = /^sha256=([a-f0-9]{64})$/i;
const META_PHONE_NUMBER_ID_PATTERN = /^\d{6,32}$/;
const WA_ID_PATTERN = /^\d{6,20}$/;
const GRAPH_VERSION_PATTERN = /^v\d{1,3}\.\d{1,2}$/;
const CREDENTIAL_REF_PATTERN = /^[A-Z0-9_]{1,40}$/;
const MAX_PROVIDER_MESSAGE_ID_LENGTH = 512;
const MAX_MESSAGE_TEXT_LENGTH = 4096;
const MAX_ERROR_LENGTH = 500;

function whatsappError(message, status = 503, code = 'WHATSAPP_CLOUD_UNAVAILABLE') {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

function cleanText(value, maxLength) {
  const text = String(value ?? '').trim();
  return text ? text.slice(0, maxLength) : null;
}

function sha256(value) {
  return createHash('sha256').update(String(value ?? '')).digest();
}

function constantTimeTextEqual(left, right) {
  return timingSafeEqual(sha256(left), sha256(right));
}

function isoFromMetaTimestamp(value, fallback) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return fallback;
  const date = new Date(seconds * 1000);
  return Number.isNaN(date.getTime()) ? fallback : date.toISOString();
}

export function verifyMetaWebhookSignature(rawBody, signatureHeader, appSecret) {
  const secret = String(appSecret ?? '');
  const signature = String(signatureHeader ?? '').trim();
  const match = signature.match(META_SIGNATURE_PATTERN);
  if (!secret || !match || !Buffer.isBuffer(rawBody)) return false;
  const supplied = Buffer.from(match[1], 'hex');
  const expected = createHmac('sha256', secret).update(rawBody).digest();
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

export function verifyMetaWebhookChallenge(query = {}, verifyToken = '') {
  const mode = String(query['hub.mode'] ?? '');
  const token = String(query['hub.verify_token'] ?? '');
  const challenge = String(query['hub.challenge'] ?? '');
  const configured = String(verifyToken ?? '');
  if (!configured) {
    return { ok: false, status: 503, code: 'WHATSAPP_VERIFY_TOKEN_REQUIRED' };
  }
  if (mode !== 'subscribe' || !token || !constantTimeTextEqual(token, configured)) {
    return { ok: false, status: 403, code: 'WHATSAPP_WEBHOOK_VERIFICATION_FAILED' };
  }
  return { ok: true, status: 200, challenge };
}

export function extractWhatsappInboundMessages(payload, now = new Date()) {
  if (!payload || typeof payload !== 'object' || payload.object !== 'whatsapp_business_account') {
    return [];
  }
  const fallbackReceivedAt = now.toISOString();
  const result = [];

  for (const entry of Array.isArray(payload.entry) ? payload.entry : []) {
    for (const change of Array.isArray(entry?.changes) ? entry.changes : []) {
      if (change?.field !== 'messages') continue;
      const value = change?.value;
      const phoneNumberId = cleanText(value?.metadata?.phone_number_id, 32);
      if (!phoneNumberId || !META_PHONE_NUMBER_ID_PATTERN.test(phoneNumberId)) continue;

      for (const message of Array.isArray(value?.messages) ? value.messages : []) {
        const providerMessageId = cleanText(message?.id, MAX_PROVIDER_MESSAGE_ID_LENGTH);
        const fromWaId = cleanText(message?.from, 20);
        if (!providerMessageId || !fromWaId || !WA_ID_PATTERN.test(fromWaId)) continue;
        const messageType = cleanText(message?.type, 40) || 'unknown';
        const textBody = messageType === 'text'
          ? cleanText(message?.text?.body, MAX_MESSAGE_TEXT_LENGTH)
          : null;
        if (messageType !== 'text' || !textBody) continue;
        result.push({
          phoneNumberId,
          providerMessageId,
          fromWaId,
          messageType,
          textBody,
          receivedAt: isoFromMetaTimestamp(message?.timestamp, fallbackReceivedAt),
        });
      }
    }
  }
  return result;
}

export function buildWhatsappTextPayload({ toWaId, body, replyToProviderMessageId } = {}) {
  const to = cleanText(toWaId, 20);
  const text = cleanText(body, MAX_MESSAGE_TEXT_LENGTH);
  if (!to || !WA_ID_PATTERN.test(to) || !text) {
    throw whatsappError('El mensaje saliente no es válido.', 400, 'WHATSAPP_OUTBOUND_INVALID');
  }
  const replyTo = cleanText(replyToProviderMessageId, MAX_PROVIDER_MESSAGE_ID_LENGTH);
  return {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    ...(replyTo ? { context: { message_id: replyTo } } : {}),
    type: 'text',
    text: { preview_url: false, body: text },
  };
}

export function environmentWhatsappAccessTokenResolver(env = process.env) {
  return (channel) => {
    const credentialRef = String(channel?.credential_ref ?? '').trim().toUpperCase();
    if (!CREDENTIAL_REF_PATTERN.test(credentialRef)) return null;
    return cleanText(env[`WHATSAPP_META_TOKEN_${credentialRef}`], 4000);
  };
}

export function whatsappMaxSendAttemptsFromEnv(env = process.env) {
  const value = String(env.WHATSAPP_CLOUD_MAX_SEND_ATTEMPTS ?? '1').trim();
  if (!/^[1-9]\d{0,2}$/.test(value) || Number(value) > 100) {
    throw whatsappError('El límite de intentos de WhatsApp no es válido.', 503, 'WHATSAPP_ATTEMPT_LIMIT_INVALID');
  }
  return Number(value);
}

export function createWhatsappMetaSender({
  fetchImpl = globalThis.fetch,
  graphVersion,
  resolveAccessToken,
} = {}) {
  return {
    async sendText({ channel, toWaId, body, replyToProviderMessageId }) {
      if (typeof fetchImpl !== 'function') {
        throw whatsappError('El transporte de Meta no está disponible.');
      }
      const version = String(graphVersion ?? '').trim();
      const phoneNumberId = String(channel?.meta_phone_number_id ?? '').trim();
      const accessToken = await resolveAccessToken?.(channel);
      if (!GRAPH_VERSION_PATTERN.test(version) || !META_PHONE_NUMBER_ID_PATTERN.test(phoneNumberId)) {
        throw whatsappError('La configuración de Meta no es válida.');
      }
      if (!accessToken) {
        throw whatsappError('La credencial de Meta no está configurada.');
      }

      const response = await fetchImpl(
        `https://graph.facebook.com/${version}/${phoneNumberId}/messages`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(buildWhatsappTextPayload({
            toWaId,
            body,
            replyToProviderMessageId,
          })),
        },
      );
      const json = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw whatsappError('Meta no aceptó el mensaje saliente.', 502, 'WHATSAPP_META_SEND_FAILED');
      }
      const providerMessageId = cleanText(json?.messages?.[0]?.id, MAX_PROVIDER_MESSAGE_ID_LENGTH);
      if (!providerMessageId) {
        throw whatsappError('Meta no devolvió el identificador del mensaje.', 502, 'WHATSAPP_META_RESPONSE_INVALID');
      }
      return { providerMessageId };
    },
  };
}

function queryFailed(error, message) {
  if (error) throw whatsappError(message);
}

export function createSupabaseWhatsappRepository(supabaseAdmin) {
  if (!supabaseAdmin?.from) {
    return null;
  }
  return {
    async findActiveChannelByPhoneNumberId(phoneNumberId) {
      const { data, error } = await supabaseAdmin
        .from('whatsapp_tenant_channels')
        .select('id, tenant_id, meta_phone_number_id, credential_ref, auto_reply_text, active, whatsapp_tenants!inner(status)')
        .eq('meta_phone_number_id', phoneNumberId)
        .eq('active', true)
        .eq('whatsapp_tenants.status', 'active')
        .maybeSingle();
      queryFailed(error, 'No se pudo resolver el canal de WhatsApp.');
      return data || null;
    },

    async recordInbound({ channel, inbound }) {
      const row = {
        tenant_id: channel.tenant_id,
        channel_id: channel.id,
        provider_message_id: inbound.providerMessageId,
        from_wa_id: inbound.fromWaId,
        message_type: inbound.messageType,
        text_body: inbound.textBody,
        received_at: inbound.receivedAt,
      };
      const inserted = await supabaseAdmin
        .from('whatsapp_inbound_messages')
        .insert(row)
        .select('id, tenant_id, channel_id, provider_message_id, from_wa_id, received_at')
        .single();
      if (!inserted.error) return { row: inserted.data, created: true };
      if (inserted.error.code !== '23505') {
        throw whatsappError('No se pudo guardar el mensaje entrante.');
      }
      const existing = await supabaseAdmin
        .from('whatsapp_inbound_messages')
        .select('id, tenant_id, channel_id, provider_message_id, from_wa_id, received_at')
        .eq('tenant_id', channel.tenant_id)
        .eq('channel_id', channel.id)
        .eq('provider_message_id', inbound.providerMessageId)
        .maybeSingle();
      queryFailed(existing.error, 'No se pudo comprobar la idempotencia del mensaje.');
      if (!existing.data) throw whatsappError('No se pudo recuperar el mensaje idempotente.');
      return { row: existing.data, created: false };
    },

    async ensureOutbox({ channel, inboundRow, body, windowExpiresAt, idempotencyKey }) {
      const row = {
        tenant_id: channel.tenant_id,
        channel_id: channel.id,
        inbound_message_id: inboundRow.id,
        idempotency_key: idempotencyKey,
        to_wa_id: inboundRow.from_wa_id,
        reply_to_provider_message_id: inboundRow.provider_message_id,
        message_type: 'text',
        text_body: body,
        customer_service_window_expires_at: windowExpiresAt,
        status: 'pending',
      };
      const inserted = await supabaseAdmin
        .from('whatsapp_outbox')
        .insert(row)
        .select('*')
        .single();
      if (!inserted.error) return { row: inserted.data, created: true };
      if (inserted.error.code !== '23505') {
        throw whatsappError('No se pudo crear la salida de WhatsApp.');
      }
      const existing = await supabaseAdmin
        .from('whatsapp_outbox')
        .select('*')
        .eq('tenant_id', channel.tenant_id)
        .eq('idempotency_key', idempotencyKey)
        .maybeSingle();
      queryFailed(existing.error, 'No se pudo comprobar la idempotencia de salida.');
      if (!existing.data) throw whatsappError('No se pudo recuperar la salida idempotente.');
      return { row: existing.data, created: false };
    },

    async claimPendingOutbox(outbox, attemptedAt) {
      const { data, error } = await supabaseAdmin
        .from('whatsapp_outbox')
        .update({
          status: 'sending',
          attempts: Number(outbox.attempts || 0) + 1,
          last_attempt_at: attemptedAt,
          last_error: null,
        })
        .eq('tenant_id', outbox.tenant_id)
        .eq('id', outbox.id)
        .eq('status', 'pending')
        .eq('attempts', Number(outbox.attempts || 0))
        .select('*')
        .maybeSingle();
      queryFailed(error, 'No se pudo reclamar la salida de WhatsApp.');
      return data || null;
    },

    async fetchPendingOutbox(readyAt, limit) {
      const { data, error } = await supabaseAdmin
        .from('whatsapp_outbox')
        .select('*')
        .eq('status', 'pending')
        .lte('next_attempt_at', readyAt)
        .order('created_at', { ascending: true })
        .limit(limit);
      queryFailed(error, 'No se pudo leer la salida pendiente de WhatsApp.');
      return data || [];
    },

    async findActiveChannelById(tenantId, channelId) {
      const { data, error } = await supabaseAdmin
        .from('whatsapp_tenant_channels')
        .select('id, tenant_id, meta_phone_number_id, credential_ref, auto_reply_text, active, whatsapp_tenants!inner(status)')
        .eq('tenant_id', tenantId)
        .eq('id', channelId)
        .eq('active', true)
        .eq('whatsapp_tenants.status', 'active')
        .maybeSingle();
      queryFailed(error, 'No se pudo resolver el canal pendiente de WhatsApp.');
      return data || null;
    },

    async markOutboxSent(outbox, providerMessageId, sentAt) {
      const { error } = await supabaseAdmin
        .from('whatsapp_outbox')
        .update({
          status: 'sent',
          provider_message_id: providerMessageId,
          sent_at: sentAt,
          last_error: null,
        })
        .eq('tenant_id', outbox.tenant_id)
        .eq('id', outbox.id)
        .eq('status', 'sending');
      queryFailed(error, 'No se pudo confirmar la salida de WhatsApp.');
    },

    async markOutboxPending(outbox, errorMessage, nextAttemptAt) {
      const { error } = await supabaseAdmin
        .from('whatsapp_outbox')
        .update({
          status: 'pending',
          next_attempt_at: nextAttemptAt,
          last_error: cleanText(errorMessage, MAX_ERROR_LENGTH) || 'send_failed',
        })
        .eq('tenant_id', outbox.tenant_id)
        .eq('id', outbox.id)
        .eq('status', 'sending');
      queryFailed(error, 'No se pudo reprogramar la salida de WhatsApp.');
    },

    async markOutboxExpired(outbox, expiredAt) {
      const { error } = await supabaseAdmin
        .from('whatsapp_outbox')
        .update({ status: 'expired', last_attempt_at: expiredAt })
        .eq('tenant_id', outbox.tenant_id)
        .eq('id', outbox.id)
        .in('status', ['pending', 'sending']);
      queryFailed(error, 'No se pudo cerrar la salida vencida.');
    },

    async markOutboxCancelled(outbox, cancelledAt, reason = null) {
      const { error } = await supabaseAdmin
        .from('whatsapp_outbox')
        .update({
          status: 'cancelled',
          last_attempt_at: cancelledAt,
          ...(reason ? { last_error: cleanText(reason, MAX_ERROR_LENGTH) } : {}),
        })
        .eq('tenant_id', outbox.tenant_id)
        .eq('id', outbox.id)
        .in('status', ['pending', 'sending']);
      queryFailed(error, 'No se pudo cancelar la salida sin canal activo.');
    },
  };
}

function idempotencyKeyFor(channel, inbound) {
  return createHash('sha256')
    .update(`${channel.tenant_id}:${channel.id}:${inbound.providerMessageId}:simple-reply-v1`)
    .digest('hex');
}

export function createWhatsappCloudService({
  repository,
  sender,
  sendEnabled = false,
  now = () => new Date(),
  retryDelayMs = 60_000,
  maxSendAttempts = Infinity,
  onSendDiagnostic = null,
} = {}) {
  if (!repository) throw whatsappError('El repositorio de WhatsApp no está configurado.');
  if (maxSendAttempts !== Infinity && (!Number.isInteger(maxSendAttempts) || maxSendAttempts < 1)) {
    throw whatsappError('El límite de intentos de WhatsApp no es válido.', 503, 'WHATSAPP_ATTEMPT_LIMIT_INVALID');
  }

  async function attemptOutbox(outbox) {
    if (!sendEnabled) return { status: 'held' };
    if (outbox.status === 'sent') return { status: 'already_sent' };
    if (outbox.status === 'sending') return { status: 'already_claimed' };
    if (outbox.status === 'cancelled' || outbox.status === 'expired') return { status: outbox.status };
    const attemptedAt = now();
    if (Number(outbox.attempts || 0) >= maxSendAttempts) {
      await repository.markOutboxCancelled(
        outbox, attemptedAt.toISOString(), 'WHATSAPP_MAX_SEND_ATTEMPTS_REACHED',
      );
      return { status: 'cancelled' };
    }
    if (new Date(outbox.customer_service_window_expires_at).getTime() <= attemptedAt.getTime()) {
      await repository.markOutboxExpired(outbox, attemptedAt.toISOString());
      return { status: 'expired' };
    }
    const nextAttemptAt = new Date(outbox.next_attempt_at).getTime();
    if (
      Number(outbox.attempts || 0) > 0
      && Number.isFinite(nextAttemptAt)
      && nextAttemptAt > attemptedAt.getTime()
    ) {
      return { status: 'retry_scheduled' };
    }
    const activeChannel = await repository.findActiveChannelById(
      outbox.tenant_id,
      outbox.channel_id,
    );
    if (!activeChannel) {
      await repository.markOutboxCancelled(outbox, attemptedAt.toISOString());
      return { status: 'cancelled' };
    }
    const claimed = await repository.claimPendingOutbox(outbox, attemptedAt.toISOString());
    if (!claimed) return { status: 'already_claimed' };
    const confirmedChannel = await repository.findActiveChannelById(
      claimed.tenant_id,
      claimed.channel_id,
    );
    if (!confirmedChannel) {
      await repository.markOutboxCancelled(claimed, now().toISOString());
      return { status: 'cancelled' };
    }
    let acknowledgementReceived = false;
    const reportPhase = phase => {
      try { Promise.resolve(onSendDiagnostic?.({ phase })).catch(() => {}); } catch { /* Diagnostics never change delivery state. */ }
    };
    try {
      reportPhase('before_transport');
      const sent = await sender.sendText({
        channel: confirmedChannel,
        toWaId: claimed.to_wa_id,
        body: claimed.text_body,
        replyToProviderMessageId: claimed.reply_to_provider_message_id,
      });
      acknowledgementReceived = true;
      await repository.markOutboxSent(claimed, sent.providerMessageId, now().toISOString());
      return { status: 'sent' };
    } catch (error) {
      if (acknowledgementReceived) reportPhase('persistence_failed');
      if (Number(claimed.attempts || 0) >= maxSendAttempts) {
        // Meta may have accepted the message even when its response or our
        // acknowledgement failed. Persist the stop; a restart must not resend.
        await repository.markOutboxCancelled(
          claimed, now().toISOString(), 'WHATSAPP_SEND_UNCERTAIN_NO_RETRY',
        );
        return { status: 'cancelled' };
      }
      const retryAt = new Date(now().getTime() + retryDelayMs).toISOString();
      await repository.markOutboxPending(claimed, error?.code || 'send_failed', retryAt);
      return { status: 'retry_pending' };
    }
  }

  return {
    async handleWebhook(payload) {
      const receivedAt = now();
      const incoming = extractWhatsappInboundMessages(payload, receivedAt);
      const results = [];
      for (const inbound of incoming) {
        const channel = await repository.findActiveChannelByPhoneNumberId(inbound.phoneNumberId);
        if (!channel?.id || !channel?.tenant_id) {
          throw whatsappError(
            'El canal firmado no está configurado.',
            503,
            'WHATSAPP_CHANNEL_NOT_CONFIGURED',
          );
        }
        const stored = await repository.recordInbound({ channel, inbound });
        const inboundReceivedAt = new Date(stored.row.received_at);
        const windowExpiresAt = new Date(
          inboundReceivedAt.getTime() + WHATSAPP_CUSTOMER_SERVICE_WINDOW_MS,
        ).toISOString();
        const outbox = await repository.ensureOutbox({
          channel,
          inboundRow: stored.row,
          body: cleanText(channel.auto_reply_text, MAX_MESSAGE_TEXT_LENGTH)
            || DEFAULT_WHATSAPP_AUTO_REPLY,
          windowExpiresAt,
          idempotencyKey: idempotencyKeyFor(channel, inbound),
        });
        const delivery = await attemptOutbox(outbox.row);
        results.push({
          created: stored.created,
          outboxCreated: outbox.created,
          delivery: delivery.status,
        });
      }
      return { received: incoming.length, results };
    },

    async processPendingOutbox({ limit = 20 } = {}) {
      if (!sendEnabled) return { held: true, processed: 0, sent: 0, pending: 0, expired: 0 };
      const boundedLimit = Math.max(1, Math.min(100, Number(limit) || 20));
      const pendingRows = await repository.fetchPendingOutbox(now().toISOString(), boundedLimit);
      const summary = { held: false, processed: 0, sent: 0, pending: 0, expired: 0, cancelled: 0 };
      for (const outbox of pendingRows) {
        const delivery = await attemptOutbox(outbox);
        summary.processed += 1;
        if (delivery.status === 'sent') summary.sent += 1;
        else if (delivery.status === 'expired') summary.expired += 1;
        else if (delivery.status === 'cancelled') summary.cancelled += 1;
        else summary.pending += 1;
      }
      return summary;
    },
  };
}

function sendRouteError(res, error, logger) {
  const status = Number(error?.status) || 503;
  logger?.error?.('[whatsapp-cloud] request failed', {
    code: error?.code || 'WHATSAPP_CLOUD_UNAVAILABLE',
  });
  return res.status(status).json({
    error: status === 401 || status === 403
      ? 'Solicitud de webhook no autorizada.'
      : 'El webhook de WhatsApp no está disponible.',
    code: error?.code || 'WHATSAPP_CLOUD_UNAVAILABLE',
  });
}

export function registerWhatsappCloudRoutes(app, {
  appSecret,
  verifyToken,
  whatsappService,
  logger = console,
} = {}) {
  app.get(WHATSAPP_CLOUD_WEBHOOK_PATH, (req, res) => {
    const verification = verifyMetaWebhookChallenge(req.query, verifyToken);
    if (!verification.ok) {
      return res.status(verification.status).json({ code: verification.code });
    }
    return res.status(200).send(verification.challenge);
  });

  app.post(WHATSAPP_CLOUD_WEBHOOK_PATH, async (req, res) => {
    if (!appSecret || !whatsappService) {
      return sendRouteError(
        res,
        whatsappError('El webhook de WhatsApp no está configurado.'),
        logger,
      );
    }
    if (!verifyMetaWebhookSignature(req.rawBody, req.headers['x-hub-signature-256'], appSecret)) {
      return sendRouteError(
        res,
        whatsappError('Firma inválida.', 401, 'WHATSAPP_SIGNATURE_INVALID'),
        logger,
      );
    }
    let payload;
    try {
      payload = JSON.parse(req.rawBody.toString('utf8'));
    } catch {
      return sendRouteError(
        res,
        whatsappError('JSON inválido.', 400, 'WHATSAPP_PAYLOAD_INVALID'),
        logger,
      );
    }
    try {
      const result = await whatsappService.handleWebhook(payload);
      return res.status(200).json({ ok: true, received: result.received, results: result.results });
    } catch (error) {
      return sendRouteError(res, error, logger);
    }
  });
}
