// This symbol cannot cross JSON, form submission or network boundaries.
const verifiedTriage = Symbol('owner-verified-commercial-email');
export function markVerifiedCommercialEmail(conversation, record) {
  if (!conversation || record?.conversation_id !== conversation.id || conversation.source_channel !== 'email'
    || conversation.origin !== 'institutional_email' || conversation.test_hidden_at || conversation.email_return_linked_to) return conversation;
  const result = {...conversation, commercial_email_classified: true};
  Object.defineProperty(result, verifiedTriage, {value: true});
  return result;
}
export function isVerifiedCommercialEmail(conversation) {
  return conversation?.[verifiedTriage] === true && conversation.source_channel === 'email'
    && conversation.origin === 'institutional_email' && !conversation.test_hidden_at && !conversation.email_return_linked_to;
}
export function createCommercialEmailTriageReader(db, enabled = false) {
  async function records(id) {
    if (!enabled) return [];
    try {
      const result = await db.from('crm_commercial_email_triage').select('conversation_id').eq('conversation_id',id).limit(1);
      // Missing migration, denied access or storage failure never grants access
      // and does not break the existing form/WhatsApp inbox during rollout.
      return result.error || !Array.isArray(result.data) ? [] : result.data;
    } catch { return []; }
  }
  return {enabled, async list(builder) {
    if(!enabled)return [];
    try {
      const result=await builder;
      if(result.error||!Array.isArray(result.data))return [];
      return result.data.map(row=>{
        const {commercial_email_triage,...conversation}=row;
        const record=Array.isArray(commercial_email_triage)?commercial_email_triage[0]:commercial_email_triage;
        return markVerifiedCommercialEmail(conversation,record);
      }).filter(isVerifiedCommercialEmail);
    }catch{return [];}
  }, async mark(conversation) {
    if (conversation?.source_channel !== 'email' || conversation.origin !== 'institutional_email') return conversation;
    return markVerifiedCommercialEmail(conversation, (await records(conversation.id))[0]);
  }};
}
