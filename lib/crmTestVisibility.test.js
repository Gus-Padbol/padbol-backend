import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCrmAdminService } from './crmAdmin.js';
import { createSupabaseCrmRepository } from './crmService.js';
const id='11111111-1111-4111-8111-111111111111';
const actor={email:'auditor@example.test',role:'super_admin',userId:'22222222-2222-4222-8222-222222222222'};
test('only auditor may hide or restore an existing exact conversation',async()=>{
 const calls=[];const repo={getConversation:async x=>x===id?{id}:null,setTestVisibility:async(...a)=>{calls.push(a);return true;}};
 const s=createCrmAdminService({repository:repo,resolvePermissions:({role})=>({canAudit:role==='super_admin',canOperate:role==='operator'})});
 await assert.rejects(()=>s.setTestVisibility({...actor,role:'operator',id,hide:true,expectedVersion:0}),e=>e.status===403);
 await assert.rejects(()=>s.setTestVisibility({...actor,id,hide:true}),e=>e.status===400);
 assert.equal((await s.setTestVisibility({...actor,id,hide:true,expectedVersion:0})).changed,true);
 assert.deepEqual(calls,[[id,true,actor.userId,0]]);
 await s.setTestVisibility({...actor,id,hide:false});assert.equal(calls[1][1],false);
});
test('hidden listing requires audit and database filters visibility before limiting',async()=>{
 const calls=[];const b={select(){return this},order(){return this},limit(){return this},is(...a){calls.push(['is',...a]);return this},not(...a){calls.push(['not',...a]);return this},then(resolve){resolve({data:[],error:null})}};
 const r=createSupabaseCrmRepository({from:()=>b});await r.listConversations();await r.listConversations({hiddenOnly:true});
 assert.deepEqual(calls,[['is','test_hidden_at',null],['not','test_hidden_at','is',null]]);
 const s=createCrmAdminService({repository:r,resolvePermissions:({role})=>({canAudit:role==='super_admin',canOperate:role==='operator'})});
 await assert.rejects(()=>s.listInbox({...actor,role:'operator',filters:{hiddenOnly:true}}),e=>e.status===403);
});
