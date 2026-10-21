import test from 'node:test';
import assert from 'node:assert/strict';
import { createCrmAdminService } from './crmAdmin.js';

test('el titular puede responder únicamente al canal WhatsApp autorizado sin cambiar su auditoría', async () => {
  const actor = {email:'padbolinternacional@gmail.com', userId:'8beebdbe-e1d7-4607-9bb0-9a7d64701408', role:'super_admin'};
  const conversations = {
    allowed:{id:'allowed',source_channel:'whatsapp',origin:'whatsapp:1376102838911694'},
    other:{id:'other',source_channel:'whatsapp',origin:'whatsapp:999999999'},
    email:{id:'email',source_channel:'email',origin:'email:support'},
  };
  const sent=[];
  const repository={getConversation:async id=>conversations[id],claimWhatsappReply:async()=>({created:true,reply:{id:'reply'}}),updateReplyStatus:async()=>{}};
  const svc=createCrmAdminService({repository,sendWhatsappReply:async({conversation})=>{sent.push(conversation.id);return {providerMessageId:'fixture'};}});
  const p=svc.getPermissions(actor); assert.equal(p.canAudit,true); assert.equal(p.canOperate,false); assert.equal(p.canOperateWhatsapp,true);
  const requestId='11111111-1111-4111-8111-111111111111';
  await svc.reply({...actor,id:'allowed',body:'fixture',requestId}); assert.deepEqual(sent,['allowed']);
  for(const id of ['other','email']) await assert.rejects(()=>svc.reply({...actor,id,body:'fixture',requestId}),e=>e.status===403);
  assert.equal(svc.getPermissions({...actor,userId:'another'}).canOperateWhatsapp,undefined);
  assert.equal(svc.getPermissions({...actor,role:'admin_nacional'}).canOperateWhatsapp,undefined);
  assert.equal(svc.getPermissions({...actor,email:'other@example.invalid'}).canOperateWhatsapp,undefined);
  await assert.rejects(()=>svc.createManual({...actor,input:{}}),e=>e.status===403);
  await assert.rejects(()=>svc.handoff({...actor,id:'allowed'}),e=>e.status===403);
});
