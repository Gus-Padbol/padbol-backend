import { classifyProspectReply, statusForClassification, stopSequenceFor } from './crmProspectSequence.js';

/** Apply an inbound email/reply to a prospect without creating a new lead. */
export async function applyProspectReply(db, { email, text = '', source = 'email' } = {}) {
  const normalized = String(email || '').trim().toLowerCase();
  if (!db?.from || !normalized) return null;
  const { data: prospect } = await db.from('crm_prospects').select('*').ilike('email', normalized).maybeSingle();
  if (!prospect?.id) return null;
  const classification = classifyProspectReply(text);
  const status = statusForClassification(classification);
  await db.from('crm_prospects').update({ status, updated_at: new Date().toISOString() }).eq('id', prospect.id);
  if (stopSequenceFor(classification)) await db.from('crm_prospect_messages').update({ status: 'cancelled' }).eq('prospect_id', prospect.id).in('status', ['simulated', 'queued']);
  await db.from('crm_prospect_events').insert({ prospect_id: prospect.id, event_type: 'response', detail: { classification, text: String(text).slice(0, 2000), source, stopSequence: stopSequenceFor(classification) }, actor_id: null });
  if (['interested', 'information_request', 'price_request', 'meeting_request', 'ambiguous'].includes(classification)) {
    await db.from('crm_prospect_events').insert({ prospect_id: prospect.id, event_type: 'advisor_task', detail: { assigned_to: 'Nicolás Renedo', classification, text: String(text).slice(0, 2000) }, actor_id: null });
  }
  if (['opt_out', 'bounce'].includes(classification) && prospect.email) {
    await db.from('crm_prospect_suppressions').insert({ email: prospect.email, reason: classification === 'opt_out' ? 'opt_out' : 'bounce', source, created_by: 'inbound-email' });
  }
  return { prospectId: prospect.id, classification, status, stopSequence: stopSequenceFor(classification) };
}
