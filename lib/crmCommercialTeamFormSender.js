//  only. The global email sender must share this serialization before enablement.
export function createCommercialTeamFormSender({pool,send}) {
 if(!pool||typeof pool.connect!=='function'||typeof send!=='function')throw Error('COMMERCIAL_FORM_SENDER_INVALID');
 return async ({caseId,actorId,replyId,superadmin=false})=>{
  const client=await pool.connect();let tx=false;
  try{
   await client.query('begin');tx=true;
   const d=await client.query(`update public.crm_commercial_form_send_attempts a set status='dispatching'
    from public.crm_commercial_form_cases f, public.crm_replies r,auth.users u
    where a.conversation_id=$1 and a.reply_id=$2 and a.actor_id=$3 and a.status='reserved' and f.conversation_id=a.conversation_id
    and r.id=a.reply_id and r.status='pending' and u.id=$3 and u.email_confirmed_at is not null and lower(u.email)=r.operador
    and public.crm_commercial_form_is_allowed(f.conversation_id) and public.crm_commercial_team_case_allowed(u.id,$4,f.assigned_user_id) returning a.reply_id`,[caseId,replyId,actorId,superadmin]);
   await client.query('commit');tx=false;if(!d.rows.length)return {status:'already_attempted'};
   await client.query('begin');tx=true;
   await client.query('select user_id from public.crm_commercial_advisors where user_id=$1 for update',[actorId]);
   const conv=(await client.query('select * from public.crm_conversations where id=$1 for update',[caseId])).rows[0];
   const item=(await client.query('select * from public.crm_commercial_form_cases where conversation_id=$1 for update',[caseId])).rows[0];
   const reply=(await client.query('select * from public.crm_replies where id=$1 and conversation_id=$2 for update',[replyId,caseId])).rows[0];
   const allowed=(await client.query(`select public.crm_commercial_form_is_allowed($1) and public.crm_commercial_team_case_allowed($2,$3,$4)
    and exists(select 1 from auth.users where id=$2 and email_confirmed_at is not null and lower(email)=$5) as ok`,[caseId,actorId,superadmin,item?.assigned_user_id??null,reply?.operador??null])).rows[0]?.ok;
   if(!conv||!item||!reply||reply.status!=='pending'||!allowed){await client.query("update public.crm_replies set status='cancelled' where id=$1 and status='pending'",[replyId]);await client.query("update public.crm_commercial_form_send_attempts set status='cancelled' where reply_id=$1",[replyId]);await client.query('commit');tx=false;return {status:'cancelled'};}
   const contact=(await client.query('select email_normalized from public.crm_contacts where id=$1',[conv.contact_id])).rows[0];let sent;
   try{sent=await send({conversation:{...conv,contact},body:reply.body,operador:reply.operador,replyId});}
   catch {await client.query("update public.crm_commercial_form_send_attempts set status='uncertain' where reply_id=$1",[replyId]);await client.query('commit');tx=false;return {status:'uncertain'};}
   if(!sent?.providerMessageId||typeof sent.providerMessageId!=='string'||sent.providerMessageId.length>512){await client.query("update public.crm_commercial_form_send_attempts set status='uncertain' where reply_id=$1",[replyId]);await client.query('commit');tx=false;return {status:'uncertain'};}
   await client.query("update public.crm_replies set status='sent',provider_message_id=$2 where id=$1 and status='pending'",[replyId,sent.providerMessageId]);
   await client.query("update public.crm_commercial_form_send_attempts set status='sent' where reply_id=$1",[replyId]);await client.query('commit');tx=false;return {status:'sent',providerMessageId:sent.providerMessageId};
  }catch(e){if(tx)try{await client.query('rollback');}catch{}throw e;}finally{client.release();}
 };
}
