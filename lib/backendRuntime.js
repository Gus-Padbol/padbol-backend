// Staging isolates data and makes all delivery switches explicit.
export const BACKEND_RELEASE = '2026-09-09.1';
export function backendRuntime(env = process.env) {
  const staging = env.BACKEND_RUNTIME_MODE === 'staging';
  const enabled = (name) => env[name] == null || env[name] === '' ? !staging : env[name] === 'true';
  return Object.freeze({ staging, mode: staging ? 'staging' : 'standard',
    backgroundJobsEnabled: enabled('BACKGROUND_JOBS_ENABLED'),
    outboundDeliveryEnabled: enabled('OUTBOUND_DELIVERY_ENABLED'),
    pushSendEnabled: enabled('OUTBOUND_DELIVERY_ENABLED') && enabled('PUSH_SEND_ENABLED'),
  });
}
export function assertStagingIsolation(env = process.env) {
  if (env.BACKEND_RUNTIME_MODE !== 'staging') return;
  const expected = String(env.STAGING_SUPABASE_PROJECT_REF || '').trim();
  const production = String(env.PRODUCTION_SUPABASE_PROJECT_REF || '').trim();
  if (!expected || !production || expected === production ||
      env.SUPABASE_URL !== `https://${expected}.supabase.co`) {
    throw new Error('STAGING_SUPABASE_ISOLATION_REQUIRED');
  }
  if (!env.SUPABASE_KEY || !(env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_KEY)) {
    throw new Error('STAGING_SUPABASE_CREDENTIALS_REQUIRED');
  }
  if (env.DATABASE_URL) {
    let url;
    try { url = new URL(env.DATABASE_URL); } catch { throw new Error('STAGING_DATABASE_URL_INVALID'); }
    const direct = url.hostname === `db.${expected}.supabase.co`;
    const pooled = url.hostname.endsWith('.pooler.supabase.com') && decodeURIComponent(url.username) === `postgres.${expected}`;
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || (!direct && !pooled) ||
        url.pathname !== '/postgres' || !['require','verify-ca','verify-full'].includes(url.searchParams.get('sslmode')) ||
        [...url.searchParams.keys()].some(key => key !== 'sslmode')) {
      throw new Error('STAGING_DATABASE_ISOLATION_REQUIRED');
    }
  }
  if (env.STRIPE_SECRET_KEY || env.TWILIO_AUTH_TOKEN || env.RESEND_API_KEY || env.ANTHROPIC_API_KEY || env.MERCADOPAGO_ACCESS_TOKEN || env.MP_ACCESS_TOKEN) {
    throw new Error('STAGING_PROVIDER_CREDENTIALS_NOT_ALLOWED');
  }
}

// In staging, the disabled switch also covers fetch-based transports in legacy
// modules. The only permitted HTTP destination is this staging Supabase project.
export function installStagingFetchGuard(env = process.env, target = globalThis) {
  if (env.BACKEND_RUNTIME_MODE !== 'staging' || backendRuntime(env).outboundDeliveryEnabled) return () => {};
  const allowedHost = `${env.STAGING_SUPABASE_PROJECT_REF}.supabase.co`;
  const original = target.fetch;
  target.fetch = async (input, options) => {
    let url;
    try { url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url); } catch { /* reject below */ }
    if (!url || url.protocol !== 'https:' || url.hostname !== allowedHost || url.port) {
      throw Object.assign(new Error('External delivery disabled in staging'), { status: 503, code: 'OUTBOUND_DISABLED' });
    }
    return original.call(target, input, options);
  };
  return () => { target.fetch = original; };
}

export function assertOutboundDeliveryEnabled(runtime) {
  if (!runtime.outboundDeliveryEnabled) throw Object.assign(new Error('Las operaciones externas están deshabilitadas en este entorno'), {
    status: 503, code: 'OUTBOUND_DISABLED',
  });
}

export function externalOperationsGate(runtime) {
  return (_req, res, next) => {
    try { assertOutboundDeliveryEnabled(runtime); return next(); }
    catch (error) { return res.status(error.status).json({ error: error.message, code: error.code }); }
  };
}
export async function backendReadiness({ supabaseAdmin, serviceRoleConfigured, runtime, timeoutMs = 4000 }) {
  const base = { release: BACKEND_RELEASE, runtime: runtime.mode,
    backgroundJobsEnabled: runtime.backgroundJobsEnabled,
    outboundDeliveryEnabled: runtime.outboundDeliveryEnabled, pushSendEnabled: runtime.pushSendEnabled };
  if (!supabaseAdmin || !serviceRoleConfigured) return { ...base, ready: false, reason: 'database_not_configured' };
  let timer;
  try {
    const result = await Promise.race([
      supabaseAdmin.rpc('match_backend_release_readiness'),
      new Promise((resolve) => { timer = setTimeout(() => resolve({ error: true }), timeoutMs); }),
    ]);
    if (result.error || result.data?.release !== BACKEND_RELEASE || result.data?.ready !== true) {
      return { ...base, ready: false, reason: 'schema_not_ready' };
    }
    return { ...base, ready: true, schema: result.data };
  } catch { return { ...base, ready: false, reason: 'database_unavailable' }; }
  finally { clearTimeout(timer); }
}

export async function backendSqlReadiness(pgPool, timeoutMs = 4000) {
  if (!pgPool) return { ready: false, reason: 'sql_not_configured' };
  let timer;
  try {
    await Promise.race([
      pgPool.query('SELECT 1 AS ok'),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), timeoutMs); }),
    ]);
    return { ready: true };
  } catch { return { ready: false, reason: 'sql_unavailable' }; }
  finally { clearTimeout(timer); }
}
