import test from 'node:test';
import assert from 'node:assert/strict';
import { createCrmAdminService } from './crmAdmin.js';
import { createSupabaseCrmRepository } from './crmService.js';

test('history requires conversation access and limits scope to WhatsApp', async () => {
  let reads=0;
  const svc=createCrmAdminService({repository:{getConversation:async id=>({id,source_channel:id==='wa'?'whatsapp':'email'}),listWhatsappHistory:async()=>{reads++;return {messages:[]};}},resolvePermissions:({role})=>({canAudit:role==='admin',canOperate:false})});
  await assert.rejects(()=>svc.getWhatsappHistory({id:'wa',role:'other'}),{status:403});
  await assert.rejects(()=>svc.getWhatsappHistory({id:'email',role:'admin'}),{status:404});
  assert.equal(reads,0);
  assert.deepEqual(await svc.getWhatsappHistory({id:'wa',role:'admin'}),{messages:[]});
  assert.equal(reads,1);
});
test('history fetches only the specified conversation and sorts incoming and outgoing without private metadata', async () => {
  const calls=[];
  const supabase={from(table){const filters=[];const b={select(fields){calls.push([table,'select',fields]);return this;},eq(key,value){filters.push([key,value]);return this;},order(){return this;},limit(){calls.push([table,'filters',filters]);return Promise.resolve({data:table==='crm_inbound_events'?[{id:'b',body:'hola',received_at:'2026-10-21T10:00:00Z'}]:[{id:'c',body:'respuesta',status:'sent',created_at:'2026-10-21T11:00:00Z'}]});}};return b;}};
  const history=await createSupabaseCrmRepository(supabase).listWhatsappHistory('conversation-fixture');
  assert.deepEqual(history.messages.map(x=>x.direction),['inbound','outbound']);
  assert.equal(history.messages[1].status,'sent');
  assert.ok(calls.filter(c=>c[1]==='filters').every(c=>c[2].some(([k,v])=>k==='conversation_id'&&v==='conversation-fixture')));
  assert.ok(calls.filter(c=>c[1]==='select').every(c=>!c[2].includes('*')));
});
