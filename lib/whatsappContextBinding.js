import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { ticketReferenceFromId } from './crmAdmin.js';

const DOMAIN = 'padbol-qa-context-v1\n';
const PHONE = '1376102838911694';
const WABA = '928900479733370';
const fail = (code, status = 400) => Object.assign(new Error('No se pudo vincular el contexto de WhatsApp.'), { code, status });
export function signWhatsappContext({ secret, timestamp, body }) {
  return createHmac('sha256', secret).update(DOMAIN).update(timestamp).update('\n').update(body).digest('hex');
}
// This service accepts only authenticated, bounded context. The repository must
// atomically match the persisted inbound event, bind to its conversation and
// deduplicate updates by provider message ID; this module never trusts a
// conversation ID supplied by QA.
export function createWhatsappContextBinding({ repository, secret, now = Date.now } = {}) {
  if (!repository?.bindInboundContext || !secret) throw fail('WA_CONTEXT_CONFIG', 503);
  return async ({ body, timestamp, signature }) => {
    const stamp = String(timestamp || '');
    const sig = String(signature || '');
    if (!Buffer.isBuffer(body) || body.length > 16384 || !/^\d{10}$/.test(stamp) || Math.abs(Math.floor(now()/1000)-Number(stamp)) > 300 || !/^[a-f0-9]{64}$/.test(sig)) throw fail('WA_CONTEXT_AUTH', 401);
    const expected = signWhatsappContext({ secret, timestamp:stamp, body });
    if (!timingSafeEqual(Buffer.from(sig,'hex'), Buffer.from(expected,'hex'))) throw fail('WA_CONTEXT_AUTH',401);
    let value;try { value=JSON.parse(body.toString('utf8')); } catch { throw fail('WA_CONTEXT_INVALID'); }
    if (!value || !Number.isSafeInteger(value.revision) || value.revision < 1 || value.wabaId !== WABA || value.phoneNumberId !== PHONE || typeof value.messageId !== 'string' || value.messageId.length < 1 || value.messageId.length > 512 || !/^\d{5,20}$/.test(value.sender || '') || !value.context || typeof value.context !== 'object' || Array.isArray(value.context)) throw fail('WA_CONTEXT_INVALID');
    const allowed = new Set(['stage','topic','subtopic','initialMessage','detailMessage','followup','needs_review','order_review']);
    if (Object.keys(value.context).some(key => !allowed.has(key))) throw fail('WA_CONTEXT_INVALID');
    const { stage, topic, subtopic, initialMessage, detailMessage, followup, needs_review, order_review } = value.context;
    if (value.qualificationStatus != null && !['pending','needs_review'].includes(value.qualificationStatus)) throw fail('WA_CONTEXT_INVALID');
    if (value.nextStep != null && !['whatsapp_menu_topic','confirm_topic','subtopic','details','advisor_handoff'].includes(value.nextStep)) throw fail('WA_CONTEXT_INVALID');
    if (!['topic','confirm_topic','subtopic','details','selected'].includes(stage) || [topic,subtopic].some(x => x != null && (typeof x !== 'string' || x.length > 160)) || [initialMessage,detailMessage].some(x => x != null && (typeof x !== 'string' || x.length > 4096)) || (needs_review != null && typeof needs_review !== 'boolean') || (order_review != null && order_review !== true) || (followup != null && (typeof followup !== 'object' || Array.isArray(followup)))) throw fail('WA_CONTEXT_INVALID');
    if (followup && (Object.keys(followup).some(k=>!['topic','subtopic','detail'].includes(k)) || Object.values(followup).some(v=>v != null && (typeof v !== 'string' || v.length > 4096)))) throw fail('WA_CONTEXT_INVALID');
    const hash = createHash('sha256').update(body).digest('hex');
    const result = await repository.bindInboundContext({ messageId:value.messageId, revision:value.revision, sender:value.sender, phoneNumberId:PHONE, wabaId:WABA, context:value.context, qualificationStatus:value.qualificationStatus ?? null, nextStep:value.nextStep ?? null, contentHash:hash });
    if (!result?.conversationId) throw fail('WA_CONTEXT_EVENT_UNCONFIRMED',409);
    const reference = ticketReferenceFromId(result.conversationId);
    if (!reference) throw fail('WA_CONTEXT_EVENT_UNCONFIRMED',409);
    return { ticket_reference:reference, replay:result.replay === true };
  };
}

// RPC owns the row lock, event/sender verification and replay ledger.
export function createWhatsappContextRepository(supabaseAdmin) {
  if (!supabaseAdmin?.rpc) throw fail('WA_CONTEXT_CONFIG', 503);
  return { async bindInboundContext(input) {
    const { data, error } = await supabaseAdmin.rpc('crm_bind_whatsapp_context', {
      p_message_id: input.messageId, p_revision: input.revision, p_sender: input.sender, p_phone_number_id: input.phoneNumberId,
      p_waba_id: input.wabaId, p_context: input.context, p_content_hash: input.contentHash,
      p_qualification_status: input.qualificationStatus, p_next_step: input.nextStep,
    });
    if (error) throw fail(error.code === '23505' ? 'WA_CONTEXT_REPLAY_CONFLICT' : 'WA_CONTEXT_EVENT_UNCONFIRMED', 409);
    return data;
  } };
}

// Response authenticates the exact submitted body as well as the result, so a
// stale or forged response cannot attach the wrong production ticket.
export function signWhatsappContextResponse({ secret, requestBody, responseBody }) {
  const requestHash = createHash('sha256').update(requestBody).digest('hex');
  return createHmac('sha256', secret).update('padbol-qa-context-response-v1\n').update(requestHash).update('\n').update(responseBody).digest('hex');
}

export function registerWhatsappContextRoute(app, { repository, secret, rawParser, now = Date.now } = {}) {
  if (!app || typeof rawParser !== 'function') throw fail('WA_CONTEXT_CONFIG', 503);
  app.post('/api/internal/whatsapp-context', rawParser, async (req, res) => {
    if (!secret || secret.length < 32 || !repository) return res.status(503).json({ error: 'WA_CONTEXT_CONFIG' });
    try {
      const bind = createWhatsappContextBinding({ repository, secret, now });
      const result = await bind({ body: req.body, timestamp: req.get('x-padbol-timestamp'), signature: req.get('x-padbol-signature') });
      const body = Buffer.from(JSON.stringify(result));
      const signature = signWhatsappContextResponse({ secret, requestBody: req.body, responseBody: body });
      return res.status(200).type('application/json').set('Cache-Control','no-store').set('x-padbol-response-signature', signature).send(body);
    } catch (err) {
      const status = err.status || 500;
      const body = Buffer.from(JSON.stringify({ code: err.code || 'WA_CONTEXT_ERROR' }));
      // Only errors reached after successful authentication receive a signature.
      if (status === 409 && Buffer.isBuffer(req.body)) res.set('x-padbol-response-signature', signWhatsappContextResponse({ secret, requestBody: req.body, responseBody: body }));
      return res.status(status).type('application/json').set('Cache-Control','no-store').send(body);
    }
  });
}
