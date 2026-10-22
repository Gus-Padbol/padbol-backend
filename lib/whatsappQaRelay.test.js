import { createHmac } from 'node:crypto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createQaRelay, registerQaRelayReceiver, RELAY_PATH } from './whatsappQaRelay.js';
const secret='test-signing-secret';
const qa={WHATSAPP_QA_RELAY_ENABLED:'true',WHATSAPP_QA_MENU_TEST_RECIPIENT:'5492213032019',BACKEND_RUNTIME_MODE:'staging',RENDER_SERVICE_ID:'srv-dahbs0dbedkc73a0kf4g',STAGING_SUPABASE_PROJECT_REF:'vxikhdulhuvghfqeutnp',SUPABASE_URL:'https://vxikhdulhuvghfqeutnp.supabase.co',WHATSAPP_META_QA_RESUBSCRIBE_ONCE:'false',WHATSAPP_META_APP_SECRET:secret};
const prod={WHATSAPP_QA_RELAY_RECEIVE_ENABLED:'true',BACKEND_RUNTIME_MODE:'production',RENDER_SERVICE_ID:'srv-d7brh3ea2pns73equ2ug',SUPABASE_URL:'https://vpldffhsxhgnmitiikof.supabase.co',WHATSAPP_META_APP_SECRET:secret};
const payload={object:'whatsapp_business_account',entry:[{id:'928900479733370',changes:['1376102838911694','999999999'].map(phone=>({field:'messages',value:{metadata:{phone_number_id:phone}}}))}]};
const rawBody=Buffer.from(JSON.stringify(payload));
const signature='sha256='+createHmac('sha256',secret).update(rawBody).digest('hex');
const now=()=>1761000000000; const timestamp=String(now()/1000); const relaySignature=body=>createHmac('sha256',secret).update('padbol-qa-to-prod-v1\n').update(timestamp).update('\n').update(body).digest('hex');
test('relay is disabled by default and enforces QA identity and disabled resubscription',()=>{assert.equal(createQaRelay({env:{}}),null);assert.throws(()=>createQaRelay({env:{...qa,RENDER_SERVICE_ID:'wrong'}}));assert.throws(()=>createQaRelay({env:{...qa,WHATSAPP_META_QA_RESUBSCRIBE_ONCE:'true'}}));});
test('authenticates filtered target only and prevents transmitting mixed-number data',async()=>{let calls=0;const send=createQaRelay({env:qa,now,fetchImpl:async(url,opts)=>{calls++;assert.equal(url,`https://padbol-backend.onrender.com${RELAY_PATH}`);const body=JSON.parse(opts.body);assert.equal(body.entry[0].changes.length,1);assert.equal(body.entry[0].changes[0].value.metadata.phone_number_id,'1376102838911694');assert.equal(opts.headers['x-padbol-relay-timestamp'],timestamp);assert.equal(opts.headers['x-padbol-relay-signature'],relaySignature(opts.body));assert.equal(opts.redirect,'error');return {ok:true}}});assert.deepEqual(await send({rawBody,signature}),{forwarded:true});assert.equal(calls,1);await assert.rejects(()=>send({rawBody,signature:'invalid'}));assert.equal(calls,1);});
test('unrelated numbers do not forward and delivery errors propagate for retry',async()=>{const send=createQaRelay({env:qa,fetchImpl:async()=>({ok:false})});const other=Buffer.from(JSON.stringify({...payload,entry:[]}));const otherSignature='sha256='+createHmac('sha256',secret).update(other).digest('hex');assert.deepEqual(await send({rawBody:other,signature:otherSignature}),{forwarded:false});await assert.rejects(()=>send({rawBody,signature}),e=>e.status===503);});
test('receiver verifies original signature and filters unrelated numbers after verification',async()=>{let route,seen;const app={post:(p,fn)=>{assert.equal(p,RELAY_PATH);route=fn}};registerQaRelayReceiver(app,{env:prod,now,whatsappService:{handleWebhook:async p=>{seen=p;return {received:1}}}});const res={status(n){this.code=n;return this},json(x){this.data=x;return this}};await route({rawBody,headers:{'x-padbol-relay-timestamp':timestamp,'x-padbol-relay-signature':relaySignature(rawBody)}},res);assert.equal(res.code,200);assert.equal(seen.entry[0].changes.length,1);assert.equal(seen.entry[0].changes[0].value.metadata.phone_number_id,'1376102838911694');seen=null;await route({rawBody,headers:{'x-padbol-relay-timestamp':timestamp,'x-padbol-relay-signature':'invalid'}},res);assert.equal(res.code,401);assert.equal(seen,null);});
test('receiver returns retryable failure when CRM persistence fails',async()=>{let route;registerQaRelayReceiver({post:(_,f)=>route=f},{env:prod,now,whatsappService:{handleWebhook:async()=>{throw Error('failure')}}});const res={status(n){this.code=n;return this},json(){return this}};await route({rawBody,headers:{'x-padbol-relay-timestamp':timestamp,'x-padbol-relay-signature':relaySignature(rawBody)}},res);assert.equal(res.code,503);});
test('bridge rejects expired or modified authenticated payloads',async()=>{let route,calls=0;registerQaRelayReceiver({post:(_,f)=>route=f},{env:prod,now:()=>now()+301000,whatsappService:{handleWebhook:async()=>{calls++}}});const res={status(n){this.code=n;return this},json(){return this}};await route({rawBody,headers:{'x-padbol-relay-timestamp':timestamp,'x-padbol-relay-signature':relaySignature(rawBody)}},res);assert.equal(res.code,401);assert.equal(calls,0);});
test('another WABA with the target phone is not relayed',async()=>{const data=Buffer.from(JSON.stringify({...payload,entry:[{...payload.entry[0],id:'000000000000000'}]}));const sig='sha256='+createHmac('sha256',secret).update(data).digest('hex');let calls=0;const send=createQaRelay({env:qa,fetchImpl:async()=>{calls++;return {ok:true}}});assert.deepEqual(await send({rawBody:data,signature:sig}),{forwarded:false});assert.equal(calls,0);});

test('relay valida correspondencia completa y única de referencias en lotes',async()=>{
  const p={object:'whatsapp_business_account',entry:[{id:'928900479733370',changes:[{field:'messages',value:{metadata:{phone_number_id:'1376102838911694'},messages:['wamid.A','wamid.B'].map(id=>({id,from:'5492213032019',type:'text',text:{body:'Hola'}}))}}]}]};
  const raw=Buffer.from(JSON.stringify(p));const sig='sha256='+createHmac('sha256',secret).update(raw).digest('hex');
  let entries=[{providerMessageId:'wamid.A',reference:'PB-11111111111141118111111111111111'},{providerMessageId:'wamid.B',reference:'PB-22222222222242228222222222222222'}];
  const relay=createQaRelay({env:{...qa,WHATSAPP_QA_RELAY_TICKET_REFERENCES_ENABLED:'true'},fetchImpl:async()=>({ok:true,json:async()=>({ok:true,references:entries})})});
  const result=await relay({rawBody:raw,signature:sig});assert.equal(result.references.get('wamid.B'),entries[1].reference);
  entries=entries.slice(0,1);await assert.rejects(()=>relay({rawBody:raw,signature:sig}));
  entries=[entries[0],entries[0]];await assert.rejects(()=>relay({rawBody:raw,signature:sig}));
});

test('relay accepts large batches and ignores malformed and repeated inbound messages',async()=>{
  const good=Array.from({length:75},(_,i)=>({id:`wamid.${i}`,from:'5492213032019',type:'text',text:{body:'Hola'}}));
  const p={object:'whatsapp_business_account',entry:[{id:'928900479733370',changes:[{field:'messages',value:{metadata:{phone_number_id:'1376102838911694'},messages:[...good,good[0],{id:'bad',from:'invalid',type:'text',text:{body:'Hola'}}]}}]}]};
  const raw=Buffer.from(JSON.stringify(p));const sig='sha256='+createHmac('sha256',secret).update(raw).digest('hex');
  const refs=good.map(m=>({providerMessageId:m.id,reference:'PB-11111111111141118111111111111111'}));
  const relay=createQaRelay({env:{...qa,WHATSAPP_QA_RELAY_TICKET_REFERENCES_ENABLED:'true'},fetchImpl:async()=>({ok:true,json:async()=>({ok:true,references:refs})})});
  assert.equal((await relay({rawBody:raw,signature:sig})).references.size,75);
});
test('mixed batch requires only the authorized test sender reference across retries',async()=>{
 const p={object:'whatsapp_business_account',entry:[{id:'928900479733370',changes:[{field:'messages',value:{metadata:{phone_number_id:'1376102838911694'},messages:[{id:'pilot',from:'5492213032019',type:'text',text:{body:'hi'}},{id:'other',from:'15551234567',type:'text',text:{body:'hello'}}]}}]}]};
 const raw=Buffer.from(JSON.stringify(p));const sig='sha256='+createHmac('sha256',secret).update(raw).digest('hex');let entries=[{providerMessageId:'pilot',reference:'PB-11111111111141118111111111111111'}];
 const send=createQaRelay({env:{...qa,WHATSAPP_QA_RELAY_TICKET_REFERENCES_ENABLED:'true'},fetchImpl:async()=>({ok:true,json:async()=>({ok:true,references:entries})})});
 for(let i=0;i<2;i++) assert.equal((await send({rawBody:raw,signature:sig})).references.get('pilot'),entries[0].reference);
 await assert.rejects(()=>send({rawBody:raw,signature:'sha256='+'0'.repeat(64)}));
 entries=[];await assert.rejects(()=>send({rawBody:raw,signature:sig}));
 assert.throws(()=>createQaRelay({env:{...qa,WHATSAPP_QA_MENU_TEST_RECIPIENT:'',WHATSAPP_QA_RELAY_TICKET_REFERENCES_ENABLED:'true'},fetchImpl:async()=>({})}));
});

test('QA relay accepts an exact persisted short ticket for pilot and rejects malformed short tickets',async()=>{
 const p={object:'whatsapp_business_account',entry:[{id:'928900479733370',changes:[{field:'messages',value:{metadata:{phone_number_id:'1376102838911694'},messages:[{id:'pilot',from:'5492213032019',type:'text',text:{body:'hi'}}]}}]}]};
 const raw=Buffer.from(JSON.stringify(p));const sig='sha256='+createHmac('sha256',secret).update(raw).digest('hex');let reference='PB-100023';
 const send=createQaRelay({env:{...qa,WHATSAPP_QA_RELAY_TICKET_REFERENCES_ENABLED:'true'},fetchImpl:async()=>({ok:true,json:async()=>({ok:true,references:[{providerMessageId:'pilot',reference}]})})});
 assert.equal((await send({rawBody:raw,signature:sig})).references.get('pilot'),reference);
 reference='PB-000001';await assert.rejects(()=>send({rawBody:raw,signature:sig}));
});
