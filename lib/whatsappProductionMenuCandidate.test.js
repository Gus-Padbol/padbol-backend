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
test('unreviewed English is not activated by QA flag in production',async()=>{
 const conversation={id:'c',updated_at:'2026-10-22T12:00:00.000Z',qualification_data:{}};
 let commit;
 const menu=createProductionMenuCandidate({enabled:true,env,crmService:{async ingestInbound(){return {status:'accepted',conversation}}},atomicMenuStore:{async findByInbound(){return null},async commit(value){commit=value;return {outbox_id:'synthetic'}}}});
 await menu.ingestWhatsapp({providerMessageId:'synthetic',fromWaId:'15551230000',phoneNumberId:'1376102838911694',body:'English',menuDelivery:{inboundId:'synthetic',idempotencyKey:'a'.repeat(64)}});
 assert.doesNotMatch(commit.response,/Idioma \/ Language/);
 assert.equal(commit.state.qualification_data.whatsapp_menu.language,'es');
});
