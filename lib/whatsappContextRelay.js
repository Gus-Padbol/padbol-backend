import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

// Candidate QA-only transport; it remains inert until explicitly wired and gated.
const DESTINATION = 'https://padbol-backend.onrender.com/api/internal/whatsapp-context';
const REQUEST_DOMAIN = 'padbol-qa-context-v1\n';
const RESPONSE_DOMAIN = 'padbol-qa-context-response-v1\n';
const WABA = '928900479733370';
const PHONE = '1376102838911694';
const QA_SERVICE = 'srv-dahbs0dbedkc73a0kf4g';
const QA_PROJECT = 'vxikhdulhuvghfqeutnp';
const fail = () => Object.assign(new Error('Context relay unavailable'), { code: 'WHATSAPP_CONTEXT_RELAY_UNAVAILABLE' });

export function createWhatsappContextRelay({ env = process.env, repository, fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  if (env.WHATSAPP_CONTEXT_QA_RELAY_ENABLED !== 'true') return null;
  const secret = String(env.WHATSAPP_CONTEXT_BINDING_SECRET || '');
  const recipient = String(env.WHATSAPP_QA_MENU_TEST_RECIPIENT || '').trim();
  if (env.BACKEND_RUNTIME_MODE !== 'staging' || env.RENDER_SERVICE_ID !== QA_SERVICE
      || env.STAGING_SUPABASE_PROJECT_REF !== QA_PROJECT || env.SUPABASE_URL !== `https://${QA_PROJECT}.supabase.co`
      || env.WHATSAPP_QA_MENU_AUTOMATION_ENABLED !== 'true' || env.WHATSAPP_MENU_ATOMIC_QA_ENABLED !== 'true'
      || !/^[1-9][0-9]{7,14}$/.test(recipient) || secret.length < 32
      || typeof fetchImpl !== 'function' || !repository?.claim || !repository?.finish) throw fail();
  return Object.freeze({ async processOne() {
    const item = await repository.claim();
    if (!item) return { status: 'empty' };
    let result = 'retry'; let ticket = null;
    try {
      const payload = item.payload;
      if (!payload || payload.sender !== recipient || payload.wabaId !== WABA || payload.phoneNumberId !== PHONE
          || !Number.isSafeInteger(payload.revision) || payload.revision < 1 || payload.revision !== item.revision
          || typeof payload.messageId !== 'string' || !payload.messageId || !payload.context) throw fail();
      const body = Buffer.from(JSON.stringify(payload));
      if (body.length > 16384) throw fail();
      const timestamp = String(Math.floor(now() / 1000));
      const signature = createHmac('sha256', secret).update(REQUEST_DOMAIN).update(timestamp).update('\n').update(body).digest('hex');
      const response = await fetchImpl(DESTINATION, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(8000),
        headers: { 'content-type': 'application/json', 'x-padbol-timestamp': timestamp, 'x-padbol-signature': signature }, body });
      if (response.redirected || (response.url && response.url !== DESTINATION)) throw fail();
      const responseBody = Buffer.from(await response.arrayBuffer());
      if (responseBody.length > 4096) throw fail();
      const data = JSON.parse(responseBody.toString('utf8'));
      const supplied = response.headers?.get('x-padbol-response-signature') || '';
      const requestHash = createHash('sha256').update(body).digest('hex');
      const expected = createHmac('sha256', secret).update(RESPONSE_DOMAIN).update(requestHash).update('\n').update(responseBody).digest();
      // Even a terminal conflict must be authenticated; forged errors retry.
      if (!/^[a-f0-9]{64}$/.test(supplied) || !timingSafeEqual(Buffer.from(supplied, 'hex'), expected)) throw fail();
      if (response.status === 409 && data?.code === 'WA_CONTEXT_REPLAY_CONFLICT') result = 'conflict';
      else if (response.ok) {
        if (!/^PB-[A-F0-9]{32}$/.test(data?.ticket_reference) || typeof data?.replay !== 'boolean') throw fail();
        ticket = data.ticket_reference; result = 'sent';
      }
    } catch { /* Never log customer data, credentials, or raw provider errors. */ }
    const finalized = await repository.finish({ inboundId: item.inbound_message_id, leaseToken: item.lease_token, result, ticket });
    if (!finalized) throw fail();
    return { status: result };
  } });
}

export function createSupabaseContextOutbox(supabaseAdmin) {
  if (!supabaseAdmin?.rpc) throw fail();
  return {
    async claim() {
      const { data, error } = await supabaseAdmin.rpc('crm_claim_whatsapp_context');
      if (error || !Array.isArray(data) || data.length > 1) throw fail();
      return data[0] || null;
    },
    async finish({ inboundId, leaseToken, result, ticket }) {
      const { data, error } = await supabaseAdmin.rpc('crm_finish_whatsapp_context', {
        p_inbound_id: inboundId, p_lease_token: leaseToken, p_result: result, p_ticket: ticket,
      });
      if (error || typeof data !== 'boolean') throw fail();
      return data;
    },
  };
}
