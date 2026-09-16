import assert from 'node:assert/strict';

import { createHmac } from 'node:crypto';

import fs from 'node:fs';

import path from 'node:path';

import test from 'node:test';

import { fileURLToPath } from 'node:url';

import {
  DEFAULT_WHATSAPP_AUTO_REPLY,
  WHATSAPP_CLOUD_WEBHOOK_PATH,
  buildWhatsappTextPayload,
  createWhatsappCloudService,
  createWhatsappMetaSender,
  createSupabaseWhatsappRepository,
  environmentWhatsappAccessTokenResolver,
  extractWhatsappInboundMessages,
  registerWhatsappCloudRoutes,
  verifyMetaWebhookChallenge,
  verifyMetaWebhookSignature,
  whatsappMaxSendAttemptsFromEnv,
} from './whatsappCloud.js';

const FIXED_NOW = new Date('2026-09-09T12:00:00.000Z');

const PHONE_NUMBER_ID = '123456789012345';

const FROM_WA_ID = '15551234567';

function webhookPayload({
  phoneNumberId = PHONE_NUMBER_ID,
  messageId = 'wamid.inbound-1',
  timestamp = Math.floor(FIXED_NOW.getTime() / 1000),
  body = 'Quiero conocer Padbol',
} = {}) {
  return {
    object: 'whatsapp_business_account',
    entry: [{
      changes: [{
        field: 'messages',
        value: {
          metadata: {
            display_phone_number: '+1 555 000 0000',
            phone_number_id: phoneNumberId,
          },
          contacts: [{ wa_id: FROM_WA_ID, profile: { name: 'Persona de prueba' } }],
          messages: [{
            from: FROM_WA_ID,
            id: messageId,
            timestamp: String(timestamp),
            type: 'text',
            text: { body },
          }],
        },
      }],
    }],
  };
}

function memoryRepository(channels = []) {
  const inbound = [];
  const outbox = [];
  return {
    inbound,
    outbox,
    async findActiveChannelByPhoneNumberId(phoneNumberId) {
      return channels.find((channel) => (
        channel.meta_phone_number_id === phoneNumberId && channel.active !== false
      )) || null;
    },
    async recordInbound({ channel, inbound: next }) {
      const existing = inbound.find((row) => (
        row.tenant_id === channel.tenant_id
        && row.provider_message_id === next.providerMessageId
      ));
      if (existing) return { row: existing, created: false };
      const row = {
        id: `in-${inbound.length + 1}`,
        tenant_id: channel.tenant_id,
        channel_id: channel.id,
        provider_message_id: next.providerMessageId,
        from_wa_id: next.fromWaId,
        received_at: next.receivedAt,
        text_body: next.textBody,
      };
      inbound.push(row);
      return { row, created: true };
    },
    async ensureOutbox({ channel, inboundRow, body, windowExpiresAt, idempotencyKey }) {
      const existing = outbox.find((row) => (
        row.tenant_id === channel.tenant_id && row.idempotency_key === idempotencyKey
      ));
      if (existing) return { row: existing, created: false };
      const row = {
        id: `out-${outbox.length + 1}`,
        tenant_id: channel.tenant_id,
        channel_id: channel.id,
        inbound_message_id: inboundRow.id,
        idempotency_key: idempotencyKey,
        to_wa_id: inboundRow.from_wa_id,
        reply_to_provider_message_id: inboundRow.provider_message_id,
        text_body: body,
        customer_service_window_expires_at: windowExpiresAt,
        attempts: 0,
        status: 'pending',
      };
      outbox.push(row);
      return { row, created: true };
    },
    async claimPendingOutbox(row, attemptedAt) {
      if (row.status !== 'pending') return null;
      row.status = 'sending';
      row.attempts += 1;
      row.last_attempt_at = attemptedAt;
      return row;
    },
    async fetchPendingOutbox(readyAt, limit) {
      return outbox
        .filter((row) => row.status === 'pending' && new Date(row.next_attempt_at).getTime() <= new Date(readyAt).getTime())
        .slice(0, limit);
    },
    async findActiveChannelById(tenantId, channelId) {
      return channels.find((channel) => (
        channel.tenant_id === tenantId && channel.id === channelId && channel.active !== false
      )) || null;
    },
    async markOutboxSent(row, providerMessageId, sentAt) {
      row.status = 'sent';
      row.provider_message_id = providerMessageId;
      row.sent_at = sentAt;
      row.last_error = null;
    },
    async markOutboxPending(row, errorMessage, nextAttemptAt) {
      row.status = 'pending';
      row.last_error = errorMessage;
      row.next_attempt_at = nextAttemptAt;
    },
    async markOutboxExpired(row, expiredAt) {
      row.status = 'expired';
      row.last_attempt_at = expiredAt;
    },
    async markOutboxCancelled(row, cancelledAt, reason) {
      if (row.status === 'pending' || row.status === 'sending') {
        row.status = 'cancelled';
        row.last_attempt_at = cancelledAt;
        if (reason) row.last_error = reason;
      }
    },
  };
}

function activeChannel(overrides = {}) {
  return {
    id: 'channel-a',
    tenant_id: 'tenant-a',
    meta_phone_number_id: PHONE_NUMBER_ID,
    credential_ref: 'TEST',
    auto_reply_text: DEFAULT_WHATSAPP_AUTO_REPLY,
    active: true,
    ...overrides,
  };
}

function fakeApp() {
  const routes = { get: new Map(), post: new Map() };
  return {
    routes,
    get(route, handler) { routes.get.set(route, handler); },
    post(route, handler) { routes.post.set(route, handler); },
  };
}

function fakeResponse() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; },
    send(value) { this.body = value; return this; },
  };
}

test('valida challenge con token separado y comparación segura', () => {
  assert.deepEqual(
    verifyMetaWebhookChallenge({
      'hub.mode': 'subscribe',
      'hub.verify_token': 'verify-local',
      'hub.challenge': 'challenge-123',
    }, 'verify-local'),
    { ok: true, status: 200, challenge: 'challenge-123' },
  );
  assert.equal(verifyMetaWebhookChallenge({
    'hub.mode': 'subscribe',
    'hub.verify_token': 'incorrecto',
  }, 'verify-local').status, 403);
  assert.equal(verifyMetaWebhookChallenge({}, '').status, 503);
});

test('valida X-Hub-Signature-256 sobre los bytes crudos exactos', () => {
  const rawBody = Buffer.from(JSON.stringify(webhookPayload()));
  const digest = createHmac('sha256', 'app-secret-local').update(rawBody).digest('hex');
  assert.equal(
    verifyMetaWebhookSignature(rawBody, `sha256=${digest}`, 'app-secret-local'),
    true,
  );
  assert.equal(
    verifyMetaWebhookSignature(Buffer.concat([rawBody, Buffer.from(' ')]), `sha256=${digest}`, 'app-secret-local'),
    false,
  );
  assert.equal(verifyMetaWebhookSignature(rawBody, 'firma-arbitraria', 'app-secret-local'), false);
});

test('el tenant sólo puede derivarse de metadata.phone_number_id', () => {
  const payload = webhookPayload();
  payload.tenant_id = 'tenant-atacante';
  payload.entry[0].changes[0].value.metadata.display_phone_number = PHONE_NUMBER_ID;
  const [message] = extractWhatsappInboundMessages(payload, FIXED_NOW);
  assert.equal(message.phoneNumberId, PHONE_NUMBER_ID);
  assert.equal(Object.hasOwn(message, 'tenantId'), false);
  assert.equal(Object.hasOwn(message, 'providerPayload'), false);
});

test('el Hito 1 ignora mensajes no textuales sin persistir ni responder', async () => {
  const repository = memoryRepository([activeChannel()]);
  const payload = webhookPayload();
  payload.entry[0].changes[0].value.messages[0] = {
    from: FROM_WA_ID,
    id: 'wamid.image-1',
    timestamp: String(Math.floor(FIXED_NOW.getTime() / 1000)),
    type: 'image',
    image: { id: 'media-id-no-persistido' },
  };
  const service = createWhatsappCloudService({
    repository,
    sender: { async sendText() { throw new Error('no debe enviar'); } },
    sendEnabled: true,
    now: () => new Date(FIXED_NOW),
  });
  const result = await service.handleWebhook(payload);
  assert.deepEqual(result, { received: 0, results: [] });
  assert.equal(repository.inbound.length, 0);
  assert.equal(repository.outbox.length, 0);
});

test('con envío apagado persiste por tenant y deja una sola salida pendiente', async () => {
  const repository = memoryRepository([activeChannel()]);
  let networkCalls = 0;
  const service = createWhatsappCloudService({
    repository,
    sender: { async sendText() { networkCalls += 1; } },
    now: () => new Date(FIXED_NOW),
  });
  const first = await service.handleWebhook(webhookPayload());
  const duplicate = await service.handleWebhook(webhookPayload());

  assert.equal(first.results[0].delivery, 'held');
  assert.equal(duplicate.results[0].created, false);
  assert.equal(repository.inbound.length, 1);
  assert.equal(repository.outbox.length, 1);
  assert.equal(repository.inbound[0].tenant_id, 'tenant-a');
  assert.equal(repository.outbox[0].tenant_id, 'tenant-a');
  assert.equal(repository.outbox[0].status, 'pending');
  assert.equal(networkCalls, 0);
});

test('el embudo define el cuerpo pending sin habilitar transporte', async () => {
  const repository = memoryRepository([activeChannel()]);
  let received = null;
  const service = createWhatsappCloudService({
    repository, sendEnabled: false, now: () => new Date(FIXED_NOW),
    onInbound: async ({ inbound }) => {
      received = inbound;
      return { response: 'Pregunta guiada configurable' };
    },
  });
  const result = await service.handleWebhook(webhookPayload());
  assert.equal(received.providerMessageId, 'wamid.inbound-1');
  assert.equal(repository.outbox[0].text_body, 'Pregunta guiada configurable');
  assert.equal(repository.outbox[0].status, 'pending');
  assert.equal(result.results[0].delivery, 'held');
});

test('canal desconocido falla cerrado y no persiste contenido', async () => {
  const repository = memoryRepository([]);
  const service = createWhatsappCloudService({
    repository,
    sender: { async sendText() { throw new Error('no debe enviar'); } },
    now: () => new Date(FIXED_NOW),
  });
  await assert.rejects(
    service.handleWebhook(webhookPayload()),
    (error) => error.code === 'WHATSAPP_CHANNEL_NOT_CONFIGURED' && error.status === 503,
  );
  assert.equal(repository.inbound.length, 0);
  assert.equal(repository.outbox.length, 0);
});

test('envía texto por Graph API una vez y conserva idempotencia al reintentar webhook', async () => {
  const repository = memoryRepository([activeChannel()]);
  const calls = [];
  const sender = createWhatsappMetaSender({
    graphVersion: 'v23.0',
    resolveAccessToken: environmentWhatsappAccessTokenResolver({
      WHATSAPP_META_TOKEN_TEST: 'token-solo-prueba',
    }),
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return {
        ok: true,
        status: 200,
        json: async () => ({ messages: [{ id: 'wamid.outbound-1' }] }),
      };
    },
  });
  const service = createWhatsappCloudService({
    repository,
    sender,
    sendEnabled: true,
    now: () => new Date(FIXED_NOW),
  });
  const first = await service.handleWebhook(webhookPayload());
  const duplicate = await service.handleWebhook(webhookPayload());

  assert.equal(first.results[0].delivery, 'sent');
  assert.equal(duplicate.results[0].delivery, 'already_sent');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `https://graph.facebook.com/v23.0/${PHONE_NUMBER_ID}/messages`);
  assert.equal(calls[0].options.headers.Authorization, 'Bearer token-solo-prueba');
  assert.deepEqual(JSON.parse(calls[0].options.body), buildWhatsappTextPayload({
    toWaId: FROM_WA_ID,
    body: DEFAULT_WHATSAPP_AUTO_REPLY,
    replyToProviderMessageId: 'wamid.inbound-1',
  }));
  assert.equal(repository.outbox[0].status, 'sent');
});

test('un error Meta queda en outbox para reintento y no duplica el mensaje entrante', async () => {
  const repository = memoryRepository([activeChannel()]);
  let sendCalls = 0;
  let currentNow = new Date(FIXED_NOW);
  const service = createWhatsappCloudService({
    repository,
    sender: {
      async sendText() {
        sendCalls += 1;
        if (sendCalls === 1) throw new Error('transport error');
        return { providerMessageId: 'wamid.outbound-retry' };
      },
    },
    sendEnabled: true,
    now: () => new Date(currentNow),
  });
  const result = await service.handleWebhook(webhookPayload());
  assert.equal(result.results[0].delivery, 'retry_pending');
  assert.equal(repository.inbound.length, 1);
  assert.equal(repository.outbox[0].status, 'pending');
  assert.equal(repository.outbox[0].attempts, 1);
  assert.equal(repository.outbox[0].last_error, 'send_failed');
  const duplicate = await service.handleWebhook(webhookPayload());
  assert.equal(duplicate.results[0].delivery, 'retry_scheduled');
  assert.equal(sendCalls, 1);
  currentNow = new Date(FIXED_NOW.getTime() + 61_000);
  const sweep = await service.processPendingOutbox();
  assert.equal(sweep.sent, 1);
  assert.equal(repository.outbox[0].status, 'sent');
  assert.equal(sendCalls, 2);
});

test('sandbox detiene un envío incierto después de un intento, incluso tras replay y reinicio', async () => {
  const repository = memoryRepository([activeChannel()]);
  let calls = 0;
  const options = {
    repository,
    sender: { async sendText() { calls += 1; throw new Error('timeout privado'); } },
    sendEnabled: true,
    maxSendAttempts: 1,
    now: () => new Date(FIXED_NOW),
  };
  const first = await createWhatsappCloudService(options).handleWebhook(webhookPayload());
  assert.equal(first.results[0].delivery, 'cancelled');
  assert.equal(repository.outbox[0].attempts, 1);
  assert.equal(repository.outbox[0].last_error, 'WHATSAPP_SEND_UNCERTAIN_NO_RETRY');
  const restarted = createWhatsappCloudService({
    ...options, now: () => new Date(FIXED_NOW.getTime() + 120_000),
  });
  assert.equal((await restarted.handleWebhook(webhookPayload())).results[0].delivery, 'cancelled');
  assert.equal((await restarted.processPendingOutbox()).processed, 0);
  assert.equal(calls, 1);
  assert.equal(repository.inbound.length, 1);
  assert.equal(repository.outbox.length, 1);
});

test('si Meta aceptó pero falla guardar sent, sandbox no vuelve a llamar al proveedor', async () => {
  const repository = memoryRepository([activeChannel()]);
  repository.markOutboxSent = async () => { throw new Error('database unavailable'); };
  let calls = 0;
  const service = createWhatsappCloudService({
    repository,
    sender: { async sendText() { calls += 1; return { providerMessageId: 'wamid.accepted' }; } },
    sendEnabled: true,
    maxSendAttempts: 1,
    now: () => new Date(FIXED_NOW),
  });
  await service.handleWebhook(webhookPayload());
  await service.handleWebhook(webhookPayload());
  assert.equal(calls, 1);
  assert.equal(repository.outbox[0].status, 'cancelled');
  assert.equal(repository.outbox[0].last_error, 'WHATSAPP_SEND_UNCERTAIN_NO_RETRY');
});

test('límite de sandbox cancela una salida pendiente antigua que ya consumió su intento', async () => {
  const repository = memoryRepository([activeChannel()]);
  const held = createWhatsappCloudService({ repository, now: () => new Date(FIXED_NOW) });
  await held.handleWebhook(webhookPayload());
  repository.outbox[0].attempts = 1;
  repository.outbox[0].next_attempt_at = FIXED_NOW.toISOString();
  let calls = 0;
  const service = createWhatsappCloudService({
    repository, sender: { async sendText() { calls += 1; } },
    sendEnabled: true, maxSendAttempts: 1, now: () => new Date(FIXED_NOW),
  });
  assert.equal((await service.processPendingOutbox()).cancelled, 1);
  assert.equal(repository.outbox[0].last_error, 'WHATSAPP_MAX_SEND_ATTEMPTS_REACHED');
  assert.equal(calls, 0);
});

test('el claim persistido rechaza una copia atrasada después de otro intento', async () => {
  const current = { id: 'out-1', tenant_id: 'tenant-a', status: 'pending', attempts: 1 };
  const repository = createSupabaseWhatsappRepository({
    from(table) {
      assert.equal(table, 'whatsapp_outbox');
      let patch;
      const filters = [];
      return {
        update(value) { patch = value; return this; },
        eq(key, value) { filters.push([key, value]); return this; },
        select() { return this; },
        async maybeSingle() {
          if (!filters.every(([key, value]) => current[key] === value)) return { data: null };
          Object.assign(current, patch);
          return { data: { ...current } };
        },
      };
    },
  });
  assert.equal(await repository.claimPendingOutbox({ ...current, attempts: 0 }, FIXED_NOW.toISOString()), null);
  assert.equal(current.attempts, 1);
  const claimed = await repository.claimPendingOutbox({ ...current }, FIXED_NOW.toISOString());
  assert.equal(claimed.attempts, 2);
});

test('no envía una respuesta fuera de la ventana de servicio de 24 horas', async () => {
  const repository = memoryRepository([activeChannel()]);
  let networkCalls = 0;
  const service = createWhatsappCloudService({
    repository,
    sender: { async sendText() { networkCalls += 1; } },
    sendEnabled: true,
    now: () => new Date(FIXED_NOW),
  });
  const oldTimestamp = Math.floor(
    new Date('2026-09-08T11:59:59.000Z').getTime() / 1000,
  );
  const result = await service.handleWebhook(webhookPayload({ timestamp: oldTimestamp }));
  assert.equal(result.results[0].delivery, 'expired');
  assert.equal(repository.outbox[0].status, 'expired');
  assert.equal(networkCalls, 0);
});

test('las rutas verifican firma antes de invocar persistencia y no filtran payload', async () => {
  const app = fakeApp();
  let serviceCalls = 0;
  let receivedPayload = null;
  const errors = [];
  registerWhatsappCloudRoutes(app, {
    appSecret: 'app-secret-local',
    verifyToken: 'verify-local',
    whatsappService: {
      async handleWebhook(payload) {
        serviceCalls += 1;
        receivedPayload = payload;
        return { received: 1, results: [{ delivery: 'held' }] };
      },
    },
    logger: { error(message, details) { errors.push({ message, details }); } },
  });

  const response = fakeResponse();
  await app.routes.post.get(WHATSAPP_CLOUD_WEBHOOK_PATH)({
    rawBody: Buffer.from('{}'),
    headers: { 'x-hub-signature-256': 'sha256='.padEnd(71, '0') },
    body: { private: 'no debe llegar' },
  }, response);
  assert.equal(response.statusCode, 401);
  assert.equal(serviceCalls, 0);
  assert.deepEqual(errors[0].details, { code: 'WHATSAPP_SIGNATURE_INVALID' });
  assert.equal(JSON.stringify(errors).includes('private'), false);

  const rawBody = Buffer.from(JSON.stringify(webhookPayload()));
  const signature = createHmac('sha256', 'app-secret-local').update(rawBody).digest('hex');
  const validResponse = fakeResponse();
  await app.routes.post.get(WHATSAPP_CLOUD_WEBHOOK_PATH)({
    rawBody,
    headers: { 'x-hub-signature-256': `sha256=${signature}` },
  }, validResponse);
  assert.equal(validResponse.statusCode, 200);
  assert.equal(serviceCalls, 1);
  assert.equal(receivedPayload.object, 'whatsapp_business_account');

  const invalidJson = Buffer.from('{');
  const invalidJsonSignature = createHmac('sha256', 'app-secret-local')
    .update(invalidJson)
    .digest('hex');
  const invalidJsonResponse = fakeResponse();
  await app.routes.post.get(WHATSAPP_CLOUD_WEBHOOK_PATH)({
    rawBody: invalidJson,
    headers: { 'x-hub-signature-256': `sha256=${invalidJsonSignature}` },
  }, invalidJsonResponse);
  assert.equal(invalidJsonResponse.statusCode, 400);
  assert.equal(invalidJsonResponse.body.code, 'WHATSAPP_PAYLOAD_INVALID');
  assert.equal(serviceCalls, 1);

  const getResponse = fakeResponse();
  app.routes.get.get(WHATSAPP_CLOUD_WEBHOOK_PATH)({
    query: {
      'hub.mode': 'subscribe',
      'hub.verify_token': 'verify-local',
      'hub.challenge': 'challenge-abc',
    },
  }, getResponse);
  assert.equal(getResponse.statusCode, 200);
  assert.equal(getResponse.body, 'challenge-abc');
});
