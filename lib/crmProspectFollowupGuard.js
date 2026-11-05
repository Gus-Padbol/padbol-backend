// Central eligibility gate for PADBOL PROSPECT. It is deliberately separate
// from copy/planning and is called again immediately before a queued message
// could be handed to a provider. It never sends anything.
const BLOCKING_STATUSES = new Set(['responded','interested','negotiation','rejected','opt_out','bounced','closed','existing','paused']);
const ACTIVE_MESSAGE_STATUSES = ['queued','simulated'];

function blocked(code, reason, detail = null) {
  return { allowed: false, code, reason, detail };
}

export async function prospectFollowupEligibility({ db, prospect, message, now = new Date() } = {}) {
  if (!db || !prospect || !message) return blocked('PROSPECT_CONTEXT_MISSING', 'Falta contexto del prospecto o del mensaje.');
  if (!['queued','simulated'].includes(String(message.status))) return blocked('MESSAGE_NOT_SENDABLE', `Estado de mensaje ${message.status || 'desconocido'}.`);
  if (BLOCKING_STATUSES.has(String(prospect.status))) return blocked('PROSPECT_STOPPED', `Estado ${prospect.status}.`);
  if (prospect.contact_block_reason) return blocked('PROSPECT_BLOCKED', prospect.contact_block_reason);

  const campaignResult = await db.from('crm_prospect_campaigns').select('id,status').eq('id', message.campaign_id).maybeSingle();
  if (campaignResult?.error || !campaignResult?.data) return blocked('CAMPAIGN_UNAVAILABLE', 'La campaña no está disponible.');
  if (!['approved','active'].includes(String(campaignResult.data.status))) return blocked('CAMPAIGN_NOT_ACTIVE', `Campaña ${campaignResult.data.status}.`);

  const identities = [prospect.email, prospect.phone, prospect.domain].filter(Boolean);
  if (identities.length) {
    const clauses = identities.map(value => value.includes('@') ? `email.eq.${value}` : value.includes('.') && !/\d/.test(value) ? `domain.eq.${value}` : `phone.eq.${value}`);
    const suppression = await db.from('crm_prospect_suppressions').select('reason').eq('active', true).or(clauses.join(',')).limit(1);
    if (suppression?.error) return blocked('SUPPRESSION_UNAVAILABLE', 'No se pudo comprobar la baja o el rebote.');
    if (suppression?.data?.[0]) return blocked('SUPPRESSED', `Baja o rebote: ${suppression.data[0].reason}.`);
  }

  const contactId = prospect.crm_contact_id || null;
  const conversationId = prospect.crm_conversation_id || null;
  if (contactId) {
    const active = await db.from('crm_conversations').select('id,estado,operador').eq('contact_id', contactId).neq('estado','cerrado').limit(1);
    if (active?.error) return blocked('CONVERSATION_UNAVAILABLE', 'No se pudo comprobar la conversación.');
    if (active?.data?.[0]) return blocked('ACTIVE_CONVERSATION', `Gestión activa (${active.data[0].estado}).`, { conversationId: active.data[0].id });
  }
  if (conversationId) {
    const pending = await db.from('crm_replies').select('id').eq('conversation_id', conversationId).eq('status','pending').limit(1);
    if (pending?.error) return blocked('REPLY_UNAVAILABLE', 'No se pudo comprobar la respuesta pendiente.');
    if (pending?.data?.[0]) return blocked('PENDING_REPLY', 'Hay una respuesta pendiente en el canal.');
    const cases = await db.from('crm_commercial_cases').select('progress_state,status').eq('conversation_id', conversationId).limit(1);
    if (cases?.error) return blocked('NEGOTIATION_UNAVAILABLE', 'No se pudo comprobar la negociación.');
    if (cases?.data?.[0] && ['en_atencion','en_espera','derivado'].includes(String(cases.data[0].progress_state))) {
      return blocked('ACTIVE_NEGOTIATION', `Gestión comercial ${cases.data[0].progress_state}.`);
    }
  }

  const other = await db.from('crm_prospect_messages')
    .select('id,campaign_id,status')
    .eq('prospect_id', prospect.id)
    .in('status', ACTIVE_MESSAGE_STATUSES)
    .neq('campaign_id', message.campaign_id)
    .limit(1);
  if (other?.error) return blocked('SEQUENCE_UNAVAILABLE', 'No se pudieron comprobar otras secuencias.');
  if (other?.data?.[0]) return blocked('OTHER_SEQUENCE_ACTIVE', 'Otra secuencia activa para el mismo contacto.', { messageId: other.data[0].id });

  return { allowed: true, checkedAt: now.toISOString() };
}
