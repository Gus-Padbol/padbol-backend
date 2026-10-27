import test from 'node:test';
import assert from 'node:assert/strict';
import {createCrmWhatsappManualSender} from './crmWhatsappManualSender.js';
import {createCrmAdminService} from './crmAdmin.js';

// Hermetic harness only: no live server, credentials, database or network.
function scenario(providerOutcome) {
 const now=Date.parse('2026-10-20T12:00:00Z');
 const conv={id:'11111111-1111-4111-8111-111111111111',source_channel:'whatsapp',origin:'whatsapp:123456789',identity_used:'12345678901'};
 const env={CRM_WHATSAPP_MANUAL_SEND_ENABLED:'true',CRM_WHATSAPP_MANUAL_SECURITY_APPROVED:'true',BACKEND_RUNTIME_MODE:'production',OUTBOUND_DELIVERY_ENABLED:'true',CRM_WHATSAPP_PHONE_NUMBER_ID:'123456789',CRM_WHATSAPP_WABA_ID:'987654321',CRM_WHATSAPP_CHANNEL_ID:'22222222-2222-4222-8222-222222222222',CRM_WHATSAPP_ORGANIZATION_ID:'33333333-3333-4333-8333-333333333333',CRM_WHATSAPP_ACCESS_TOKEN:'synthetic-only',WHATSAPP_META_GRAPH_VERSION:'v26.0'};
 let providerCalls=0; const attempts=[];
 const db={from(table){const q={select(){return q},eq(){return q},order(){return q},limit(){return q},async maybeSingle(){return {data:table==='crm_inbound_events'?{received_at:'2026-10-20T11:00:00Z'}:{id:env.CRM_WHATSAPP_CHANNEL_ID},error:null}}};return q}};
 const fetchImpl=async (url,options)=>{providerCalls++;assert.equal(url,'https://graph.facebook.com/v26.0/123456789/messages');assert.equal(JSON.parse(options.body).to,conv.identity_used);if(providerOutcome==='uncertain')throw Error('synthetic network failure');return {ok:true,json:async()=>({messages:[{id:'synthetic-receipt'}]})}};
 const repo={getConversation:async()=>conv,async claimWhatsappReply(row){const old=attempts.find(x=>x.id===row.id);if(old)return{created:false,reply:old};if(attempts.some(x=>x.status==='pending'))return{created:false,blocked:true};const reply={...row,status:'pending'};attempts.push(reply);return{created:true,reply}},async updateReplyStatus(id,status,providerMessageId){const row=attempts.find(x=>x.id===id);row.status=status;row.provider_message_id=providerMessageId}};
 const sender=createCrmWhatsappManualSender({env,fetchImpl,now:()=>now})({supabaseAdmin:db});
 const service=createCrmAdminService({repository:repo,resolvePermissions:()=>({canOperate:true}),sendWhatsappReply:sender});
 const args={id:conv.id,email:'operator@example.invalid',body:'Mensaje de prueba',requestId:'44444444-4444-4444-8444-444444444444'};
 return {service,args,attempts,calls:()=>providerCalls};
}
test('QA aislado simula confirmación e idempotencia sin red',async()=>{const f=scenario('accepted');const a=await f.service.reply(f.args);const b=await f.service.reply(f.args);assert.equal(a.status,'sent');assert.equal(b.repeated,true);assert.equal(f.calls(),1);assert.equal(f.attempts[0].provider_message_id,'synthetic-receipt')});
test('QA aislado bloquea nuevo intento si el resultado es incierto',async()=>{const f=scenario('uncertain');await assert.rejects(()=>f.service.reply(f.args),e=>e.code==='CRM_WHATSAPP_AUDIT_PENDING');await assert.rejects(()=>f.service.reply({...f.args,requestId:'55555555-5555-4555-8555-555555555555'}),e=>e.code==='CRM_WHATSAPP_PENDING_REVIEW');assert.equal(f.calls(),1);assert.equal(f.attempts[0].status,'pending')});
test('staging no puede habilitar este adaptador aunque se cambien flags',()=>{assert.throws(()=>createCrmWhatsappManualSender({env:{CRM_WHATSAPP_MANUAL_SEND_ENABLED:'true',CRM_WHATSAPP_MANUAL_SECURITY_APPROVED:'true',BACKEND_RUNTIME_MODE:'staging',OUTBOUND_DELIVERY_ENABLED:'true'}}),e=>e.code==='CRM_WHATSAPP_CONFIG_INVALID')});
