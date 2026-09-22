import { pathToFileURL } from 'node:url';

export const EXPECTED = Object.freeze({
  origin: 'https://padbol-backend-qa.onrender.com',
  graphVersion: 'v26.0', appId: '2178656636869198',
  wabaId: '1044713588190882', phoneNumberId: '1376102838911694',
  credentialRef: 'TEST',
  callbackUrl: 'https://padbol-backend-qa.onrender.com/api/webhooks/whatsapp-cloud',
});
const configured = (value) => typeof value === 'string' && Boolean(value.trim());
const safeCode = (value) => Number.isInteger(value) ? value : null;

// Values are never returned. Run only where approved secrets are already in env.
export function configurationSummary(env = process.env) {
  const missing = ['WHATSAPP_META_APP_SECRET', 'WHATSAPP_META_TOKEN_TEST', 'WHATSAPP_META_GRAPH_VERSION', 'WHATSAPP_META_VERIFY_TOKEN']
    .filter((name) => !configured(env[name]));
  return {
    missing,
    graphVersionMatches: env.WHATSAPP_META_GRAPH_VERSION === EXPECTED.graphVersion,
    outboundGateEnabled: env.OUTBOUND_DELIVERY_ENABLED === 'true',
    whatsappGateEnabled: env.WHATSAPP_CLOUD_SEND_ENABLED === 'true',
    backgroundJobsDisabled: env.BACKGROUND_JOBS_ENABLED === 'false',
    pushDisabled: env.PUSH_SEND_ENABLED === 'false',
    singleAttemptConfigured: (env.WHATSAPP_CLOUD_MAX_SEND_ATTEMPTS ?? '1') === '1',
  };
}

export async function verifyPublic({ fetchImpl = globalThis.fetch } = {}) {
  const checks = await Promise.all(['/health', '/ready', '/api/webhooks/whatsapp-cloud'].map(async (route) => {
    try {
      const response = await fetchImpl(EXPECTED.origin + route, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(45000) });
      const body = await response.json().catch(() => ({}));
      return { route, status: response.status, ...(route === '/ready' ? {
        ready: body.ready === true, sqlReady: body.sqlReady === true, staging: body.runtime === 'staging',
        outboundDeliveryEnabled: body.outboundDeliveryEnabled === true,
        backgroundJobsEnabled: body.backgroundJobsEnabled === true, pushSendEnabled: body.pushSendEnabled === true,
        schemaReady: body.schema?.ready === true,
      } : {}) };
    } catch { return { route, status: null, error: 'PUBLIC_CHECK_UNAVAILABLE' }; }
  }));
  const readiness = checks.find((row) => row.route === '/ready');
  return { checkedAt: new Date().toISOString(), kind: 'public_read_only', origin: EXPECTED.origin,
    checks, ready: checks[0].status === 200 && readiness.status === 200 && readiness.ready && readiness.sqlReady && readiness.staging,
    metaCredentialsVerified: false, wabaSubscriptionVerified: false };
}

// GET only: no /messages request and no automatic WABA subscription.
// No credentials in argv/URLs/logs. Graph response bodies and paging.next URLs
// are not printed or followed; pagination uses only the cursor on a fixed host.
export async function verifyMetaSandbox({ env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const config = configurationSummary(env);
  const base = { checkedAt: new Date().toISOString(), kind: 'meta_read_only', graphVersion: EXPECTED.graphVersion,
    appId: EXPECTED.appId, wabaId: EXPECTED.wabaId, phoneNumberId: EXPECTED.phoneNumberId, activationPerformed: false, channelStateVerified: false,
    configuration: config, wabaAppSubscribed: null, sandboxPhoneMatches: null,
    webhookCallbackMatches: null, messagesFieldSubscribed: null, webhookSubscriptionActive: null,
    metaPreflightPassed: false };
  if (!configured(env.WHATSAPP_META_TOKEN_TEST)) return { ...base, error: 'WHATSAPP_META_TOKEN_TEST_REQUIRED' };
  if (!config.graphVersionMatches) return { ...base, error: 'GRAPH_VERSION_V26_REQUIRED' };
  const token = env.WHATSAPP_META_TOKEN_TEST.trim();
  const readGraph = async (path, params = {}, accessToken = token) => {
    const url = new URL(`https://graph.facebook.com/${EXPECTED.graphVersion}/${path}`);
    Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));
    try {
      const response = await fetchImpl(url, { method: 'GET', redirect: 'error',
        headers: { Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(20000) });
      const data = await response.json().catch(() => null);
      if (!response.ok || !data || data.error) return { error: 'META_READ_REJECTED', httpStatus: response.status,
        providerCode: safeCode(data?.error?.code), providerSubcode: safeCode(data?.error?.error_subcode) };
      return { data };
    } catch { return { error: 'META_READ_UNAVAILABLE' }; }
  };
  let after;
  const seen = new Set();
  for (let page = 0; page < 10; page += 1) {
    const result = await readGraph(`${EXPECTED.wabaId}/subscribed_apps`, { limit: '100', ...(after ? { after } : {}) });
    if (result.error) return { ...base, ...result };
    if (!Array.isArray(result.data.data)) return { ...base, error: 'META_SUBSCRIPTIONS_RESPONSE_INVALID' };
    if (result.data.data.some((row) => String(row?.whatsapp_business_api_data?.id) === EXPECTED.appId)) {
      base.wabaAppSubscribed = true; break;
    }
    if (!result.data.paging?.next) { base.wabaAppSubscribed = false; break; }
    after = result.data.paging?.cursors?.after;
    if (typeof after !== 'string' || !after || after.length > 2048 || seen.has(after)) {
      return { ...base, error: 'META_PAGINATION_UNVERIFIED' };
    }
    seen.add(after);
  }
  if (base.wabaAppSubscribed === null) return { ...base, error: 'META_PAGINATION_LIMIT' };
  const phone = await readGraph(EXPECTED.phoneNumberId, { fields: 'id,display_phone_number' });
  if (phone.error) return { ...base, ...phone };
  base.sandboxPhoneMatches = String(phone.data.id) === EXPECTED.phoneNumberId;

  const appAccessToken = `${EXPECTED.appId}|${env.WHATSAPP_META_APP_SECRET.trim()}`;
  const appSubscriptions = await readGraph(`${EXPECTED.appId}/subscriptions`, {}, appAccessToken);
  if (appSubscriptions.error) return { ...base, ...appSubscriptions };
  if (!Array.isArray(appSubscriptions.data.data)) return { ...base, error: 'META_APP_SUBSCRIPTIONS_RESPONSE_INVALID' };
  const whatsappSubscription = appSubscriptions.data.data.find(row => row?.object === 'whatsapp_business_account');
  base.webhookCallbackMatches = String(whatsappSubscription?.callback_url ?? '') === EXPECTED.callbackUrl;
  base.messagesFieldSubscribed = Array.isArray(whatsappSubscription?.fields)
    && whatsappSubscription.fields.some(field => (typeof field === 'string' ? field : field?.name) === 'messages');
  base.webhookSubscriptionActive = whatsappSubscription?.active === true;
  base.metaPreflightPassed = base.wabaAppSubscribed && base.sandboxPhoneMatches
    && base.webhookCallbackMatches && base.messagesFieldSubscribed && base.webhookSubscriptionActive
    && !config.missing.length && config.backgroundJobsDisabled && config.pushDisabled && config.singleAttemptConfigured;
  return base;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const mode = process.argv[2];
  if (process.argv.length !== 3 || !['--public', '--meta'].includes(mode)) {
    console.log(JSON.stringify({ error: 'USE_PUBLIC_OR_META_MODE_WITH_NO_SECRET_ARGUMENTS' })); process.exitCode = 1;
  } else {
    try {
      const result = mode === '--public' ? await verifyPublic() : await verifyMetaSandbox();
      console.log(JSON.stringify(result, null, 2));
      if (result.error || (mode === '--public' ? !result.ready : !result.metaPreflightPassed)) process.exitCode = 1;
    } catch { console.log(JSON.stringify({ error: 'SANDBOX_CHECK_UNAVAILABLE' })); process.exitCode = 1; }
  }
}
