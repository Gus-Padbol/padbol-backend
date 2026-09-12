import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import { createWhatsappQaSandboxServiceFactory } from './whatsappQaSandboxSend.js';
import { registerWhatsappCloudRoutes, WHATSAPP_CLOUD_WEBHOOK_PATH } from './whatsappCloud.js';
import { backendRuntime, installStagingFetchGuard, externalOperationsGate } from './backendRuntime.js';

const NOW = new Date('2026-09-10T20:00:00.000Z');
const REPLY = 'Prueba técnica de Padbol Match recibida correctamente.';
const URL = 'https://graph.facebook.com/v26.0/1300908966439481/messages';
const channel = () => ({ id: '81bba438-eb65-4f70-bdf9-32f6c113d5bf',
  tenant_id: '3a2e5306-e1fc-4b24-b03b-fe965fc37e97', meta_phone_number_id: '1300908966439481',
  meta_waba_id: '1384040043841797', credential_ref: 'TEST', auto_reply_text: REPLY, active: true,
  whatsapp_tenants: { status: 'active', organization_id: '067d7269-27e3-4aaf-9da4-c80ba56e1d2a' } });
const environment = () => ({
  WHATSAPP_QA_SANDBOX_SEND_ENABLED: 'true', BACKEND_RUNTIME_MODE: 'staging',
  STAGING_SUPABASE_PROJECT_REF: 'vxikhdulhuvghfqeutnp',
  SUPABASE_URL: 'https://vxikhdulhuvghfqeutnp.supabase.co',
  RENDER_SERVICE_ID: 'srv-dahbs0dbedkc73a0kf4g', RENDER_EXTERNAL_URL: 'https://padbol-backend-qa.onrender.com',
  WHATSAPP_META_GRAPH_VERSION: 'v26.0', WHATSAPP_CLOUD_SEND_ENABLED: 'true',
  WHATSAPP_CLOUD_MAX_SEND_ATTEMPTS: '1', OUTBOUND_DELIVERY_ENABLED: 'false',
  BACKGROUND_JOBS_ENABLED: 'false', PUSH_SEND_ENABLED: 'false',
  WHATSAPP_META_TOKEN_TEST: 'fake-test-token-do-not-log', WHATSAPP_META_APP_SECRET: 'fake-secret',
  WHATSAPP_META_VERIFY_TOKEN: 'fake-verify',
});
const payload = (overrides = {}) => ({ object: 'whatsapp_business_account', entry: [{ id: '1384040043841797',
  changes: [{ field: 'messages', value: { metadata: { phone_number_id: '1300908966439481' },
    messages: [{ id: 'wamid.fixture-inbound', from: '15551234567', type: 'text',
      text: { body: 'Texto de prueba sintético' }, timestamp: String(NOW.getTime() / 1000), ...overrides }] } }] }] });
const okResponse = () => ({ ok: true, status: 200, redirected: false, url: URL,
  json: async () => ({ messages: [{ id: 'wamid.fixture-accepted' }] }) });

// Minimal database adapter for the real repository's inserts, unique conflicts
// and conditional claims. No runtime service, credentials or network is loaded.
function database(channelOverrides = {}) {
  const tables = { whatsapp_tenant_channels: [{ ...channel(), ...channelOverrides }],
    whatsapp_inbound_messages: [], whatsapp_outbox: [] };
  let inserts = 0;
  const api = { tables, get inserts() { return inserts; }, from(table) {
    const rows = tables[table];
    assert(rows, `unexpected table ${table}`);
    let action = 'select', value;
    const filters = [];
    const q = {
      select() { return q; },
      eq(key, v) { filters.push(row => key.split('.').reduce((a, b) => a?.[b], row) === v); return q; },
      in(key, vals) { filters.push(row => vals.includes(row[key])); return q; },
      insert(v) { action = 'insert'; value = v; return q; },
      update(v) { action = 'update'; value = v; return q; },
      single: async () => execute(), maybeSingle: async () => execute(),
      then(resolve, reject) { return Promise.resolve(execute()).then(resolve, reject); },
    };
    const execute = () => {
      if (action === 'insert') {
        const duplicate = rows.find(row => row.tenant_id === value.tenant_id &&
          (table === 'whatsapp_inbound_messages' ? row.provider_message_id === value.provider_message_id
            : row.idempotency_key === value.idempotency_key));
        if (duplicate) return { data: null, error: { code: '23505' } };
        const row = { id: `${table}-${rows.length + 1}`, attempts: 0,
          next_attempt_at: NOW.toISOString(), ...value };
        rows.push(row); inserts += 1;
        return { data: structuredClone(row), error: null };
      }
      const matched = rows.filter(row => filters.every(fn => fn(row)));
      if (action === 'update' && value.status === 'sending') api.beforeClaim?.(matched[0]);
      if (action === 'update') matched.forEach(row => Object.assign(row, value));
      return { data: matched[0] ? structuredClone(matched[0]) : null, error: null };
    };
    return q;
  } };
  return api;
}
function harness({ env = environment(), db = database(), fetchImpl = async () => okResponse() } = {}) {
  const calls = [];
  const factory = createWhatsappQaSandboxServiceFactory({ env, now: () => NOW,
    fetchImpl: async (...args) => { calls.push(args); return fetchImpl(...args); } });
  return { service: factory?.({ supabaseAdmin: db }), calls, db, env };
}

test('sandbox opt-in is exact and rejects every incompatible runtime or gate before I/O', () => {
  for (const flag of [undefined, '', 'TRUE', '1', 'false']) {
    assert.equal(createWhatsappQaSandboxServiceFactory({ env: { ...environment(), WHATSAPP_QA_SANDBOX_SEND_ENABLED: flag } }), null);
  }
  const invalid = {
    BACKEND_RUNTIME_MODE: 'standard', STAGING_SUPABASE_PROJECT_REF: 'production',
    SUPABASE_URL: 'https://production.supabase.co', RENDER_SERVICE_ID: 'another-service',
    RENDER_EXTERNAL_URL: 'https://another.example', WHATSAPP_META_GRAPH_VERSION: 'v27.0',
    WHATSAPP_CLOUD_SEND_ENABLED: 'false', WHATSAPP_CLOUD_MAX_SEND_ATTEMPTS: '2',
    OUTBOUND_DELIVERY_ENABLED: 'true', BACKGROUND_JOBS_ENABLED: 'true', PUSH_SEND_ENABLED: 'true',
    WHATSAPP_META_TOKEN_TEST: '', WHATSAPP_META_APP_SECRET: '', WHATSAPP_META_VERIFY_TOKEN: '',
  };
  for (const [key, value] of Object.entries(invalid)) {
    let calls = 0;
    assert.throws(() => createWhatsappQaSandboxServiceFactory({ env: { ...environment(), [key]: value },
      fetchImpl: () => { calls += 1; } }), { code: 'WHATSAPP_QA_SANDBOX_CONFIGURATION_INVALID' }, key);
    assert.equal(calls, 0);
  }
});

test('valid signed webhook sends only the fixed endpoint and reply to its persisted inbound once', async () => {
  const h = harness();
  const routes = new Map();
  registerWhatsappCloudRoutes({ get() {}, post(path, handler) { routes.set(path, handler); } }, {
    whatsappService: h.service, appSecret: h.env.WHATSAPP_META_APP_SECRET, verifyToken: h.env.WHATSAPP_META_VERIFY_TOKEN,
    logger: { error() {} },
  });
  const rawBody = Buffer.from(JSON.stringify(payload()));
  const request = { rawBody, headers: { 'x-hub-signature-256': `sha256=${createHmac('sha256', h.env.WHATSAPP_META_APP_SECRET).update(rawBody).digest('hex')}` } };
  const response = () => ({ status(n) { this.statusCode = n; return this; }, json(body) { this.body = body; return this; } });
  const first = response();
  await routes.get(WHATSAPP_CLOUD_WEBHOOK_PATH)(request, first);
  assert.equal(first.statusCode, 200);
  assert.equal(first.body.results[0].delivery, 'sent');
  const second = response();
  await routes.get(WHATSAPP_CLOUD_WEBHOOK_PATH)(request, second);
  assert.equal(second.body.results[0].delivery, 'already_sent');
  assert.equal(h.calls.length, 1);
  const [url, options] = h.calls[0];
  assert.equal(url, URL);
  assert.equal(options.method, 'POST');
  assert.equal(options.redirect, 'error');
  assert.deepEqual(JSON.parse(options.body), { messaging_product: 'whatsapp', recipient_type: 'individual',
    to: '54221156280711', context: { message_id: 'wamid.fixture-inbound' }, type: 'text',
    text: { preview_url: false, body: REPLY } });
  assert.equal(h.db.tables.whatsapp_inbound_messages.length, 1);
  assert.equal(h.db.tables.whatsapp_outbox.length, 1);
  assert.equal(h.db.tables.whatsapp_outbox[0].attempts, 1);
  assert.deepEqual(Object.keys(h.service), ['handleWebhook']);
  assert(!JSON.stringify(first.body).includes('15551234567'));
  assert(!JSON.stringify(first.body).includes(REPLY));
});

test('sandbox dirige el `to` al destinatario autorizado por Meta aunque el webhook venga de otro número', async () => {
  const h = harness();
  const p = payload();
  p.entry[0].changes[0].value.messages[0].from = '5492216280711';
  const result = await h.service.handleWebhook(p);
  assert.equal(result.results[0].delivery, 'sent');
  assert.equal(h.calls.length, 1);
  const [, options] = h.calls[0];
  const body = JSON.parse(options.body);
  assert.equal(body.to, '54221156280711');
  assert.notEqual(body.to, '5492216280711');
  assert.equal(body.text.body, REPLY);
  // los registros entrantes y la outbox no se alteran: solo cambia el `to` del transporte
  assert.equal(h.db.tables.whatsapp_inbound_messages[0].from_wa_id, '5492216280711');
  assert.equal(h.db.tables.whatsapp_outbox[0].to_wa_id, '5492216280711');
});

test('invalid signature and unrelated WABA or Phone ID cannot persist or send', async () => {
  const h = harness();
  let route;
  registerWhatsappCloudRoutes({ get() {}, post(_path, fn) { route = fn; } }, {
    whatsappService: h.service, appSecret: h.env.WHATSAPP_META_APP_SECRET, logger: { error() {} },
  });
  const res = { status(n) { this.statusCode = n; return this; }, json() { return this; } };
  await route({ rawBody: Buffer.from(JSON.stringify(payload())), headers: {} }, res);
  assert.equal(res.statusCode, 401);
  for (const kind of ['waba', 'phone']) {
    const body = payload();
    if (kind === 'waba') body.entry[0].id = 'another-waba';
    else body.entry[0].changes[0].value.metadata.phone_number_id = 'another-phone';
    await assert.rejects(h.service.handleWebhook(body), { code: 'WHATSAPP_QA_SANDBOX_SCOPE_REQUIRED' });
  }
  assert.equal(h.db.inserts, 0);
  assert.equal(h.calls.length, 0);
});

test('foreign tenant, channel, phone, WABA, credential, organization, inactive channel and altered reply fail closed', async () => {
  for (const overrides of [{ id: 'other' }, { tenant_id: 'other' }, { meta_phone_number_id: '999999999' },
    { meta_waba_id: '999999999' }, { credential_ref: 'PRODUCTION' }, { auto_reply_text: 'Arbitrary text' },
    { active: false }, { whatsapp_tenants: { ...channel().whatsapp_tenants, status: 'paused' } },
    { whatsapp_tenants: { ...channel().whatsapp_tenants, organization_id: 'other' } }]) {
    const h = harness({ db: database(overrides) });
    await assert.rejects(h.service.handleWebhook(payload()), { code: 'WHATSAPP_CHANNEL_NOT_CONFIGURED' });
    assert.equal(h.db.inserts, 0);
    assert.equal(h.calls.length, 0);
  }
});

test('redirects, provider errors and uncertain replies consume one attempt without retries or leaking payload', async () => {
  for (const provider of [async () => { throw new Error('fake-test-token-do-not-log'); },
    async () => ({ ...okResponse(), status: 302 }),
    async () => ({ ...okResponse(), redirected: true }),
    async () => ({ ...okResponse(), url: 'https://attacker.example/messages' }),
    async () => ({ ...okResponse(), url: 'https://graph.facebook.com/v26.0/another/messages' }),
    async () => ({ ...okResponse(), ok: false, status: 400 }),
    async () => ({ ...okResponse(), json: async () => ({ secret: 'fake-test-token-do-not-log' }) })]) {
    const h = harness({ fetchImpl: provider });
    const first = await h.service.handleWebhook(payload());
    const second = await h.service.handleWebhook(payload());
    const restarted = harness({ db: h.db, fetchImpl: provider });
    await restarted.service.handleWebhook(payload());
    assert.equal(first.results[0].delivery, 'cancelled');
    assert.equal(second.results[0].delivery, 'cancelled');
    assert.equal(h.calls.length, 1);
    assert.equal(restarted.calls.length, 0);
    assert.equal(h.db.tables.whatsapp_outbox[0].last_error, 'WHATSAPP_SEND_UNCERTAIN_NO_RETRY');
  }
});

test('concurrent webhook replays claim the same outbox only once', async () => {
  const h = harness();
  await Promise.all([h.service.handleWebhook(payload()), h.service.handleWebhook(payload())]);
  assert.equal(h.calls.length, 1);
  assert.equal(h.db.tables.whatsapp_inbound_messages.length, 1);
  assert.equal(h.db.tables.whatsapp_outbox.length, 1);
});

test('claimed recipient, reply binding, text or invalid expiry cannot escape the persisted inbound permit', async () => {
  for (const change of [
    { to_wa_id: '15559999999' }, { inbound_message_id: 'other-inbound' },
    { reply_to_provider_message_id: 'wamid.other' }, { text_body: 'Unapproved reply' },
    { customer_service_window_expires_at: 'not-a-timestamp' },
  ]) {
    const h = harness();
    h.db.beforeClaim = row => Object.assign(row, change);
    if (change.customer_service_window_expires_at) {
      const result = await h.service.handleWebhook(payload());
      assert.equal(result.results[0].delivery, 'cancelled');
    } else {
      await assert.rejects(h.service.handleWebhook(payload()), { code: 'WHATSAPP_QA_SANDBOX_SCOPE_REQUIRED' });
    }
    assert.equal(h.calls.length, 0);
  }
});

test('old inbound and non-text events never send', async () => {
  const old = harness();
  const result = await old.service.handleWebhook(payload({ timestamp: String(NOW.getTime() / 1000 - 86401) }));
  assert.equal(result.results[0].delivery, 'expired');
  assert.equal(old.calls.length, 0);
  const nonText = harness();
  assert.equal((await nonText.service.handleWebhook(payload({ type: 'image' }))).received, 0);
  assert.equal(nonText.db.inserts, 0);
});

test('staging global fetch, payment route gate, background and push remain closed during sandbox send', async () => {
  const env = environment();
  const calls = [];
  const target = { fetch: async (...args) => { calls.push(args); return okResponse(); } };
  const factory = createWhatsappQaSandboxServiceFactory({ env, fetchImpl: target.fetch, now: () => NOW });
  installStagingFetchGuard(env, target);
  await assert.rejects(target.fetch(URL, { method: 'POST' }), { code: 'OUTBOUND_DISABLED' });
  await assert.rejects(target.fetch('https://api.mercadopago.com/checkout/preferences'), { code: 'OUTBOUND_DISABLED' });
  const runtime = backendRuntime(env);
  assert.equal(runtime.outboundDeliveryEnabled, false);
  assert.equal(runtime.backgroundJobsEnabled, false);
  assert.equal(runtime.pushSendEnabled, false);
  let persisted = false;
  const res = { status(n) { this.statusCode = n; return this; }, json(body) { this.body = body; return this; } };
  externalOperationsGate(runtime)({}, res, () => { persisted = true; });
  assert.equal(res.statusCode, 503);
  assert.equal(persisted, false);
  const service = factory({ supabaseAdmin: database() });
  await service.handleWebhook(payload());
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], URL);
  await assert.rejects(target.fetch(URL, { method: 'POST' }), { code: 'OUTBOUND_DISABLED' });
});

test('actual release mount reports scoped readiness and serves the signed webhook with all global gates false', async () => {
  const { mountReleaseRoutes } = await import('./releaseServices.js');
  const env = environment();
  const db = database();
  db.rpc = async name => {
    assert.equal(name, 'match_backend_release_readiness');
    return { data: { release: '2026-09-09.1', ready: true }, error: null };
  };
  const calls = [];
  const factory = createWhatsappQaSandboxServiceFactory({ env, now: () => NOW,
    fetchImpl: async (...args) => { calls.push(args); return okResponse(); } });
  const routes = new Map();
  const app = { use() {} };
  for (const method of ['get', 'post', 'patch', 'put', 'delete']) {
    app[method] = (path, ...handlers) => routes.set(`${method} ${path}`, handlers.at(-1));
  }
  const previousSecret = process.env.WHATSAPP_META_APP_SECRET;
  process.env.WHATSAPP_META_APP_SECRET = env.WHATSAPP_META_APP_SECRET;
  try {
    const runtime = backendRuntime(env);
    let scheduled = 0;
    mountReleaseRoutes(app, { supabaseAdmin: db, serviceRoleConfigured: true, runtime,
      getAuthenticatedUser: async () => ({ user: null }), pgPool: { query: async () => ({ rows: [{ ok: 1 }] }) },
      cron: { schedule() { if (runtime.backgroundJobsEnabled) scheduled += 1; } },
      whatsappQaSandboxServiceFactory: factory });
    const response = () => ({ statusCode: 200, status(n) { this.statusCode = n; return this; },
      json(body) { this.body = body; return this; } });
    const ready = response();
    await routes.get('get /ready')({}, ready);
    assert.equal(ready.statusCode, 200);
    assert.equal(ready.body.whatsappQaSandboxSendEnabled, true);
    assert.equal(ready.body.outboundDeliveryEnabled, false);
    assert.equal(ready.body.backgroundJobsEnabled, false);
    assert.equal(ready.body.pushSendEnabled, false);
    assert.equal(scheduled, 0);
    const rawBody = Buffer.from(JSON.stringify(payload()));
    const signature = createHmac('sha256', env.WHATSAPP_META_APP_SECRET).update(rawBody).digest('hex');
    const res = response();
    await routes.get(`post ${WHATSAPP_CLOUD_WEBHOOK_PATH}`)({ rawBody, headers: { 'x-hub-signature-256': `sha256=${signature}` } }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.results[0].delivery, 'sent');
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], URL);
  } finally {
    if (previousSecret === undefined) delete process.env.WHATSAPP_META_APP_SECRET;
    else process.env.WHATSAPP_META_APP_SECRET = previousSecret;
  }
});
