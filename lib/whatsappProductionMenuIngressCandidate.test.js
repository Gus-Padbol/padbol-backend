import test from 'node:test';
import assert from 'node:assert/strict';
import {createProductionMenuIngressCandidate} from './whatsappProductionMenuIngressCandidate.js';
const channel={id:'c',tenant_id:'t',active:true,meta_phone_number_id:'123456',meta_waba_id:'987654'};
const input={channel,inbound:{providerMessageId:'wamid.test',body:'Hola'},inboundRow:{id:'i',provider_message_id:'wamid.test'}};
test('passes original content, stable key and only dispatches committed outbox',async()=>{
 let inputs=[], sends=[]; const run=createProductionMenuIngressCandidate({phoneNumberId:'123456',wabaId:'987654',menu:{async ingestWhatsapp(x){inputs.push(x);return{outboxId:'o'}}},dispatcher:{async dispatch(id){sends.push(id)}}});
 assert.deepEqual(await run(input),{suppressAutomaticReply:true});await run(input);
 assert.equal(inputs[0].body,'Hola');assert.equal(inputs[0].menuDelivery.inboundId,'i');assert.match(inputs[0].menuDelivery.idempotencyKey,/^[a-f0-9]{64}$/);assert.equal(inputs[0].menuDelivery.idempotencyKey,inputs[1].menuDelivery.idempotencyKey);assert.deepEqual(sends,['o','o']);
});
test('rejects mismatched channels and fails closed',async()=>{
 let calls=0;const run=createProductionMenuIngressCandidate({phoneNumberId:'123456',wabaId:'987654',menu:{async ingestWhatsapp(){calls++}},dispatcher:{async dispatch(){calls++}}});
 await assert.rejects(run({...input,channel:{...channel,meta_waba_id:'wrong'}}),/CHANNEL_MISMATCH/);assert.equal(calls,0);
});
test('no outbox means no send',async()=>{
 let sends=0;const run=createProductionMenuIngressCandidate({phoneNumberId:'123456',wabaId:'987654',menu:{async ingestWhatsapp(){return{outboxId:null}}},dispatcher:{async dispatch(){sends++}}});
 await run(input);assert.equal(sends,0);
});


test('unmatched channel is preserved by the CRM fallback without automatic sending',async()=>{
 let preserved, sends=0;const run=createProductionMenuIngressCandidate({phoneNumberId:'123456',wabaId:'987654',menu:{async ingestWhatsapp(){throw Error('must not run')}},dispatcher:{async dispatch(){sends++}},fallback:async x=>{preserved=x}});
 assert.deepEqual(await run({...input,channel:{...channel,meta_waba_id:'other'}}),{suppressAutomaticReply:true});assert.equal(preserved.body,'Hola');assert.equal(sends,0);
});
