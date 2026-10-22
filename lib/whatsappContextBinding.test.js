import test from 'node:test';
import assert from 'node:assert/strict';
import { createWhatsappContextBinding, signWhatsappContext } from './whatsappContextBinding.js';
const timestamp='1792630800', secret='fixture-only', now=()=>Number(timestamp)*1000;
const data={revision:1,wabaId:'928900479733370',phoneNumberId:'1376102838911694',messageId:'wamid.fixture',sender:'15555550123',context:{stage:'selected',topic:'sedes',initialMessage:'Quiero abrir una sede en Miami. El terreno ya está disponible.',needs_review:true}};
function setup(){let saved;let calls=0;const repo={async bindInboundContext(input){calls++;if(input.messageId!=='wamid.fixture'||input.sender!=='15555550123') return null;if(saved && saved.contentHash!==input.contentHash) throw Object.assign(Error('conflict'),{status:409});const replay=Boolean(saved);saved=input;return{conversationId:'11111111-1111-4111-8111-111111111111',replay}}};return {run:createWhatsappContextBinding({repository:repo,secret,now}),getSaved:()=>saved,getCalls:()=>calls}}
const request=value=>{const body=Buffer.from(JSON.stringify(value));return {body,timestamp,signature:signWhatsappContext({secret,timestamp,body})}};
test('authenticated source binds exact event and keeps original free text on replay',async()=>{const f=setup();const a=await f.run(request(data));const b=await f.run(request(data));assert.equal(a.ticket_reference,'PB-11111111111141118111111111111111');assert.equal(b.replay,true);assert.equal(f.getSaved().context.initialMessage,data.context.initialMessage)});
test('rejects modified payload and wrong sender before producing ticket',async()=>{const f=setup();const req=request(data);req.body=Buffer.from(JSON.stringify({...data,sender:'15555550999'}));await assert.rejects(()=>f.run(req),e=>e.status===401);assert.equal(f.getCalls(),0);await assert.rejects(()=>f.run(request({...data,sender:'15555550999'})),e=>e.status===409)});
test('conflicting replay, wrong channel, and oversized original fail closed',async()=>{const f=setup();await f.run(request(data));await assert.rejects(()=>f.run(request({...data,context:{...data.context,topic:'other'}})),e=>e.status===409);await assert.rejects(()=>f.run(request({...data,phoneNumberId:'1'})),e=>e.status===400);await assert.rejects(()=>f.run(request({...data,context:{...data.context,initialMessage:'x'.repeat(4097)}})),e=>e.status===400)});

test('requires safe positive revision and known stage',async()=>{const f=setup();for(const revision of [undefined,0,-1,1.5,Number.MAX_SAFE_INTEGER+1]) await assert.rejects(()=>f.run(request({...data,revision})),e=>e.status===400);await assert.rejects(()=>f.run(request({...data,context:{...data.context,stage:'unknown'}})),e=>e.status===400);assert.equal(f.getCalls(),0)});

test('HTTP endpoint authenticates request and binds its signed response to exact bytes', async () => {
  const express = (await import('express')).default;
  const { registerWhatsappContextRoute, signWhatsappContextResponse } = await import('./whatsappContextBinding.js');
  const app=express(), key='x'.repeat(32); let calls=0;
  registerWhatsappContextRoute(app,{secret:key,allowedSender:'15555550123',now,rawParser:express.raw({type:'application/json',limit:'16kb'}),repository:{async bindInboundContext(){calls++;return {conversationId:'11111111-1111-4111-8111-111111111111',replay:false}}}});
  const server=app.listen(0,'127.0.0.1'); await new Promise(r=>server.once('listening',r));
  try {
    const url=`http://127.0.0.1:${server.address().port}/api/internal/whatsapp-context`, body=Buffer.from(JSON.stringify(data));
    const headers={'content-type':'application/json','x-padbol-timestamp':timestamp,'x-padbol-signature':signWhatsappContext({secret:key,timestamp,body})};
    const response=await fetch(url,{method:'POST',headers,body}); const result=Buffer.from(await response.arrayBuffer());
    assert.equal(response.status,200);assert.equal(response.headers.get('x-padbol-response-signature'),signWhatsappContextResponse({secret:key,requestBody:body,responseBody:result}));
    assert.notEqual(response.headers.get('x-padbol-response-signature'),signWhatsappContextResponse({secret:key,requestBody:Buffer.from('{}'),responseBody:result}));
    const bad=await fetch(url,{method:'POST',headers:{...headers,'x-padbol-signature':'0'.repeat(64)},body});assert.equal(bad.status,401);const wrong=Buffer.from(JSON.stringify({...data,sender:'15555550999'}));const wrongResult=await fetch(url,{method:'POST',headers:{...headers,'x-padbol-signature':signWhatsappContext({secret:key,timestamp,body:wrong})},body:wrong});assert.equal(wrongResult.status,401);assert.equal(calls,1);
  } finally { await new Promise(r=>server.close(r)); }
});

test('ordering review is an explicit sticky signal, not a generic review flag',async()=>{
  const f=setup();await f.run(request({...data,context:{...data.context,order_review:true}}));
  assert.equal(f.getSaved().context.order_review,true);
  const other=setup();await assert.rejects(()=>other.run(request({...data,context:{...data.context,order_review:false}})),e=>e.status===400);
});
