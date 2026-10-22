import test from 'node:test';import assert from 'node:assert/strict';import {createCrmAdminService} from './crmAdmin.js';
test('authorized inbox reports delivery review, failed checks remain unknown, outsiders see nothing',async()=>{
 const rows=[{id:'case1',source_channel:'whatsapp'},{id:'case2',source_channel:'whatsapp'},{id:'case3',source_channel:'email'}];let lookups=0,broken=false;
 const repository={async listConversations(){return rows},async getConversation(id){return rows.find(x=>x.id===id)},async whatsappMenuReviewBatch(ids){lookups++;assert.deepEqual(ids,['case1','case2']);if(broken)throw Error('db');return ['case1']},async whatsappMenuNeedsReview(){lookups++;if(broken)throw Error('db');return true}};
 const svc=createCrmAdminService({repository,whatsappMenuReviewEnabled:true,resolvePermissions:({email})=>({canAudit:email==='admin',canOperate:false})});
 await assert.rejects(svc.listInbox({email:'outsider'}),e=>e.status===403);assert.equal(lookups,0);
 const list=await svc.listInbox({email:'admin'});assert.deepEqual(list.map(x=>x.whatsapp_delivery_review),['required','clear',undefined]);
 assert.equal((await svc.getInbox({email:'admin',id:'case1'})).whatsapp_delivery_review,'required');broken=true;
 assert.equal((await svc.getInbox({email:'admin',id:'case1'})).whatsapp_delivery_review,'unknown');assert.equal((await svc.listInbox({email:'admin'}))[1].whatsapp_delivery_review,'unknown');
});
