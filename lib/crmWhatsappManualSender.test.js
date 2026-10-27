import test from 'node:test';
import assert from 'node:assert/strict';
import { createCrmWhatsappManualSender } from './crmWhatsappManualSender.js';
import { createCrmAdminService } from './crmAdmin.js';
const channel = '11111111-1111-4111-8111-111111111111', org = '22222222-2222-4222-8222-222222222222';
const env = { CRM_WHATSAPP_MANUAL_SEND_ENABLED:'true', CRM_WHATSAPP_MANUAL_SECURITY_APPROVED:'true', BACKEND_RUNTIME_MODE:'production', OUTBOUND_DELIVERY_ENABLED:'true', CRM_WHATSAPP_PHONE_NUMBER_ID:'123456789', CRM_WHATSAPP_WABA_ID:'987654321', CRM_WHATSAPP_CHANNEL_ID:channel, CRM_WHATSAPP_ORGANIZATION_ID:org, CRM_WHATSAPP_ACCESS_TOKEN:'fixture', WHATSAPP_META_GRAPH_VERSION:'v26.0' };
const conversation = { id:'conv', source_channel:'whatsapp', origin:'whatsapp:123456789', identity_used:'12345678901' };
const moment = Date.parse('2026-10-20T12:00:00Z');
function db({ channelData = { id:channel }, event = '2026-10-20T11:00:00Z', error = null } = {}) { return { from(table) { const query = { select(){return this}, eq(){return this}, order(){return this}, limit(){return this}, async maybeSingle(){ return { data:table === 'crm_inbound_events' ? event && {received_at:event} : channelData, error }; } };return query; } }; }
function sender({ e=env, store=db(), fetchImpl=async () => ({ok:true,json:async()=>({messages:[{id:'receipt'}]})}), time=moment }={}) { return createCrmWhatsappManualSender({ env:e, fetchImpl, now:()=>time })?.({supabaseAdmin:store}); }
test('manual sender fails closed unless both explicit flags and production configuration are present',()=>{for(const key of ['CRM_WHATSAPP_MANUAL_SEND_ENABLED','CRM_WHATSAPP_MANUAL_SECURITY_APPROVED']) assert.equal(sender({e:{...env,[key]:'false'}}),undefined);for(const patch of [{BACKEND_RUNTIME_MODE:'staging'},{OUTBOUND_DELIVERY_ENABLED:'false'},{CRM_WHATSAPP_PHONE_NUMBER_ID:'bad'},{CRM_WHATSAPP_ACCESS_TOKEN:''}]) assert.throws(()=>sender({e:{...env,...patch}}));});
test('only exact channel, valid inbound window, and actual inbound recipient can send',async()=>{let count=0;const send=sender({fetchImpl:async(url,opts)=>{count++;assert.equal(url,'https://graph.facebook.com/v26.0/123456789/messages');assert.equal(JSON.parse(opts.body).to,conversation.identity_used);return {ok:true,json:async()=>({messages:[{id:'receipt'}]})};}});assert.deepEqual(await send({conversation,body:'hola'}),{providerMessageId:'receipt'});for(const bad of [{...conversation,origin:'whatsapp:999999'}, {...conversation,identity_used:'x12345678901'}]) await assert.rejects(()=>send({conversation:bad,body:'hola'}));for(const store of [db({channelData:null}),db({event:'2026-10-19T11:00:00Z'}),db({event:'2026-10-20T13:00:00Z'}),db({error:{}})]) await assert.rejects(()=>sender({store})({conversation,body:'hola'}));assert.equal(count,1);});
test('network uncertainty never appears as confirmed',async()=>{await assert.rejects(()=>sender({fetchImpl:async()=>{throw Error('timeout')}})({conversation,body:'hola'}),e=>e.code==='CRM_WHATSAPP_SEND_UNCONFIRMED');});
test('a definitive pre-send validation failure cancels the manual reply',async()=>{
 let status='pending';
 const repo={getConversation:async()=>conversation,claimWhatsappReply:async(row)=>({created:true,reply:{...row,status}}),updateReplyStatus:async(_id,next)=>{status=next}};
 const service=createCrmAdminService({repository:repo,resolvePermissions:()=>({canOperate:true}),sendWhatsappReply:async()=>{throw Object.assign(Error('invalid channel'),{code:'CRM_WHATSAPP_CHANNEL_INVALID'})}});
 await assert.rejects(service.reply({email:'authorized@example.test',id:'conv',body:'hello',requestId:'33333333-3333-4333-8333-333333333333'}));
 assert.equal(status,'cancelled');
});
test('repeated CRM request is claimed only once and preserves uncertain attempt',async()=>{const records=[];let calls=0;const repo={getConversation:async()=>conversation,claimWhatsappReply:async(row)=>{const old=records.find(x=>x.id===row.id);if(old)return {created:false,reply:old};records.push({...row,status:'pending'});return {created:true,reply:records.at(-1)};},updateReplyStatus:async()=>{throw Error('storage failed')}};const service=createCrmAdminService({repository:repo,resolvePermissions:()=>({canOperate:true}),sendWhatsappReply:async()=>{calls++;return {providerMessageId:'receipt'}}});const args={email:'authorized@example.test',id:'conv',body:'hello',requestId:'33333333-3333-4333-8333-333333333333'};await assert.rejects(()=>service.reply(args),e=>e.code==='CRM_WHATSAPP_AUDIT_PENDING');await assert.rejects(()=>service.reply(args),e=>e.code==='CRM_REPLY_ALREADY_ATTEMPTED');assert.equal(calls,1);});
test('timeout aborts stalled transport and late acceptance remains uncertain without resending the same reference',async()=>{
  let release, signal, calls=0;
  const fetchImpl=(_url,options)=>{calls++;signal=options.signal;return new Promise(resolve=>{release=resolve})};
  const send=createCrmWhatsappManualSender({env,fetchImpl,now:()=>moment,timeoutMs:10})({supabaseAdmin:db()});
  const records=[];
  const repo={getConversation:async()=>conversation,claimWhatsappReply:async(row)=>{const old=records.find(x=>x.id===row.id);if(old)return {created:false,reply:old};records.push({...row,status:'pending'});return {created:true,reply:records.at(-1)};},updateReplyStatus:async(id,status)=>{records.find(r=>r.id===id).status=status;}};
  const svc=createCrmAdminService({repository:repo,resolvePermissions:()=>({canOperate:true}),sendWhatsappReply:send});
  const args={email:'authorized@example.test',id:'conv',body:'hello',requestId:'44444444-4444-4444-8444-444444444444'};
  await assert.rejects(()=>svc.reply(args),e=>e.code==='CRM_WHATSAPP_AUDIT_PENDING');
  assert.equal(signal.aborted,true);assert.equal(records[0].status,'pending');
  release({ok:true,json:async()=>({messages:[{id:'late-receipt'}]})});
  await new Promise(resolve=>setImmediate(resolve));
  await assert.rejects(()=>svc.reply(args),e=>e.code==='CRM_REPLY_ALREADY_ATTEMPTED');
  assert.equal(records[0].status,'pending');assert.equal(calls,1);
});
test('timeout also bounds stalled provider response bodies',async()=>{
 const send=createCrmWhatsappManualSender({env,now:()=>moment,timeoutMs:10,fetchImpl:async()=>({ok:true,json:()=>new Promise(()=>{})})})({supabaseAdmin:db()});
 await assert.rejects(()=>send({conversation,body:'hello'}),e=>e.code==='CRM_WHATSAPP_SEND_UNCONFIRMED');
});
test('a new reference cannot send while any previous WhatsApp attempt is pending',async()=>{
 let calls=0;const rows=[];
 const repo={getConversation:async()=>conversation,claimWhatsappReply:async(row)=>{const previous=rows.find(r=>r.id===row.id);if(previous)return{created:false,reply:previous};if(rows.some(r=>r.status==='pending'))return{created:false,blocked:true};rows.push({...row,status:'pending'});return{created:true,reply:rows.at(-1)};},updateReplyStatus:async(id,status)=>{rows.find(r=>r.id===id).status=status;}};
 const service=createCrmAdminService({repository:repo,resolvePermissions:()=>({canOperate:true}),sendWhatsappReply:async()=>{calls++;throw Object.assign(Error('uncertain'),{code:'CRM_WHATSAPP_SEND_UNCONFIRMED'});}});
 const args={email:'authorized@example.test',id:'conv',body:'hello',requestId:'55555555-5555-4555-8555-555555555555'};
 await assert.rejects(()=>service.reply(args),e=>e.code==='CRM_WHATSAPP_AUDIT_PENDING');
 await assert.rejects(()=>service.reply({...args,body:'edited',requestId:'66666666-6666-4666-8666-666666666666'}),e=>e.code==='CRM_WHATSAPP_PENDING_REVIEW');
 assert.equal(calls,1);assert.equal(rows[0].status,'pending');
});
