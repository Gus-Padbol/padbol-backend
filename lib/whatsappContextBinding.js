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
    const allowed = new Set(['stage','topic','subtopic','initialMessage','detailMessage','followup','needs_review']);
    if (Object.keys(value.context).some(key => !allowed.has(key))) throw fail('WA_CONTEXT_INVALID');
    const { stage, topic, subtopic, initialMessage, detailMessage, followup, needs_review } = value.context;
    if (value.qualificationStatus != null && !['pending','needs_review'].includes(value.qualificationStatus)) throw fail('WA_CONTEXT_INVALID');
    if (value.nextStep != null && !['whatsapp_menu_topic','confirm_topic','subtopic','details','advisor_handoff'].includes(value.nextStep)) throw fail('WA_CONTEXT_INVALID');
    if (!['topic','confirm_topic','subtopic','details','selected'].includes(stage) || [topic,subtopic].some(x => x != null && (typeof x !== 'string' || x.length > 160)) || [initialMessage,detailMessage].some(x => x != null && (typeof x !== 'string' || x.length > 4096)) || (needs_review != null && typeof needs_review !== 'boolean') || (followup != null && (typeof followup !== 'object' || Array.isArray(followup)))) throw fail('WA_CONTEXT_INVALID');
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
