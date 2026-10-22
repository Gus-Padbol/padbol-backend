import assert from 'node:assert/strict';
import test from 'node:test';
import {createProductionMenuCandidate} from './whatsappProductionMenuCandidate.js';
const env={BACKEND_RUNTIME_MODE:'production',CRM_WHATSAPP_ENGLISH_MENU_QA_PREVIEW:'true'};
test('English pilot is limited to the exact configured number and keeps handoff context',async()=>{
 const conversation={id:'c',updated_at:'2026-10-22T12:00:00.000Z',estado:'nuevo',operador:null,derivado:false,handoff_ready:false,
   funnel_state:'whatsapp_menu_selected',selected_path:null,qualification_status:'needs_review',next_step:'advisor_handoff',
   qualification_data:{whatsapp_menu:{stage:'selected',language:null,humanLanguage:'en',initialMessage:'Hello'}}};
 const events=new Map();let count=0,last;
 const store={async findByInbound(id){return events.get(id)||null},async commit(v){count++;last=v;const e={conversation_id:'c',outbox_id:'out'};events.set(v.inboundId,e);return e}};
 const menu=createProductionMenuCandidate({enabled:true,env:{...env,CRM_WHATSAPP_ENGLISH_PILOT_PHONE:'15551234567'},crmService:{async ingestInbound(){return {status:'accepted',conversation}}},atomicMenuStore:store});
 const input={providerMessageId:'event',fromWaId:'15551234567',body:'Hello',menuDelivery:{inboundId:'id',idempotencyKey:'a'.repeat(64)}};
 assert.equal((await menu.ingestWhatsapp(input)).outboxId,'out');
 assert.match(last.response,/Welcome to Padbol/);
 assert.equal(last.state.qualification_data.whatsapp_menu.initialMessage,'Hello');
 assert.equal(last.state.next_step,'advisor_handoff');
 await menu.ingestWhatsapp(input);assert.equal(count,1);
 const other={...input,fromWaId:'15551234568',menuDelivery:{...input.menuDelivery,inboundId:'other'}};
 const output=await menu.ingestWhatsapp(other);assert.equal(output.suppressAutomaticReply,true);assert.equal(count,1);
});
test('English pilot rejects an invalid configured number',()=>{
 assert.throws(()=>createProductionMenuCandidate({enabled:true,env:{...env,CRM_WHATSAPP_ENGLISH_PILOT_PHONE:'6456'},crmService:{ingestInbound(){}},atomicMenuStore:{findByInbound(){},commit(){}}}),/PILOT_NUMBER_INVALID/);
});
test('English pilot opens English menu for a fresh conversation without changing others',async()=>{
 let commit; const conversation={id:'c',updated_at:'2026-10-22T12:00:00.000Z',qualification_data:{}};
 const menu=createProductionMenuCandidate({enabled:true,env:{...env,CRM_WHATSAPP_ENGLISH_PILOT_PHONE:'15551234567'},crmService:{async ingestInbound(){return {status:'accepted',conversation}}},atomicMenuStore:{async findByInbound(){return null},async commit(value){commit=value;return {outbox_id:'out'}}}});
 await menu.ingestWhatsapp({providerMessageId:'event',fromWaId:'15551234567',body:'Hello',menuDelivery:{inboundId:'id',idempotencyKey:'a'.repeat(64)}});
 assert.equal(commit.state.qualification_data.whatsapp_menu.language,'en');
 assert.match(commit.response,/Welcome to Padbol/);
});
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
 const conversation={id:'c',updated_at:'2026-10-22T12:00:00.000Z',selected_path:'sede',qualification_question_count:2,qualification_data:{whatsapp_menu:{stage:'details',language:'es',topic:'sede',initialMessage:'Quiero abrir un club'}}};
 let commit;
 const menu=createProductionMenuCandidate({enabled:true,env,crmService:{async ingestInbound(){return {status:'accepted',conversation}}},atomicMenuStore:{async findByInbound(){return null},async commit(value){commit=value;return {outbox_id:null}}}});
 await menu.ingestWhatsapp({providerMessageId:'synthetic',fromWaId:'15551230000',phoneNumberId:'1376102838911694',body:'Language: English',menuDelivery:{inboundId:'synthetic',idempotencyKey:'a'.repeat(64)}});
 assert.equal(commit.response,null);
 assert.equal(commit.state.qualification_data.whatsapp_menu.initialMessage,'Quiero abrir un club');
 assert.equal(commit.state.qualification_data.whatsapp_menu.topic,'sede');
 assert.equal(commit.state.qualification_data.whatsapp_menu.humanLanguage,'en');
 assert.equal(commit.state.selected_path,'sede');
 assert.equal(commit.state.qualification_question_count,2);
});
