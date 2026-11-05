import assert from 'node:assert/strict';
import test from 'node:test';
import {prospectFollowupEligibility} from './crmProspectFollowupGuard.js';

function chain(rows) {
  const q = {};
  for (const name of ['select','eq','neq','in','or','limit','order']) q[name] = () => q;
  q.maybeSingle = async () => ({data: rows[0] || null, error: null});
  q.then = (resolve, reject) => Promise.resolve({data: rows, error: null}).then(resolve, reject);
  return q;
}
function db(tables={}) { return {from(name){return chain(tables[name] || []);}}; }
const prospect={id:'p1',email:'p@example.test',phone:null,domain:null,crm_contact_id:'c1',crm_conversation_id:'v1',status:'verified',contact_block_reason:null};
const message={id:'m1',campaign_id:'camp1',status:'queued'};
const base={crm_prospect_campaigns:[{id:'camp1',status:'approved'}],crm_prospect_suppressions:[],crm_conversations:[],crm_replies:[],crm_commercial_cases:[],crm_prospect_messages:[]};

test('eligible prospect with no intervention is allowed',async()=>{
 const result=await prospectFollowupEligibility({db:db(base),prospect,message});
 assert.equal(result.allowed,true);
});
test('active manual conversation blocks even when prospect status is verified',async()=>{
 const tables={...base,crm_conversations:[{id:'v1',estado:'en_atencion',operador:'Nico'}]};
 const result=await prospectFollowupEligibility({db:db(tables),prospect,message});
 assert.equal(result.allowed,false);assert.equal(result.code,'ACTIVE_CONVERSATION');
});
test('permanent bounce or opt-out suppression blocks',async()=>{
 const tables={...base,crm_prospect_suppressions:[{reason:'bounce'}]};
 const result=await prospectFollowupEligibility({db:db(tables),prospect,message});
 assert.equal(result.allowed,false);assert.equal(result.code,'SUPPRESSED');
});
test('pending reply and another sequence block queued messages',async()=>{
 for(const [tables,code] of [[{...base,crm_replies:[{id:'r1'}]},'PENDING_REPLY'],[{...base,crm_prospect_messages:[{id:'m2',campaign_id:'camp2'}]},'OTHER_SEQUENCE_ACTIVE']]) {
  const result=await prospectFollowupEligibility({db:db(tables),prospect,message});assert.equal(result.allowed,false);assert.equal(result.code,code);
 }
});
test('paused or stopped prospect/campaign blocks',async()=>{
 let result=await prospectFollowupEligibility({db:db({...base,crm_prospect_campaigns:[{id:'camp1',status:'paused'}]}),prospect,message});assert.equal(result.code,'CAMPAIGN_NOT_ACTIVE');
 result=await prospectFollowupEligibility({db:db(base),prospect:{...prospect,status:'rejected'},message});assert.equal(result.code,'PROSPECT_STOPPED');
});
