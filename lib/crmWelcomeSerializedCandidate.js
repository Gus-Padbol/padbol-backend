import {prepareWelcome} from './crmWelcomeTemplateCandidate.js';
// Permanent claim precedes transaction and is never automatically retried if
// the process dies after Meta may have accepted the message.
export async function processSerializedWelcomeCandidate({sourceId,enabled,templates,repository,lockStore,transport}) {
 if(enabled!==true)return {status:'disabled'};
 const initial=await repository.readAuthoritativeContact(sourceId);
 const p=prepareWelcome({sourceId,contact:initial,templates,enabled});
 if(!p.eligible)return {status:'skipped',reason:p.reason};
 const approvedBody=templates?.[p.language]?.body;
 if(typeof approvedBody!=='string' || !approvedBody.includes('{{1}}') || /\{\{(?!1\}\})/.test(approvedBody)) return {status:'skipped',reason:'approved_body_unavailable'};
 const claim=await repository.claimOnce({sourceId,phone:p.phone,consentVersion:p.consentVersion});
 if(!claim?.acquired)return {status:'already_claimed'};
 return lockStore.withLockedConversation(sourceId,async tx=>{
  const current=await tx.readContact();const q=prepareWelcome({sourceId,contact:current,templates,enabled});
  if(!q.eligible || q.phone!==p.phone || q.consentVersion!==p.consentVersion || q.language!==p.language){await tx.finish('suppressed');return {status:'suppressed'}}
  let receipt;
  try {receipt=await transport.sendApprovedTemplate({to:q.phone,template:q.template,bodyParameters:[q.name]});if(!receipt?.messageId)throw Error('missing receipt')}
  catch {await tx.finish('unknown');return {status:'unknown'}}
  const body=approvedBody.replaceAll('{{1}}',q.name);
  if(!body.trim()||body.length>4096)throw Error('WELCOME_HISTORY_BODY_INVALID');
  await tx.finish('accepted',receipt.messageId,body);return {status:'accepted',messageId:receipt.messageId};
 });
}

// Revocation function must lock this same conversation row, in the same DB.
// A request already in flight when revocation is received cannot be unsent.
export function createWelcomePgLockStoreCandidate(pool) {
 if(!pool || typeof pool.connect!=='function')throw Error('WELCOME_LOCK_CONFIG_INVALID');
 return {async withLockedConversation(id,operation){
  const client=await pool.connect();let begun=false;
  try {
   await client.query('begin');begun=true;
   const lock=await client.query('select id from public.crm_conversations where id=$1 for update',[id]);
   if(!lock.rows.length)throw Error('WELCOME_CONVERSATION_MISSING');
   const tx={async readContact(){
    const r=await client.query('select c.qualification_data, ct.nombre from public.crm_conversations c left join public.crm_contacts ct on ct.id=c.contact_id where c.id=$1',[id]);
    const v=r.rows[0]?.qualification_data?.whatsapp_contact_consent;
    return v?{name:r.rows[0].nombre,whatsapp:v.phone,language:v.language,whatsapp_followup_consent:v.accepted===true && v.purpose==='consultation_followup',whatsapp_followup_consent_at:v.acceptedAt,whatsapp_followup_consent_version:v.version,whatsapp_followup_consent_revoked_at:v.revokedAt}:null;
   },async finish(status,providerId=null,body=null){
    const r=await client.query("update public.crm_welcome_dispatch_candidate set status=$2,provider_message_id=$3,updated_at=now() where conversation_id=$1 and status='claimed' returning conversation_id",[id,status,providerId]);
    if(!r.rows.length)throw Error('WELCOME_FINISH_FAILED');
    if(status==='accepted'){
     if(typeof body!=='string'||!body.trim()||body.length>4096)throw Error('WELCOME_HISTORY_BODY_INVALID');
     await client.query("insert into public.crm_replies(conversation_id,body,operador,status,provider_message_id) values($1,$2,'WhatsApp automático','sent',$3)",[id,body,providerId]);
    }
   }};
   const result=await operation(tx);await client.query('commit');begun=false;return result;
  } catch(e){if(begun)try{await client.query('rollback')}catch{}throw e}finally{client.release()}
 }};
}
