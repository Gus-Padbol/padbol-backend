import test from 'node:test'; import assert from 'node:assert/strict';
import {createServer} from 'node:http'; import {once} from 'node:events';
import {createMarkerState, appendMarkerEvent, computeParticipation} from './nationsParticipationMarker.js';
const p1='11111111-1111-4111-8111-111111111111',p2='22222222-2222-4222-8222-222222222222',p3='33333333-3333-4333-8333-333333333333',p4='44444444-4444-4444-8444-444444444444';
const lineup={iniciales:[p1,p2],suplentes:[p3,p4]};
function app(){
 let state=createMarkerState({lineup,startedAt:1000}); let clock=1000;
 const server=createServer(async(req,res)=>{
  if(req.headers.authorization!=='Bearer fixture'){res.writeHead(401).end('{}');return;}
  if(req.method==='GET'&&req.url==='/timeline'){res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify(state));return;}
  if(req.method==='POST'&&req.url==='/events'){
   let body=''; for await(const c of req) body+=c; const input=JSON.parse(body||'{}'); clock+=1000;
   try{const r=appendMarkerEvent(state,input,{expectedRevision:input.expectedRevision,now:clock,actorId:'fixture'}); state=r.state; res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({revision:state.revision,event:r.event,deduplicated:r.deduplicated}));}
   catch(e){res.writeHead(e.code==='REVISION_CONFLICT'||e.code==='IDEMPOTENCY_CONFLICT'?409:400).end(JSON.stringify({code:e.code}));}
   return;
  }
  res.writeHead(404).end('{}');
 });
 return {server, getState:()=>state};
}
async function withApp(fn){const a=app();a.server.listen(0,'127.0.0.1');await once(a.server,'listening');try{return await fn(`http://127.0.0.1:${a.server.address().port}`,a);}finally{a.server.close();}}
const post=(base,body,headers={})=>fetch(`${base}/events`,{method:'POST',headers:{'content-type':'application/json','authorization':'Bearer fixture',...headers},body:JSON.stringify(body)});

test('HTTP: append + close + timeline confirmado',async()=>{
 await withApp(async base=>{
  const sub={type:'substitution',eventId:'s1',outId:p1,inId:p3,author:'a',idempotencyKey:'k1',expectedRevision:0,serverNow:2000};
  const r1=await post(base,sub); assert.equal(r1.status,200);
  const close={type:'close',eventId:'c1',author:'a',idempotencyKey:'k2',expectedRevision:1,serverNow:5000};
  assert.equal((await post(base,close)).status,200);
  const state=await (await fetch(`${base}/timeline`,{headers:{authorization:'Bearer fixture'}})).json();
  const c=computeParticipation(state,lineup); assert.equal(c.status,'confirmed'); assert.equal(c.players.find(x=>x.id===p3).activeMs,1000); assert.equal(c.players.length,4);
 });
});
test('HTTP: idempotencia same key y conflicto distinto contenido',async()=>{
 await withApp(async base=>{
  const body={type:'pause',eventId:'p',author:'a',idempotencyKey:'same',expectedRevision:0,serverNow:2000};
  assert.equal((await post(base,body)).status,200);
  const dup=await post(base,{...body,expectedRevision:1}); assert.equal(dup.status,200); assert.equal((await dup.json()).deduplicated,true);
  const conflict=await post(base,{...body,reason:'different',expectedRevision:1}); assert.equal(conflict.status,409); assert.equal((await conflict.json()).code,'IDEMPOTENCY_CONFLICT');
 });
});
test('HTTP: revision vieja 409 y reloj del servidor ignora serverNow del body',async()=>{
 await withApp(async base=>{
  assert.equal((await post(base,{type:'pause',eventId:'p',author:'a',idempotencyKey:'k',expectedRevision:0,serverNow:999999})).status,200);
  const stale=await post(base,{type:'resume',eventId:'r',author:'a',idempotencyKey:'r',expectedRevision:0,serverNow:3000});
  assert.equal(stale.status,409); assert.equal((await stale.json()).code,'REVISION_CONFLICT');
  const ok=await post(base,{type:'resume',eventId:'r',author:'a',idempotencyKey:'r2',expectedRevision:1,serverNow:888888});
  assert.equal(ok.status,200);
  const state=await (await fetch(`${base}/timeline`,{headers:{authorization:'Bearer fixture'}})).json();
  assert.notEqual(state.events.at(-1).serverAt,888888);
 });
});
test('HTTP: sin autorizacion 401; evento invalido no escribe timeline',async()=>{
 await withApp(async base=>{
  assert.equal((await fetch(`${base}/timeline`)).status,401);
  const before=await (await fetch(`${base}/timeline`,{headers:{authorization:'Bearer fixture'}})).json();
  const r=await post(base,{type:'substitution',eventId:'x',outId:p4,inId:p3,author:'a',idempotencyKey:'bad',expectedRevision:0,serverNow:99999});
  assert.equal(r.status,400); assert.equal((await r.json()).code,'OUT_NOT_ACTIVE');
  const after=await (await fetch(`${base}/timeline`,{headers:{authorization:'Bearer fixture'}})).json();
  assert.equal(after.revision,before.revision); assert.equal(after.events.length,0);
 });
});
