import { prospectFollowupEligibility } from './crmProspectFollowupGuard.js';

/**
 * Unscheduled dispatch adapter. It is intentionally not mounted to a timer or
 * route in this branch. `enabled` must be explicitly true and `send` must be
 * supplied by an approved integration; otherwise nothing leaves the system.
 */
export async function dispatchProspectMessage({ db, messageId, send, enabled = false, now = new Date() } = {}) {
  if (!enabled) return { status: 'disabled', sent: false };
  if (!db || !messageId || typeof send !== 'function') throw new Error('PROSPECT_DISPATCH_INVALID');
  const loaded = await db.from('crm_prospect_messages').select('*, prospect:crm_prospects(*)').eq('id', messageId).maybeSingle();
  const message = loaded?.data;
  if (!message) return { status: 'not_found', sent: false };
  if (message.status !== 'queued') return { status: 'not_queued', sent: false };
  // Atomic claim: only one concurrent worker can move a queued message to sending.
  const claim = await db.from('crm_prospect_messages').update({ status: 'sending' }).eq('id', messageId).eq('status','queued').select('*').maybeSingle();
  if (!claim?.data) return { status: 'already_claimed', sent: false };
  const guard = await prospectFollowupEligibility({ db, prospect: message.prospect, message: { ...message, status: 'queued' }, now });
  if (!guard.allowed) {
    await db.from('crm_prospect_messages').update({ status: 'cancelled' }).eq('id', messageId);
    return { status: 'cancelled', sent: false, code: guard.code, reason: guard.reason };
  }
  try {
    const result = await send({ message: message.prospect ? { ...message, prospect: undefined } : message, prospect: message.prospect });
    if (!result?.providerMessageId) throw new Error('PROSPECT_OUTCOME_UNKNOWN');
    await db.from('crm_prospect_messages').update({ status: 'sent', sent_at: now.toISOString(), provider_message_id: result.providerMessageId }).eq('id', messageId);
    return { status: 'sent', sent: true, providerMessageId: result.providerMessageId };
  } catch (error) {
    // A timeout may follow provider acceptance. Never automatically retry this
    // operation; leave it in uncertain for reconciliation.
    await db.from('crm_prospect_messages').update({ status: 'uncertain', error: String(error?.message || error).slice(0, 1000) }).eq('id', messageId);
    return { status: 'uncertain', sent: false };
  }
}
