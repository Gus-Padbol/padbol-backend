//  only. Dispatch is case-scoped and remains disabled until the
// routing/classification and real PostgreSQL concurrency tests are complete.
export function createCommercialTeamSender({pool,send}) {
 if (!pool || typeof pool.connect !== 'function' || typeof send !== 'function') throw Error('COMMERCIAL_TEAM_SENDER_CONFIG_INVALID');
 return async ({caseId,actorId,replyId,superadmin=false}) => {
  const client=await pool.connect(); let tx=false;
  try {
   await client.query('begin'); tx=true;
   const dispatch=await client.query(`update public.crm_commercial_case_send_attempts a set status='dispatching'
     from public.crm_commercial_cases c, public.crm_replies r, auth.users u
     where a.case_id=$1 and a.reply_id=$2 and a.status='reserved' and c.id=a.case_id
       and u.id=$3 and u.email_confirmed_at is not null and r.id=a.reply_id and r.status='pending'
       and lower(u.email)=r.operador and public.crm_commercial_team_case_allowed(u.id,$4,c.assigned_user_id)
     returning a.reply_id`,[caseId,replyId,actorId,superadmin]);
   await client.query('commit');tx=false;
   if (!dispatch.rows.length) return {status:'already_attempted'};
   await client.query('begin');tx=true;
   await client.query('select user_id from public.crm_commercial_advisors where user_id=$1 for update',[actorId]);
   const head=await client.query('select conversation_id from public.crm_commercial_cases where id=$1',[caseId]);
   if (!head.rows[0]) throw Error('COMMERCIAL_CASE_UNAVAILABLE');
   const convId=head.rows[0].conversation_id;
   const conv=(await client.query('select id,source_channel,origin,identity_used from public.crm_conversations where id=$1 for update',[convId])).rows[0];
   const item=(await client.query('select id,conversation_id,assigned_user_id,status from public.crm_commercial_cases where id=$1 for update',[caseId])).rows[0];
   const claim=(await client.query(`select r.id,r.body,r.operador,r.status from public.crm_commercial_case_replies m
    join public.crm_replies r on r.id=m.reply_id and r.conversation_id=m.conversation_id
    join public.crm_whatsapp_manual_attempts a on a.reply_id=r.id and a.conversation_id=r.conversation_id
    where m.case_id=$1 and m.conversation_id=$2 and r.id=$3 for update of r`,[caseId,convId,replyId])).rows[0];
   const permission=(await client.query(`select public.crm_commercial_team_case_allowed($1,$2,$3) as allowed,
      exists(select 1 from auth.users where id=$1 and email_confirmed_at is not null and lower(email)=$4) as actor_matches`,[actorId,superadmin,item?.assigned_user_id??null,claim?.operador??null])).rows[0];
   if (!conv || !item || !claim || item.conversation_id!==convId || conv.source_channel!=='whatsapp' || conv.origin!=='whatsapp:1376102838911694' || !permission?.allowed || !permission.actor_matches || item.status!=='open') {
    await client.query("update public.crm_replies set status='cancelled' where id=$1 and status='pending'",[replyId]);
    await client.query("update public.crm_commercial_case_send_attempts set status='cancelled' where reply_id=$1",[replyId]);
    await client.query('commit');tx=false;return {status:'cancelled'};
   }
   if (claim.status!=='pending') {await client.query('commit');tx=false;return {status:claim.status};}
   let sent;
   try {sent=await send({conversation:conv,body:claim.body,operador:claim.operador,replyId});}
   catch {await client.query("update public.crm_commercial_case_send_attempts set status='uncertain' where reply_id=$1",[replyId]);await client.query('commit');tx=false;return {status:'uncertain'};}
   if (!sent?.providerMessageId || typeof sent.providerMessageId!=='string' || sent.providerMessageId.length>512) {
    await client.query("update public.crm_commercial_case_send_attempts set status='uncertain' where reply_id=$1",[replyId]);await client.query('commit');tx=false;return {status:'uncertain'};
   }
   await client.query("update public.crm_replies set status='sent',provider_message_id=$2 where id=$1 and status='pending'",[replyId,sent.providerMessageId]);
   await client.query("update public.crm_commercial_case_send_attempts set status='sent' where reply_id=$1",[replyId]);
   await client.query('commit');tx=false;return {status:'sent',providerMessageId:sent.providerMessageId};
  }catch(e){if(tx)try{await client.query('rollback');}catch{}throw e;}finally{client.release();}
 };
}
