import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createCommercialTeamApi} from './crmCommercialTeamApi.js';
const actor={id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',email:'advisor@example.com'},conv='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',caseId='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
function fixture({channel='whatsapp',allowed=true,role='advisor',calls=[]}={}){
 const reads=[],queries=[];
 const db={from(table){const q={select(){return q},eq(key,value){queries.push({table,key,value});return q},in(){return q},async maybeSingle(){return {data:table==='crm_conversations'?{id:conv,source_channel:channel}:{id:caseId}}}};return q;},async rpc(name,args){reads.push({name,args});return {data:name==='crm_commercial_team_role'?role:name==='crm_commercial_team_calls_list'?calls:allowed?{id:args.p_case||args.p_id,version:2}:null};}};
 return {api:createCommercialTeamApi({db,sendClaimed:async()=>{},resolveTrustedSuperadmin:async()=>false}),reads,queries};
}
test('resolves WhatsApp relationship and authorizes case before exposing its identifier',async()=>{
 const {api,reads,queries}=fixture();const result=await api.resolveConversation(actor,conv);
 assert.equal(result.id,caseId);assert.equal(result.channel,'whatsapp');assert.deepEqual(reads.find(r=>r.name==='crm_commercial_team_case_read'),{name:'crm_commercial_team_case_read',args:{p_actor:actor.id,p_superadmin:false,p_case:caseId}});
 assert.ok(queries.some(q=>q.table==='crm_commercial_cases'&&q.key==='conversation_id'&&q.value===conv));
});
test('forms use conversation id and do not match cases by contact',async()=>{
 const {api,reads}=fixture({channel:'email'});const result=await api.resolveConversation(actor,conv);assert.equal(result.channel,'form');assert.equal(result.id,conv);assert.equal(reads.find(r=>r.name==='crm_commercial_team_form_read').name,'crm_commercial_team_form_read');
});
test('another advisor cannot resolve a case outside server scope',async()=>{
 const {api}=fixture({allowed:false});await assert.rejects(api.resolveConversation(actor,conv),{status:404});
});
test('denied role is checked before any case lookup',async()=>{
 const {api,queries}=fixture({role:'none'});await assert.rejects(api.resolveConversation(actor,conv),{status:403});assert.equal(queries.length,0);
});
test('cannot advance or close without a completed summary',async()=>{
 const {api,reads}=fixture();await assert.rejects(api.progress(actor,'form',conv,2,'en_espera','Contactar mañana'),{status:409,code:'CALL_SUMMARY_REQUIRED'});assert.ok(!reads.some(r=>r.name==='crm_commercial_team_progress'));
});
test('requires next action and allows state after completed summary',async()=>{
 const {api,reads}=fixture({calls:[{status:'completed'}]});await assert.rejects(api.progress(actor,'form',conv,2,'cerrado',''),{status:400,code:'NEXT_STEP_REQUIRED'});
 await api.progress(actor,'form',conv,2,'en_espera','Contactar mañana');assert.equal(reads.at(-1).name,'crm_commercial_team_progress');
});

test('historical WhatsApp detail retains stored progress through authorized list projection',async()=>{
 const db={async rpc(name){if(name==='crm_commercial_team_role')return{data:'manager'};if(name==='crm_commercial_team_case_read')return{data:{id:caseId,version:2}};if(name==='crm_commercial_team_case_list')return{data:[{id:caseId,progressState:'en_espera',nextStep:'Llamar mañana'}]};return{data:null};}};
 const api=createCommercialTeamApi({db,sendClaimed:async()=>{},resolveTrustedSuperadmin:async()=>true});
 assert.deepEqual(await api.read(actor,'whatsapp',caseId),{id:caseId,version:2,progressState:'en_espera',nextStep:'Llamar mañana',nextContactAt:null,reminderHours:[24,8],closureOutcome:null,sourceOrigin:'whatsapp:1376102838911694',sourceLabel:'WhatsApp'});
});
