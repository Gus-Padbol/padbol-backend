import test from 'node:test';
import assert from 'node:assert/strict';
import { createCrmAdminService } from './crmAdmin.js';

test('el titular conserva operación CRM completa aprobada, sin omitir transporte ni requisitos de calificación', async () => {
  const actor = {email:'padbolinternacional@gmail.com', userId:'8beebdbe-e1d7-4607-9bb0-9a7d64701408', role:'super_admin'};
  const conversations = {
    allowed:{id:'allowed',source_channel:'whatsapp',origin:'whatsapp:1376102838911694'},
    other:{id:'other',source_channel:'whatsapp',origin:'whatsapp:999999999'},
    email:{id:'email',source_channel:'email',origin:'email:support'},
  };
  const sent=[];
  const repository={getConversation:async id=>conversations[id],claimWhatsappReply:async()=>({created:true,reply:{id:'reply'}}),updateReplyStatus:async()=>{}};
  const svc=createCrmAdminService({repository,sendWhatsappReply:async({conversation})=>{sent.push(conversation.id);return {providerMessageId:'fixture'};}});
  const p=svc.getPermissions(actor); assert.equal(p.canAudit,true); assert.equal(p.canOperate,true);assert.equal(p.role,'manager');assert.equal(p.whatsappSendEnabled,true);
  const requestId='11111111-1111-4111-8111-111111111111';
  await svc.reply({...actor,id:'allowed',body:'fixture',requestId}); assert.deepEqual(sent,['allowed']);
  await svc.reply({...actor,id:'other',body:'fixture',requestId});assert.deepEqual(sent,['allowed','other']);
  await assert.rejects(()=>svc.reply({...actor,id:'email',body:'fixture',requestId}),e=>e.code==='CRM_REPLY_CHANNEL_DISABLED');
  for(const unprivileged of [{...actor,role:null},{...actor,role:'admin_nacional'},{...actor,email:'other@example.invalid',role:null}]){assert.notEqual(svc.getPermissions(unprivileged).canOperate,true);await assert.rejects(()=>svc.reply({...unprivileged,id:'allowed',body:'fixture',requestId}),e=>e.status===403);}
  assert.equal(svc.getPermissions({...actor,userId:'another'}).canManageVisibility,false);
  await assert.rejects(()=>svc.createManual({...actor,input:{}}),e=>e.status===400);
  await assert.rejects(()=>svc.handoff({...actor,id:'allowed'}),e=>e.code==='CRM_HANDOFF_NOT_READY');
});
