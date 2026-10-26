import test from 'node:test';import assert from 'node:assert/strict';import {createWelcomeRepositoryCandidate} from './crmWelcomeRepositoryCandidate.js';
test('claim uses server-side RPC with consent-bound phone and version; revocation invalidates read',async()=>{
 let accepted=true,rpcArgs;const consent={get accepted(){return accepted},purpose:'consultation_followup',phone:'+5492213032019',language:'es',version:'v1',acceptedAt:'today'};
 const db={from:()=>({select:()=>({eq:()=>({maybeSingle:async()=>({data:{contact:{nombre:'G'},qualification_data:{whatsapp_contact_consent:consent}}})})})}),rpc:async(name,args)=>{rpcArgs={name,args};return {data:{status:'claimed'}}}};
 const repo=createWelcomeRepositoryCandidate(db);assert.equal(await repo.consentStillValid({sourceId:'id',phone:consent.phone,consentVersion:'v1'}),true);
 assert.equal((await repo.claimOnce({sourceId:'id',phone:consent.phone,consentVersion:'v1'})).acquired,true);assert.equal(rpcArgs.args.p_phone,consent.phone);
 accepted=false;assert.equal(await repo.consentStillValid({sourceId:'id',phone:consent.phone,consentVersion:'v1'}),false);
});
