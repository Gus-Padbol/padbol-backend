import test from 'node:test';
import assert from 'node:assert/strict';
import { createCrmEmailSender, buildCrmEmailCapability } from './crmEmailSender.js';
import { createCrmAdminService } from './crmAdmin.js';

const env={BACKEND_RUNTIME_MODE:'production',OUTBOUND_DELIVERY_ENABLED:'true',CRM_OUTBOUND_EMAIL_ENABLED:'true',CRM_OUTBOUND_EMAIL_PROVIDER:'resend',CRM_OUTBOUND_EMAIL_FROM:'Padbol <support@example.test>',CRM_OUTBOUND_EMAIL_API_KEY:'mock-secret'};
const conversation={id:'c1',source_channel:'email',contact:{email_normalized:'contact@example.test'}};
const requestId='12345678-1234-4234-8234-123456789abc';
const permission=()=>({canOperate:true,canAudit:false,role:'operator'});
function repository(){const writes=[];return {writes,async getConversation(){return conversation;},async claimEmailReply(data){const old=writes.find(r=>r.id===data.id);if(old)return {created:false,reply:old};const row={operation:'create',...data,status:'pending'};writes.push(row);return {created:true,reply:row};},async createReply(data){writes.push({operation:'create',...data});return {id:'r1'};},async updateReplyStatus(id,status,providerId){const row=writes.find(r=>r.id===id);if(row){row.status=status;row.provider_message_id=providerId;}writes.push({operation:'update',id,status,providerId});}};}

test('email capability fails closed unless runtime, provider, sender, token and explicit flag are ready',()=>{
 for(const patch of [{CRM_OUTBOUND_EMAIL_ENABLED:'false'},{OUTBOUND_DELIVERY_ENABLED:'false'},{BACKEND_RUNTIME_MODE:''},{CRM_OUTBOUND_EMAIL_FROM:''},{CRM_OUTBOUND_EMAIL_PROVIDER:'smtp'},{CRM_OUTBOUND_EMAIL_API_KEY:''}]) assert.equal(createCrmEmailSender({env:{...env,...patch},fetchImpl:()=>{throw Error('no request');}}),null);
 assert.equal(buildCrmEmailCapability(env).enabled,true);
 assert.doesNotMatch(JSON.stringify(buildCrmEmailCapability(env)),/mock-secret/);
});
test('authorized mocked email reply is recorded pending before provider acceptance, then marked sent',async()=>{
 const repo=repository();let requested;
 const sender=createCrmEmailSender({env,fetchImpl:async(url,options)=>{assert.equal(repo.writes[0].status,'pending');requested={url,options};return new Response(JSON.stringify({id:'mock-provider-id'}),{status:200});}});
 const service=createCrmAdminService({repository:repo,resolvePermissions:permission,sendEmailReply:sender});
 assert.equal(service.getPermissions({}).emailSendEnabled,true);
 const result=await service.reply({email:'verified-operator@example.test',id:'c1',body:'Verified reply',requestId});
 assert.equal(result.status,'sent');assert.equal(requested.url,'https://api.resend.com/emails');
 const payload=JSON.parse(requested.options.body);assert.deepEqual(payload.to,['contact@example.test']);assert.equal(payload.from,env.CRM_OUTBOUND_EMAIL_FROM);
 assert.equal(requested.options.headers['Idempotency-Key'],`crm-reply:${result.replyId}`);assert.equal(repo.writes[1].status,'sent');
});
test('disabled sender rejects email before persistence and sender rejection never becomes sent',async()=>{
 const disabled=repository();const disabledService=createCrmAdminService({repository:disabled,resolvePermissions:permission});
 await assert.rejects(disabledService.reply({email:'operator',id:'c1',body:'Reply',requestId}),e=>e.code==='CRM_REPLY_CHANNEL_DISABLED');assert.equal(disabled.writes.length,0);
 const repo=repository();const sender=createCrmEmailSender({env,fetchImpl:async()=>new Response('provider rejected',{status:403})});
 const service=createCrmAdminService({repository:repo,resolvePermissions:permission,sendEmailReply:sender});
 await assert.rejects(service.reply({email:'operator',id:'c1',body:'Reply',requestId}),e=>e.code==='CRM_EMAIL_SEND_REJECTED');assert.equal(repo.writes[1].status,'cancelled');
});
test('email sender does not confer operator permissions to an audit-only user',async()=>{
 const repo=repository();let called=false;
 const service=createCrmAdminService({repository:repo,resolvePermissions:()=>({canOperate:false,canAudit:true}),sendEmailReply:async()=>{called=true;}});
 await assert.rejects(service.reply({email:'auditor',id:'c1',body:'Reply',requestId}),e=>e.code==='CRM_ADMIN_FORBIDDEN');
 assert.equal(repo.writes.length,0);assert.equal(called,false);
});

test('uncertain provider acceptance or failed audit remains pending instead of falsely cancelled',async()=>{
 for(const failure of ['network','provider5xx','audit']) {
  const repo=repository();
  if(failure==='audit')repo.updateReplyStatus=async()=>{throw Error('storage unavailable');};
  const sender=createCrmEmailSender({env,fetchImpl:async()=>{if(failure==='network')throw Error('network');if(failure==='provider5xx')return new Response('temporary',{status:503});return new Response(JSON.stringify({id:'provider-accepted'}));}});
  const service=createCrmAdminService({repository:repo,resolvePermissions:permission,sendEmailReply:sender});
  await assert.rejects(service.reply({email:'operator',id:'c1',body:'Reply',requestId}),e=>e.code===(failure!=='audit'?'CRM_EMAIL_SEND_UNCONFIRMED':'CRM_EMAIL_AUDIT_PENDING'));
  assert.equal(repo.writes.some(row=>row.status==='cancelled'),false);
 }
});

test('repeating an email request never duplicates provider delivery and different compositions have independent references',async()=>{
 const repo=repository();let calls=0;const service=createCrmAdminService({repository:repo,resolvePermissions:permission,sendEmailReply:async()=>{calls++;return {providerMessageId:'mock-id'};}});
 const args={email:'operator',id:'c1',body:'Reply',requestId};
 await service.reply(args);assert.equal((await service.reply(args)).repeated,true);assert.equal(calls,1);
 await assert.rejects(service.reply({...args,body:'Changed'}),e=>e.code==='CRM_REPLY_REFERENCE_CONFLICT');
 await service.reply({...args,requestId:'22345678-1234-4234-8234-123456789abc'});assert.equal(calls,2);
});
test('uncertain email attempt blocks same reference retry and missing reference fails before persistence',async()=>{
 const repo=repository();let calls=0;const service=createCrmAdminService({repository:repo,resolvePermissions:permission,sendEmailReply:async()=>{calls++;throw Object.assign(Error('uncertain'),{code:'CRM_EMAIL_SEND_UNCONFIRMED'});}});
 const args={email:'operator',id:'c1',body:'Reply',requestId};
 await assert.rejects(service.reply({...args,requestId:undefined}),e=>e.code==='CRM_REPLY_REFERENCE_REQUIRED');assert.equal(repo.writes.length,0);
 await assert.rejects(service.reply(args));await assert.rejects(service.reply(args),e=>e.code==='CRM_REPLY_ALREADY_ATTEMPTED');assert.equal(calls,1);
});
