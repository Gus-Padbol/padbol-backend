import {createWhatsappMetaSender} from './whatsappCloud.js';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function createSupportWhatsappTransport({fetchImpl=globalThis.fetch,graphVersion,resolveAccessToken}={}){
 return createWhatsappMetaSender({graphVersion,resolveAccessToken,fetchImpl:(url,options)=>fetchImpl(url,{...options,redirect:'error'})});
}
export function createSupportWhatsappDispatcherCandidate({pool,sender,principalId,enabled=false,timeoutMs=10000}={}) {
 if(!enabled)return null;
 if(!pool?.connect||!sender?.sendText||!UUID.test(principalId||'')||!Number.isInteger(timeoutMs)||timeoutMs<1000||timeoutMs>30000)throw Error('SUPPORT_DELIVERY_CONFIG');
 const connection=async work=>{const c=await pool.connect();try{return await work(c)}finally{c.release()}};
 async function uncertain(journalId){return connection(async c=>{
  await c.query('begin');try{
   const row=(await c.query('select conversation_id from public.crm_support_delivery_journal where id=$1',[journalId])).rows[0];
   if(row){await c.query('select id from public.crm_conversations where id=$1 for update',[row.conversation_id]);
    await c.query("update public.crm_support_delivery_journal set state='uncertain' where id=$1 and state='claimed'",[journalId]);
    await c.query(`update public.crm_conversations set qualification_data=jsonb_set(coalesce(qualification_data,'{}'::jsonb),'{whatsapp_order_review}','{"required":true,"reason":"uncertain_support_delivery"}'::jsonb,true)where id=$1`,[row.conversation_id]);}
   await c.query('commit');
  }catch(error){await c.query('rollback').catch(()=>{});throw error}
 })}
 const dispatcher={async dispatch(effectId){
  if(!Number.isSafeInteger(effectId)||effectId<1)throw Error('SUPPORT_DELIVERY_INPUT_INVALID');
  // Durable claim commits before I/O. Crash/unknown outcomes cannot retry.
  const claim=await connection(async c=>(await c.query('select public.crm_support_prepare_whatsapp_delivery($1,$2) result',[effectId,principalId])).rows[0].result);
  if(claim.duplicate||claim.sendEnabled!==true)return{status:claim.status,sent:false,retryAllowed:false};
  let attempted=false;
  try{return await connection(async c=>{
   await c.query('begin');try{
    const v=(await c.query('select * from public.crm_conversations where id=$1 for update',[claim.conversationId])).rows[0];
    const j=(await c.query('select * from public.crm_support_delivery_journal where id=$1 and principal_id=$2 for update',[claim.journalId,principalId])).rows[0];
    const latest=(await c.query('select id,received_at from public.crm_inbound_events where conversation_id=$1 order by received_at desc,created_at desc,id desc limit 1',[claim.conversationId])).rows[0];
    const age=Date.now()-new Date(latest?.received_at).getTime();
    if(!v||j?.state!=='claimed'||latest?.id!==claim.sourceEventId||!Number.isFinite(age)||age<0||age>=86400000||String(v.test_visibility_version)!==String(j.menu_revision)||v.estado!=='nuevo'||v.operador||v.assigned_by||v.sede_id||v.derivado||v.handoff_ready||v.qualification_data?.whatsapp_order_review?.required===true||v.qualification_data?.whatsapp_message_order_review?.required===true||!/^[0-9]{8,20}$/.test(claim.toWaId||''))throw Error('SUPPORT_DELIVERY_CHANGED');
    const active=(await c.query(`select 1 from public.crm_support_delivery_principals p join public.whatsapp_tenant_channels ch on ch.id=p.channel_id and ch.tenant_id=p.tenant_id join public.whatsapp_tenants t on t.id=p.tenant_id where p.id=$1 and p.active and ch.active and t.status='active' and ch.meta_phone_number_id=p.phone_number_id and ch.meta_waba_id=p.waba_id and ch.credential_ref=p.credential_ref and t.organization_id=p.organization_id for share of p,ch,t`,[principalId])).rows[0];
    if(!active)throw Error('SUPPORT_CHANNEL_DENIED');
    const controller=new AbortController();let timer;let receipt;
    const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Error('SUPPORT_SEND_TIMEOUT'))},timeoutMs)});
    try{attempted=true;receipt=await Promise.race([sender.sendText({channel:claim.channel,toWaId:claim.toWaId,body:claim.body,signal:controller.signal}),timeout])}finally{clearTimeout(timer)}
    if(typeof receipt?.providerMessageId!=='string'||!receipt.providerMessageId.trim()||receipt.providerMessageId.length>512)throw Error('SUPPORT_SEND_UNCONFIRMED');
    await c.query("update public.crm_replies set status='sent',provider_message_id=$2 where id=$1 and status='pending'",[j.reply_id,receipt.providerMessageId]);
    await c.query("update public.crm_support_delivery_journal set state='sent',provider_message_id=$2 where id=$1 and state='claimed'",[j.id,receipt.providerMessageId]);
    await c.query('commit');return{status:'sent',sent:true,retryAllowed:false};
   }catch(error){await c.query('rollback').catch(()=>{});throw error}
  })}catch{await uncertain(claim.journalId).catch(()=>{});return{status:'uncertain',sent:false,transportAttempted:attempted,retryAllowed:false}}
 },async sweep(limit=10){
  const bound=Number.isInteger(limit)?Math.max(1,Math.min(20,limit)):10;
  const effects=await connection(async c=>(await c.query(`select e.id from public.crm_support_lifecycle_effects e join public.crm_support_cases cases on cases.id=e.case_id join public.crm_support_delivery_principals p on p.id=$1 and p.active and p.capability='support.whatsapp.send' and p.tenant_id=cases.tenant_id and p.channel_id=cases.channel_id where e.effect_type='response_draft' and e.disposition='draft_only' and cases.source_channel='whatsapp' and cases.lifecycle_state='response_draft_ready' and not exists(select 1 from public.crm_support_delivery_journal j where j.effect_id=e.id) order by e.id limit $2`,[principalId,bound])).rows);
  const summary={selected:effects.length,sent:0,held:0,uncertain:0};
  for(const e of effects){try{const result=await dispatcher.dispatch(Number(e.id));if(result.status==='sent'&&result.sent)summary.sent++;else if(result.status==='uncertain')summary.uncertain++;else summary.held++}catch{summary.held++}}
  return summary;
 }};
 return Object.freeze(dispatcher);
}
