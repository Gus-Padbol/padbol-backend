import assert from 'node:assert/strict';
import test from 'node:test';
import {createProductionMenuCandidate} from './whatsappProductionMenuCandidate.js';
const env={BACKEND_RUNTIME_MODE:'production',CRM_WHATSAPP_ENGLISH_MENU_QA_PREVIEW:'true'};
test('production candidate is inert unless explicitly enabled with a durable store',async()=>{
 assert.equal(createProductionMenuCandidate(),null);
 assert.throws(()=>createProductionMenuCandidate({enabled:true,env}),/CONFIGURATION_INVALID/);
 const menu=createProductionMenuCandidate({enabled:true,env,crmService:{async ingestInbound(){throw Error('must not persist')}},atomicMenuStore:{async findByInbound(){},async commit(){}}});
 await assert.rejects(()=>menu.ingestWhatsapp({body:'hola'}),/ATOMIC_REQUIRED/);
});
for (const original of ['English', 'Hi!', 'Hello', 'I want to open a court in Miami']) test(`English request ${original} is retained for human review without an unreviewed response`,async()=>{
 const conversation={id:'c',updated_at:'2026-10-22T12:00:00.000Z',qualification_data:{}};
 let commit;
 const menu=createProductionMenuCandidate({enabled:true,env,crmService:{async ingestInbound(){return {status:'accepted',conversation}}},atomicMenuStore:{async findByInbound(){return null},async commit(value){commit=value;return {outbox_id:'synthetic'}}}});
 await menu.ingestWhatsapp({providerMessageId:'synthetic',fromWaId:'15551230000',phoneNumberId:'1376102838911694',body:original,menuDelivery:{inboundId:'synthetic',idempotencyKey:'a'.repeat(64)}});
 assert.equal(commit.response,null);
 assert.equal(commit.state.qualification_data.whatsapp_menu.humanLanguage,'en');
 assert.equal(commit.state.qualification_data.whatsapp_menu.initialMessage,original);
 assert.equal(commit.state.qualification_status,'needs_review');
 assert.equal(commit.state.next_step,'advisor_handoff');
});
test('Spanish greeting still receives the Spanish menu',async()=>{
 const conversation={id:'c',updated_at:'2026-10-22T12:00:00.000Z',qualification_data:{}};
 let commit;
 const menu=createProductionMenuCandidate({enabled:true,env,crmService:{async ingestInbound(){return {status:'accepted',conversation}}},atomicMenuStore:{async findByInbound(){return null},async commit(value){commit=value;return {outbox_id:'synthetic'}}}});
 await menu.ingestWhatsapp({providerMessageId:'synthetic',fromWaId:'15551230000',phoneNumberId:'1376102838911694',body:'Hola',menuDelivery:{inboundId:'synthetic',idempotencyKey:'a'.repeat(64)}});
 assert.equal(commit.state.qualification_data.whatsapp_menu.language,'es');
 assert.match(commit.response,/consultar/i);
});
test('later English request preserves the original intent and topic',async()=>{
 const conversation={id:'c',updated_at:'2026-10-22T12:00:00.000Z',qualification_data:{whatsapp_menu:{stage:'details',language:'es',topic:'sede',initialMessage:'Quiero abrir un club'}}};
 let commit;
 const menu=createProductionMenuCandidate({enabled:true,env,crmService:{async ingestInbound(){return {status:'accepted',conversation}}},atomicMenuStore:{async findByInbound(){return null},async commit(value){commit=value;return {outbox_id:null}}}});
 await menu.ingestWhatsapp({providerMessageId:'synthetic',fromWaId:'15551230000',phoneNumberId:'1376102838911694',body:'Language: English',menuDelivery:{inboundId:'synthetic',idempotencyKey:'a'.repeat(64)}});
 assert.equal(commit.response,null);
 assert.equal(commit.state.qualification_data.whatsapp_menu.initialMessage,'Quiero abrir un club');
 assert.equal(commit.state.qualification_data.whatsapp_menu.topic,'sede');
 assert.equal(commit.state.qualification_data.whatsapp_menu.humanLanguage,'en');
});
