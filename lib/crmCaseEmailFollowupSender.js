export function createCaseEmailFollowupSender({emailSender}={}){
 if(typeof emailSender!=='function')throw Error('CASE_EMAIL_SENDER_CONFIG_INVALID');
 return async ({to,body,conversationId,outboxId,client,subject})=>{
  if(!conversationId||!outboxId||!client?.query)throw Object.assign(Error('CASE_EMAIL_SENDER_INPUT'),{code:'CASE_EMAIL_SENDER_INPUT'});
  const r=await client.query('select c.id,c.contact_id,cv.email_normalized from public.crm_conversations c join public.crm_contacts cv on cv.id=c.contact_id where c.id=$1',[conversationId]);
  const row=r.rows[0];if(!row||String(row.email_normalized||'').toLowerCase()!==String(to||'').toLowerCase())throw Object.assign(Error('CASE_EMAIL_RECIPIENT_MISMATCH'),{code:'CASE_EMAIL_RECIPIENT_MISMATCH'});
  await client.query("insert into public.crm_replies(id,conversation_id,body,operador,status) values($1,$2,$3,'automation:case_email_followup','pending') on conflict(id) do nothing",[outboxId,conversationId,body]);
  try{
   const result=await emailSender({conversation:{contact:{email_normalized:row.email_normalized}},body,replyId:outboxId,subject});
   if(!result?.providerMessageId)throw Object.assign(Error('CASE_EMAIL_SEND_UNCONFIRMED'),{code:'SEND_UNCONFIRMED'});
   await client.query("update public.crm_replies set status='sent',provider_message_id=$2 where id=$1",[outboxId,result.providerMessageId]);
   return result;
  }catch(e){
   await client.query("update public.crm_replies set status='failed' where id=$1 and status='pending'",[outboxId]).catch(()=>{});
   throw Object.assign(e,{ledgerId:outboxId});
  }
 };
}
