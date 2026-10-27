import {test} from 'node:test';import assert from 'node:assert/strict';import {createCommercialTeamMedia} from './crmCommercialTeamMedia.js';
test('commercial media requires membership before fetch and after reassignment',async()=>{
 let allowed=false,version=0,fetches=0;
 const retrieve=createCommercialTeamMedia({guard:async()=>allowed?{conversationId:'c',version}:null,fetchMemberMedia:async()=>{fetches++;return{buffer:Buffer.from('data')}}});
 const req={actor:{id:'a'},caseId:'c1',eventId:'e1'};
 await assert.rejects(retrieve(req),{status:404});assert.equal(fetches,0);
 allowed=true;assert.equal((await retrieve(req)).buffer.toString(),'data');
 const changing=createCommercialTeamMedia({guard:async()=>({conversationId:'c',version}),fetchMemberMedia:async()=>{version++;return{buffer:Buffer.from('private')}}});
 await assert.rejects(changing(req),{status:404});
});
