import {createHash} from 'node:crypto';
import {canonicalMessageId} from './crmEmailReturn.js';
const hash=value=>createHash('sha256').update(value).digest('hex');
const mailbox=value=>typeof value==='string'&&/^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/.test(value)?value.toLowerCase():null;
const fail=code=>Object.assign(Error(code),{code});
function normalize(event,recipient){
 const externalId=canonicalMessageId(event?.externalId),from=mailbox(event?.from),to=mailbox(event?.to),received=new Date(event?.receivedAt);
 const references=[...new Set([event?.inReplyTo,...(Array.isArray(event?.references)?event.references:[])].map(canonicalMessageId).filter(Boolean))].slice(-30);
 const originalBody=String(event?.originalBody??event?.body??''),body=String(event?.body??'').trim().slice(0,4000);
 if(!externalId||!from||to!==recipient||!references.length||!body||!Number.isFinite(received.getTime())||Buffer.byteLength(originalBody)>5*1024*1024)return null;
 return {externalId,from,to,references,body,originalBody,subject:String(event.subject||'').trim().slice(0,512),receivedAt:received.toISOString(),...(canonicalMessageId(event.inReplyTo)?{inReplyTo:canonicalMessageId(event.inReplyTo)}:{})};
}
export function createCrmEmailReturnQueue({pool,emailReturn,env=process.env,logger=console}={}){
 const recipient=mailbox(env.CRM_OUTBOUND_EMAIL_REPLY_TO),enabled=Boolean(emailReturn?.enabled&&pool?.connect&&recipient&&env.CRM_EMAIL_RETURN_QUEUE_ENABLED==='true');
 const transaction=async fn=>{const c=await pool.connect();try{await c.query('begin');const out=await fn(c);await c.query('commit');return out;}catch(e){await c.query('rollback');throw e;}finally{c.release();}};
 const audit=(c,id,type,details)=>c.query('insert into crm_email_return_queue_audit(queue_id,event_type,details) values($1,$2,$3)',[id,type,JSON.stringify(details)]);
 async function enqueue(event){const id=hash(event.externalId),fingerprint=hash(JSON.stringify({...event,receivedAt:undefined}));return transaction(async c=>{
  await c.query("insert into crm_email_return_pending(id,external_id,sender,recipient,message_refs,raw_event,payload_hash,fallback_origin) values($1,$2,$3,$4,$5,$6,$7,'institutional_email') on conflict(id) do nothing",[id,event.externalId,event.from,event.to,event.references,JSON.stringify(event),fingerprint]);
  const row=(await c.query('select * from crm_email_return_pending where id=$1 for update',[id])).rows[0];
  if(row.payload_hash!==fingerprint){await c.query("update crm_email_return_pending set status='needs_review',review_reason='PAYLOAD_CONFLICT' where id=$1",[id]);const prior=await c.query("select 1 from crm_email_return_queue_audit where queue_id=$1 and event_type='payload_conflict' and details->>'payloadHash'=$2",[id,fingerprint]);if(!prior.rows.length)await audit(c,id,'payload_conflict',{payloadHash:fingerprint,event});return {id,conflict:true};}
  const seen=(await c.query("select 1 from crm_email_return_queue_audit where queue_id=$1 and event_type='queued'",[id])).rows.length;if(!seen)await audit(c,id,'queued',{});return {id,conflict:row.review_reason==='PAYLOAD_CONFLICT'};
 });}
 async function review(c,row,reason){if(row.review_reason!==reason){await audit(c,row.id,'needs_review',{reason});}await c.query("update crm_email_return_pending set status='needs_review',review_reason=$2,last_checked_at=now() where id=$1",[row.id,reason]);}
 async function reconcileRow(client,row){
  if(row.review_reason==='PAYLOAD_CONFLICT')return 'review';
  const candidates=(await client.query(`select distinct c.id,p.email_normalized from crm_email_provider_receipts e join crm_replies r on r.id=e.reply_id
   join crm_conversations c on c.id=r.conversation_id join crm_contacts p on p.id=c.contact_id
   where e.rfc_message_id=any($1) and c.source_channel='email' and c.test_hidden_at is null and c.email_return_linked_to is null`,[row.message_refs])).rows;
  if(candidates.length!==1||candidates[0].email_normalized!==row.sender){await transaction(async c=>{if(candidates.length)await review(c,row,candidates.length>1?'AMBIGUOUS_REFERENCES':'IDENTITY_MISMATCH');else await c.query('update crm_email_return_pending set last_checked_at=now() where id=$1',[row.id]);});return candidates.length?'review':'pending';}
  const result=await emailReturn.ingestReply(row.raw_event);if(!result.matched){await client.query('update crm_email_return_pending set last_checked_at=now() where id=$1',[row.id]);return 'pending';}
  return transaction(async c=>{const q=(await c.query('select * from crm_email_return_pending where id=$1 for update',[row.id])).rows[0];if(q.review_reason==='PAYLOAD_CONFLICT')return 'review';
   if(q.linked_conversation_id&&q.linked_conversation_id!==result.conversationId){await review(c,q,'TARGET_CONFLICT');return 'review';}
   if(q.linked_conversation_id!==result.conversationId)await audit(c,q.id,'matched',{conversationId:result.conversationId});
   await c.query("update crm_email_return_pending set status='matched',linked_conversation_id=$2,review_reason=null,last_checked_at=now() where id=$1",[q.id,result.conversationId]);
   const fallbacks=(await c.query(`select c.id from crm_conversations c join crm_contacts p on p.id=c.contact_id where c.source_channel='email' and c.source_ref=$1 and c.origin='institutional_email' and p.email_normalized=$2 and c.id<>$3`,[q.external_id,q.sender,result.conversationId])).rows;
   if(fallbacks.length>1){await review(c,q,'AMBIGUOUS_FALLBACK');return 'review';}
   if(fallbacks.length){const link=(await c.query('select crm_email_return_link_fallback($1,$2,$3) outcome',[q.id,result.conversationId,fallbacks[0].id])).rows[0]?.outcome;if(link==='human_review'){await review(c,q,'FALLBACK_HAS_HUMAN_WORK');return 'review';}}
   return 'matched';
  });
 }
 async function reconcilePending({id=null,references=null,limit=20}={}){
  if(!enabled)return {enabled:false,processed:0};const client=await pool.connect();let locked=false;
  try{locked=(await client.query('select pg_try_advisory_lock(271028,170000) locked')).rows[0]?.locked===true;if(!locked)return {enabled:true,busy:true,processed:0};
   const filters=['q.review_reason is distinct from \'PAYLOAD_CONFLICT\''],params=[];
   if(id){params.push(id);filters.push('q.id=$'+params.length);}else if(references?.length){params.push(references);filters.push('q.message_refs && $'+params.length);}
   else filters.push("(q.status<>'matched' or exists(select 1 from crm_conversations c where c.source_channel='email' and c.origin='institutional_email' and c.source_ref=q.external_id and c.email_return_linked_to is null))");
   params.push(Math.max(1,Math.min(100,Number(limit)||20)));const rows=(await client.query('select q.* from crm_email_return_pending q where '+filters.join(' and ')+' order by q.last_checked_at nulls first,q.created_at limit $'+params.length,params)).rows;
   const out={enabled:true,processed:0,matched:0,pending:0,review:0};for(const row of rows){try{const outcome=await reconcileRow(client,row);out[outcome]++;}catch(e){const code=/^[A-Z_]{1,100}$/.test(e?.code||'')?e.code:'RECONCILIATION_ERROR';await transaction(c=>review(c,row,code));logger?.warn?.('[crm-email-return-queue]',{code});out.review++;}out.processed++;}return out;
  }finally{try{if(locked)await client.query('select pg_advisory_unlock(271028,170000)');}catch(e){client.release(e);throw fail('CRM_EMAIL_QUEUE_UNLOCK_FAILED');}client.release();}
 }
 return {...emailReturn,queueEnabled:enabled,
  async ingestReply(raw){if(!enabled)return emailReturn.ingestReply(raw);const event=normalize(raw,recipient);if(!event)return emailReturn.ingestReply(raw);const queued=await enqueue(event);if(queued.conflict)return {matched:true,queued:true,requiresReview:true};await reconcilePending({id:queued.id});const row=await transaction(async c=>(await c.query('select status,linked_conversation_id from crm_email_return_pending where id=$1',[queued.id])).rows[0]);return row.status==='matched'?{matched:true,conversationId:row.linked_conversation_id}:{matched:false,queued:true};},
  async afterFallback(event){if(!enabled)return;const id=canonicalMessageId(event?.externalId);if(id)await reconcilePending({id:hash(id)});},
  async providerEvent(raw,headers){const result=await emailReturn.providerEvent(raw,headers);if(enabled&&result.recorded){const event=JSON.parse(raw.toString('utf8')),reference=canonicalMessageId(event.data?.message_id);if(reference)await reconcilePending({references:[reference]});}return result;},
  reconcilePending,
 };
}
