import {randomUUID} from 'node:crypto';
export function createCaseEmailFollowupSender({pool,emailSender}={}){
 if(!pool?.query||typeof emailSender!=='function')throw Error('CASE_EMAIL_SENDER_CONFIG_INVALID');
 return async ({to,body,conversationId,outboxId})=>{
  if(!conversationId||!outboxId)throw Object.assign(Error('CASE_EMAIL_SENDER_INPUT'),{code:'CASE_EMAIL_SENDER_INPUT'});
  const r=await pool.query('select c.id,c.contact_id,cv.email_normalized from public.crm_conversations c join public.crm_contacts cv on cv.id=c.contact_id where c.id=$1',[conversationId]);
  const row=r.rows[0];if(!row||String(row.email_normalized||'').toLowerCase()!==String(to||'').toLowerCase())throw Object.assign(Error('CASE_EMAIL_RECIPIENT_MISMATCH'),{code:'CASE_EMAIL_RECIPIENT_MISMATCH'});
  const result=await emailSender({conversation:{contact:{email_normalized:row.email_normalized}},body,replyId:outboxId});
  if(!result?.providerMessageId)throw Object.assign(Error('CASE_EMAIL_SEND_UNCONFIRMED'),{code:'SEND_UNCONFIRMED'});
  await pool.query("insert into public.crm_replies(id,conversation_id,body,operador,status,provider_message_id) values($1,$2,$3,'automation:case_email_followup','sent',$4) on conflict(id) do update set status='sent',provider_message_id=excluded.provider_message_id",[outboxId,conversationId,body,result.providerMessageId]);
  await pool.query("insert into public.crm_email_provider_receipts(reply_id,provider_message_id,rfc_message_id,sent_at) values($1,$2,$3,now()) on conflict(reply_id) do nothing",[outboxId,result.providerMessageId,`<${outboxId}@padbol.com>`]);
  return result;
 };
}
