import assert from 'node:assert/strict';
import test from 'node:test';
import { dispatchProspectMessage } from './crmProspectDispatch.js';

function makeDb(initialStatus='queued') {
  const state={message:{id:'m1',campaign_id:'c1',prospect_id:'p1',status:initialStatus,prospect:{id:'p1',status:'verified',email:'p@example.test',crm_contact_id:null,crm_conversation_id:null}}, campaigns:[{id:'c1',status:'approved'}], suppressions:[], conversations:[], replies:[], cases:[], messages:[]};
  const table=name=>{
    let filters={}; let update=null;
    const q={};
    for (const method of ['select','neq','in','or','order','limit']) q[method]=()=>q;
    q.eq=(key,value)=>{filters[key]=value;return q};
    q.update=(payload)=>{update=payload;return q};
    q.maybeSingle=async()=>{
      if(name==='crm_prospect_messages' && update){
        const current=state.message;
        if(filters.id && String(current.id)!==String(filters.id)) return {data:null,error:null};
        if(filters.status && String(current.status)!==String(filters.status)) return {data:null,error:null};
        Object.assign(current,update); return {data:{...current},error:null};
      }
      if(name==='crm_prospect_messages') return {data:state.message,error:null};
      if(name==='crm_prospect_campaigns') return {data:state.campaigns[0]||null,error:null};
      return {data:null,error:null};
    };
    q.then=(resolve,reject)=>Promise.resolve((()=>{
      if(name==='crm_prospect_messages') {
        if(update && filters.id && String(state.message.id)===String(filters.id)) Object.assign(state.message,update);
        if(filters.id) return state.message;
        return state.messages;
      }
      if(name==='crm_prospect_campaigns') return state.campaigns;
      if(name==='crm_prospect_suppressions') return state.suppressions;
      if(name==='crm_conversations') return state.conversations;
      if(name==='crm_replies') return state.replies;
      if(name==='crm_commercial_cases') return state.cases;
      return [];
    })()).then(resolve,reject);
    return q;
  };
  return {from:table,state};
}

test('simulation/disabled dispatch never calls the provider', async()=>{
 let sends=0; const db=makeDb(); const result=await dispatchProspectMessage({db,messageId:'m1',enabled:false,send:async()=>{sends++;return{providerMessageId:'x'}}});
 assert.equal(result.status,'disabled');assert.equal(sends,0);assert.equal(db.state.message.status,'queued');
});
test('two concurrent claims produce one send', async()=>{
 const db=makeDb();let sends=0;const send=async()=>{sends++;await new Promise(r=>setTimeout(r,10));return{providerMessageId:'provider-1'}};
 const [a,b]=await Promise.all([dispatchProspectMessage({db,messageId:'m1',enabled:true,send}),dispatchProspectMessage({db,messageId:'m1',enabled:true,send})]);
 assert.equal(sends,1);assert.deepEqual([a.status,b.status].sort(),['not_queued','sent']);assert.equal(db.state.message.status,'sent');
});
test('uncertain provider result is recorded and is not retried implicitly', async()=>{
 const db=makeDb();let sends=0;const result=await dispatchProspectMessage({db,messageId:'m1',enabled:true,send:async()=>{sends++;throw new Error('timeout')}});
 assert.equal(result.status,'uncertain');assert.equal(db.state.message.status,'uncertain');
 const retry=await dispatchProspectMessage({db,messageId:'m1',enabled:true,send:async()=>{sends++;return{providerMessageId:'x'}}});
 assert.equal(retry.status,'not_queued');assert.equal(sends,1);
});
