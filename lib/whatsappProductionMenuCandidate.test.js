import assert from 'node:assert/strict';
import test from 'node:test';
import {createProductionMenuCandidate} from './whatsappProductionMenuCandidate.js';
const env={BACKEND_RUNTIME_MODE:'production'};
function fixture(conversation={id:'c',updated_at:'2026-10-22T12:00:00.000Z',qualification_data:{}}) {
 const commits=[], events=new Map();
 const menu=createProductionMenuCandidate({enabled:true,env,crmService:{async ingestInbound(){return {status:'accepted',conversation}}},atomicMenuStore:{async findByInbound(id){return events.get(id)||null},async commit(value){commits.push(value);const result={outbox_id:'out',conversation_id:'c'};events.set(value.inboundId,result);return result}}});
 const send=body=>menu.ingestWhatsapp({providerMessageId:'event',fromWaId:'15551230000',body,menuDelivery:{inboundId:'event',idempotencyKey:'a'.repeat(64)}});
 return {commits,send};
}
test('production candidate requires atomic persistence',async()=>{
 assert.equal(createProductionMenuCandidate(),null);
 assert.throws(()=>createProductionMenuCandidate({enabled:true,env}),/CONFIGURATION_INVALID/);
 const f=fixture(); await assert.rejects(()=>createProductionMenuCandidate({enabled:true,env,crmService:{ingestInbound(){}},atomicMenuStore:{findByInbound(){},commit(){}}}).ingestWhatsapp({body:'hola'}),/ATOMIC_REQUIRED/);
});
for (const text of ['Hello','Hi!','good afternoon','English','2']) test(`English selection ${text} gives English menu`,async()=>{
 const f=fixture();await f.send(text);assert.equal(f.commits[0].state.qualification_data.whatsapp_menu.language,'en');assert.match(f.commits[0].response,/Welcome to Padbol/);
});
test('English inquiry retains the original and proposes its topic',async()=>{
 const f=fixture();await f.send('I want to open a court in Miami');const c=f.commits[0];assert.equal(c.state.qualification_data.whatsapp_menu.language,'en');assert.equal(c.state.qualification_data.whatsapp_menu.initialMessage,'I want to open a court in Miami');assert.match(c.response,/inquiry/i);
});
test('Spanish inquiry retains the original and proposes its topic',async()=>{
 const f=fixture();await f.send('Quiero abrir una cancha');const c=f.commits[0];assert.equal(c.state.qualification_data.whatsapp_menu.language,'es');assert.equal(c.state.qualification_data.whatsapp_menu.initialMessage,'Quiero abrir una cancha');assert.match(c.response,/consulta/i);
});
test('ambiguous message offers Spanish and English without dropping text',async()=>{
 const f=fixture();await f.send('Padbol');const c=f.commits[0];assert.equal(c.state.qualification_data.whatsapp_menu.initialMessage,'Padbol');assert.match(c.response,/Español/);assert.match(c.response,/English/);
});
test('replayed input does not queue a duplicate',async()=>{
 const f=fixture();await f.send('Hello');await f.send('Hello');assert.equal(f.commits.length,1);
});
test('existing human handoff keeps initial context',async()=>{
 const c={id:'c',updated_at:'2026-10-22T12:00:00.000Z',estado:'nuevo',operador:null,derivado:false,handoff_ready:false,funnel_state:'whatsapp_menu_selected',qualification_status:'needs_review',next_step:'advisor_handoff',qualification_data:{whatsapp_menu:{stage:'selected',language:null,humanLanguage:'en',initialMessage:'Hello'}}};
 const f=fixture(c);await f.send('Hello');assert.match(f.commits[0].response,/Welcome to Padbol/);assert.equal(f.commits[0].state.qualification_data.whatsapp_menu.initialMessage,'Hello');assert.equal(f.commits[0].state.next_step,'advisor_handoff');
});
test('Spanish greeting receives Spanish menu',async()=>{const f=fixture();await f.send('Hola');assert.match(f.commits[0].response,/consultar/i)});
