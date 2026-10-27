import test from 'node:test';import assert from 'node:assert/strict';import {createCrmAdminService} from './crmAdmin.js';
import {resolveWhatsappProductionMenuFlags} from './whatsappProductionMenuFlagsCandidate.js';
test('an uncertain delivery stays visible and reconcilable after automatic sender shutdown',async()=>{
 const id='11111111-1111-4111-8111-111111111111',userId='22222222-2222-4222-8222-222222222222'; let uncertain=true;
 const repository={async getConversation(){return{id,source_channel:'whatsapp'}},async whatsappMenuNeedsReview(){return uncertain},async reconcileWhatsappMenu(){uncertain=false;return{reviewed:true,outcome:'not_delivered'}}};
 const flags=resolveWhatsappProductionMenuFlags({WHATSAPP_PRODUCTION_MENU_ENABLED:'false',WHATSAPP_MENU_REVIEW_ENABLED:'true'});
 const svc=createCrmAdminService({repository,whatsappMenuReviewEnabled:flags.reviewEnabled,resolvePermissions:()=>({canAudit:true})});
 assert.equal((await svc.getInbox({email:'admin',userId,id})).whatsapp_delivery_review,'required');
 await svc.reconcileWhatsappMenu({email:'admin',userId,id,outcome:'not_delivered',evidence:'Provider console checked',providerId:''});
 assert.equal((await svc.getInbox({email:'admin',userId,id})).whatsapp_delivery_review,'clear');
});
test('authorized inbox reports delivery review, failed checks remain unknown, outsiders see nothing',async()=>{
 const rows=[{id:'case1',source_channel:'whatsapp',qualification_data:{whatsapp_message_order_review:{required:true}}},{id:'case2',source_channel:'whatsapp'},{id:'case3',source_channel:'email'}];let lookups=0,broken=false;
 const repository={async listConversations(){return rows},async getConversation(id){return rows.find(x=>x.id===id)},async whatsappMenuReviewBatch(ids){lookups++;assert.deepEqual(ids,['case1','case2']);if(broken)throw Error('db');return ['case1']},async whatsappMenuNeedsReview(){lookups++;if(broken)throw Error('db');return true}};
 const svc=createCrmAdminService({repository,whatsappMenuReviewEnabled:true,resolvePermissions:({email})=>({canAudit:email==='admin',canOperate:false})});
 await assert.rejects(svc.listInbox({email:'outsider'}),e=>e.status===403);assert.equal(lookups,0);
 const list=await svc.listInbox({email:'admin'});assert.deepEqual(list.map(x=>x.whatsapp_delivery_review),['required','clear',undefined]);
 assert.deepEqual(list.map(x=>x.whatsapp_message_order_review),['required','clear',undefined]);
 assert.equal((await svc.getInbox({email:'admin',id:'case1'})).whatsapp_message_order_review,'required');
 assert.equal((await svc.getInbox({email:'admin',id:'case1'})).whatsapp_delivery_review,'required');broken=true;
 assert.equal((await svc.getInbox({email:'admin',id:'case1'})).whatsapp_delivery_review,'unknown');assert.equal((await svc.listInbox({email:'admin'}))[1].whatsapp_delivery_review,'unknown');
});
test('reconciliation requires superadmin, explicit evidence and a provider id when delivered',async()=>{
 const id='11111111-1111-4111-8111-111111111111',userId='22222222-2222-4222-8222-222222222222';let saved;
 const repository={async getConversation(){return{id,source_channel:'whatsapp'}},async reconcileWhatsappMenu(input){saved=input;return{reviewed:true,outcome:input.outcome}}};
 const svc=createCrmAdminService({repository,whatsappMenuReviewEnabled:true,resolvePermissions:({email})=>({canAudit:email==='admin',canOperate:email==='operator'})});
 const args={email:'admin',userId,id,outcome:'delivered',evidence:'Meta receipt reviewed',providerId:'wamid.fixture'};
 await assert.rejects(svc.reconcileWhatsappMenu({...args,email:'operator'}),e=>e.status===403);
 await assert.rejects(svc.reconcileWhatsappMenu({...args,evidence:''}),e=>e.status===400);
 await assert.rejects(svc.reconcileWhatsappMenu({...args,providerId:''}),e=>e.status===400);
 await svc.reconcileWhatsappMenu(args);assert.equal(saved.reviewerId,userId);assert.match(saved.evidenceHash,/^[0-9a-f]{64}$/);assert.equal(JSON.stringify(saved).includes(args.evidence),false);
});
test('only an authorized WhatsApp operator can resume automation',async()=>{
 const id='11111111-1111-4111-8111-111111111111',userId='22222222-2222-4222-8222-222222222222';let calls=0;
 const repository={async getConversation(){return{id,source_channel:'whatsapp',origin:'whatsapp:1376102838911694'}},async resumeWhatsappAutomation(){calls++;return{resumed:true}}};
 const svc=createCrmAdminService({repository,whatsappMenuReviewEnabled:true,resolvePermissions:({email})=>({canAudit:email==='reader',canOperate:email==='operator'})});
 await assert.rejects(svc.resumeWhatsappAutomation({email:'reader',userId,id}),e=>e.status===403);
 assert.equal(calls,0);
 assert.equal((await svc.resumeWhatsappAutomation({email:'operator',userId,id})).resumed,true);
 assert.equal(calls,1);
});
