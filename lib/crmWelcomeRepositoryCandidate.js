import {contactFromCrmConversation} from './crmWelcomeTemplateCandidate.js';
// Candidate, never auto-mounted. Claim and revoke use SQL functions restricted to service_role.
export function createWelcomeRepositoryCandidate(db, {since} = {}) {
 async function readAuthoritativeContact(id) {
  const {data,error}=await db.from('crm_conversations').select('id,qualification_data,contact:crm_contacts(nombre)').eq('id',id).maybeSingle();
  if(error) throw Error('WELCOME_READ_FAILED');
  return contactFromCrmConversation(data);
 }
 async function record(id,status,extra={}) {
  const {error}=await db.from('crm_welcome_dispatch_candidate').update({status,updated_at:new Date().toISOString(),...extra}).eq('conversation_id',id).eq('status','claimed');
  if(error) throw Error('WELCOME_RECORD_FAILED');
 }
 return {
  readAuthoritativeContact,
  async listPending(limit=20) {
   const {data,error}=await db.rpc('crm_list_welcome_pending_candidate',{p_limit:limit,p_since:since});
   if(error) throw Error('WELCOME_LIST_FAILED');return (data||[]).map(x=>x.conversation_id);
  },
  async claimOnce({sourceId,phone,consentVersion}) {
   const {data,error}=await db.rpc('crm_claim_welcome_candidate',{p_conversation:sourceId,p_phone:phone,p_consent_version:consentVersion});
   if(error) throw Error('WELCOME_CLAIM_FAILED');
   return data?.status==='claimed'?{acquired:true,id:sourceId}:{acquired:false};
  },
  async consentStillValid({sourceId,phone,consentVersion}) {
   const c=await readAuthoritativeContact(sourceId);
   return c?.whatsapp_followup_consent===true && !c.whatsapp_followup_consent_revoked_at && c.whatsapp===phone && c.whatsapp_followup_consent_version===consentVersion;
  },
  recordAccepted:(id,providerId)=>record(id,'accepted',{provider_message_id:providerId}),
  recordUnknown:id=>record(id,'unknown'),
  recordSuppressed:id=>record(id,'suppressed'),
  async revoke(id) {
   const {data,error}=await db.rpc('crm_revoke_welcome_candidate',{p_conversation:id});
   if(error) throw Error('WELCOME_REVOKE_FAILED');return data;
  },
 };
}
