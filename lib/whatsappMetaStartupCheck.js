import { EXPECTED, configurationSummary, verifyMetaSandbox } from './verify-meta-sandbox-v26.mjs';

export const META_QA_STARTUP_FLAG = 'WHATSAPP_META_QA_STARTUP_CHECK_ENABLED';
export const META_QA_RESUBSCRIBE_FLAG = 'WHATSAPP_META_QA_RESUBSCRIBE_ONCE';
const QA_PROJECT = 'vxikhdulhuvghfqeutnp';
const QA_SERVICE = 'srv-dahbs0dbedkc73a0kf4g';
const MAX_DURATION_MS = 25000;
const MAX_REQUESTS = 13; // Up to ten WABA pages plus phone, WABA phone list and app-subscription reads.
const SAFE_CODES = new Set([
  'WHATSAPP_META_TOKEN_TEST_REQUIRED', 'GRAPH_VERSION_V26_REQUIRED',
  'META_READ_REJECTED', 'META_READ_UNAVAILABLE', 'META_SUBSCRIPTIONS_RESPONSE_INVALID',
  'META_APP_SUBSCRIPTIONS_RESPONSE_INVALID',
  'META_PHONE_NUMBERS_RESPONSE_INVALID',
  'META_PAGINATION_UNVERIFIED', 'META_PAGINATION_LIMIT', 'META_QA_SCOPE_REQUIRED',
  'META_QA_DELIVERY_MUST_BE_DISABLED', 'META_QA_CONFIGURATION_INCOMPLETE',
  'META_QA_CHECK_TIMEOUT', 'META_QA_CHECK_UNAVAILABLE',
  'META_QA_RESUBSCRIBE_REJECTED', 'META_QA_RESUBSCRIBE_RESPONSE_INVALID',
]);
const nullableBoolean = value => typeof value === 'boolean' ? value : null;
const boundedCode = value => Number.isSafeInteger(value) && value >= 0 && value <= 9999999999 ? value : null;

function safeLogResult(result = {}) {
  const config = result.configuration;
  const passed = result.metaPreflightPassed === true;
  return {
    code: SAFE_CODES.has(result.error) ? result.error : result.error ? 'META_QA_CHECK_UNAVAILABLE'
      : passed ? 'META_QA_PREFLIGHT_PASSED' : 'META_QA_PREFLIGHT_INCOMPLETE',
    wabaAppSubscribed: nullableBoolean(result.wabaAppSubscribed),
    sandboxPhoneMatches: nullableBoolean(result.sandboxPhoneMatches),
    phoneBelongsToWaba: nullableBoolean(result.phoneBelongsToWaba),
    webhookCallbackMatches: nullableBoolean(result.webhookCallbackMatches),
    messagesFieldSubscribed: nullableBoolean(result.messagesFieldSubscribed),
    webhookSubscriptionActive: nullableBoolean(result.webhookSubscriptionActive),
    phoneLast4: Number.isInteger(result.phoneLast4) && result.phoneLast4 >= 0 && result.phoneLast4 <= 9999
      ? result.phoneLast4 : null,
    isOnBizApp: nullableBoolean(result.isOnBizApp),
    cloudApiPlatform: nullableBoolean(result.cloudApiPlatform),
    phoneConnected: nullableBoolean(result.phoneConnected),
    phoneVerified: nullableBoolean(result.phoneVerified),
    metaPreflightPassed: passed,
    configurationReady: Boolean(config && Array.isArray(config.missing) && !config.missing.length),
    graphVersionMatches: config?.graphVersionMatches === true,
    providerCode: boundedCode(result.providerCode),
    providerSubcode: boundedCode(result.providerSubcode),
    httpStatus: Number.isInteger(result.httpStatus) && result.httpStatus >= 100 && result.httpStatus <= 599
      ? result.httpStatus : null,
    appSecretVerified: false,
    messageDeliveryVerified: false,
    activationPerformed: result.activationPerformed === true,
  };
}

// No HTTP handler, timers with recurrence, SQL, subscription writes or sends.
// Instantiate before the global staging fetch guard; keep the captured fetch
// private, and expose only a once-per-process runner with a fixed read allowlist.
export function createWhatsappMetaQaStartupCheck({
  env = process.env, fetchImpl = globalThis.fetch,
  logger = line => console.info('[whatsapp-meta-qa-check]', line),
  verifyImpl = verifyMetaSandbox, timeoutMs = MAX_DURATION_MS,
} = {}) {
  let promise;
  return function runOnce() {
    if (promise) return promise;
    promise = (async () => {
      if (env[META_QA_STARTUP_FLAG] !== 'true') return null;
      const config = configurationSummary(env);
      const finish = result => {
        const safe = safeLogResult({ configuration: config, ...result });
        try { logger(JSON.stringify(safe)); } catch { /* Diagnostics must not stop the HTTP server. */ }
        return safe;
      };
      if (env.BACKEND_RUNTIME_MODE !== 'staging' || env.STAGING_SUPABASE_PROJECT_REF !== QA_PROJECT
        || env.SUPABASE_URL !== `https://${QA_PROJECT}.supabase.co`
        || env.RENDER_SERVICE_ID !== QA_SERVICE || env.RENDER_EXTERNAL_URL !== EXPECTED.origin) {
        return finish({ error: 'META_QA_SCOPE_REQUIRED' });
      }
      const outboundDeliveryEnabled = env.OUTBOUND_DELIVERY_ENABLED === 'true';
      const whatsappCloudSendEnabled = env.WHATSAPP_CLOUD_SEND_ENABLED === 'true';
      if ((outboundDeliveryEnabled && whatsappCloudSendEnabled)
        || env.BACKGROUND_JOBS_ENABLED !== 'false'
        || env.PUSH_SEND_ENABLED !== 'false') {
        return finish({ error: 'META_QA_DELIVERY_MUST_BE_DISABLED' });
      }
      if (config.missing.length || !config.graphVersionMatches || !config.singleAttemptConfigured) {
        return finish({ error: 'META_QA_CONFIGURATION_INCOMPLETE' });
      }
      let count = 0;
      const controller = new AbortController();
      const rejectRead = () => { throw new Error('META_QA_READ_NOT_ALLOWED'); };
      const readOnlyFetch = async (input, options = {}) => {
        let url;
        try { url = new URL(input); } catch { return rejectRead(); }
        if (controller.signal.aborted || ++count > MAX_REQUESTS || options.method !== 'GET'
          || options.body != null || options.redirect !== 'error' || url.origin !== 'https://graph.facebook.com'
          || url.username || url.password || url.hash) return rejectRead();
        const entries = [...url.searchParams.entries()];
        if (new Set(entries.map(([key]) => key)).size !== entries.length) return rejectRead();
        const subscriptions = url.pathname === `/${EXPECTED.graphVersion}/${EXPECTED.wabaId}/subscribed_apps`
          && url.searchParams.get('limit') === '100'
          && entries.every(([key, value]) => key === 'limit' || key === 'after' && value.length > 0 && value.length <= 2048);
        const phone = url.pathname === `/${EXPECTED.graphVersion}/${EXPECTED.phoneNumberId}`
          && entries.length === 1
          && url.searchParams.get('fields') === 'id,display_phone_number,is_on_biz_app,platform_type,status,code_verification_status';
        const wabaPhones = url.pathname === `/${EXPECTED.graphVersion}/${EXPECTED.wabaId}/phone_numbers`
          && entries.length === 2 && url.searchParams.get('fields') === 'id'
          && url.searchParams.get('limit') === '100';
        const appSubscriptions = url.pathname === `/${EXPECTED.graphVersion}/${EXPECTED.appId}/subscriptions`
          && entries.length === 0;
        if (!subscriptions && !phone && !wabaPhones && !appSubscriptions) return rejectRead();
        const authorization = appSubscriptions
          ? `Bearer ${EXPECTED.appId}|${env.WHATSAPP_META_APP_SECRET.trim()}`
          : `Bearer ${env.WHATSAPP_META_TOKEN_TEST.trim()}`;
        // Construct the options ourselves: no caller headers, body or arbitrary URL params can escape.
        return fetchImpl(url, { method: 'GET', redirect: 'error',
          headers: { Authorization: authorization },
          signal: controller.signal });
      };
      let timer;
      try {
        const duration = Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.min(timeoutMs, MAX_DURATION_MS) : MAX_DURATION_MS;
        const timeout = new Promise(resolve => {
          timer = setTimeout(() => { resolve({ error: 'META_QA_CHECK_TIMEOUT' }); controller.abort(); }, duration);
        });
        const repairAndVerify = async () => {
          let activationPerformed = false;
          if (env[META_QA_RESUBSCRIBE_FLAG] === 'true') {
            const url = new URL(`https://graph.facebook.com/${EXPECTED.graphVersion}/${EXPECTED.wabaId}/subscribed_apps`);
            const response = await fetchImpl(url, { method: 'POST', redirect: 'error',
              headers: { Authorization: `Bearer ${env.WHATSAPP_META_TOKEN_TEST.trim()}` },
              signal: controller.signal });
            const data = await response.json().catch(() => null);
            if (!response.ok) return { error: 'META_QA_RESUBSCRIBE_REJECTED', httpStatus: response.status,
              providerCode: boundedCode(data?.error?.code), providerSubcode: boundedCode(data?.error?.error_subcode) };
            if (data?.success !== true) return { error: 'META_QA_RESUBSCRIBE_RESPONSE_INVALID', httpStatus: response.status };
            activationPerformed = true;
          }
          return { ...(await verifyImpl({ env, fetchImpl: readOnlyFetch })), activationPerformed };
        };
        return finish(await Promise.race([repairAndVerify(), timeout]));
      } catch { return finish({ error: 'META_QA_CHECK_UNAVAILABLE' }); }
      finally { clearTimeout(timer); controller.abort(); }
    })();
    return promise;
  };
}
