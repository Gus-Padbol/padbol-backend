import test from 'node:test'; import assert from 'node:assert/strict';
import {createServer} from 'node:http'; import {once} from 'node:events';
import {createNationsMatchGlobalHandler, createNationsParticipationMarkerHandler} from './nationsParticipationMarker.js';
import {createMarkerState} from '../lib/torneos/nationsParticipationMarker.js';
const id=(n)=>`${String(n).repeat(8)}-1111-4111-8111-${String(n).repeat(12)}`;
const L={t1:{iniciales:[id(1),id(2)],suplentes:[id(3),id(4)]},t2:{iniciales:[id(5),id(6)],suplentes:[id(7),id(8)]}};
async function app(){
 let clock=1000; const mem=new Map(); let failNext=false;
 const store={async getMatch(k){return mem.get(k)},async createMatch(k,v){if(mem.has(k))return false;mem.set(k,v);return true},async saveMatch(k,v,{expectedRevision}){if(failNext){failNext=false;return false;}const c=mem.get(k);if(!c||c.revision!==expectedRevision)return false;mem.set(k,v);return true}};
 const authorize=async(req,{teamId})=>{const a=req.headers.authorization;if(a==='Bearer admin')return {actorId:'admin',canControlMatch:true};if(a==='Bearer t1')return {actorId:'u1',teamId:'t1'};if(a==='Bearer t1b')return {actorId:'u1b',teamId:'t1'};if(a==='Bearer admin2')return {actorId:'admin2',canControlMatch:true};if(a==='Bearer t2')return {actorId:'u2',teamId:'t2'};return null;};
 const deps={authorize,clock:()=>clock,store,lineupsFor:async()=>L,lineupFor:async(_m,_a,t)=>L[t]};
 const team=createServer(createNationsParticipationMarkerHandler(deps)); const global=createServer(createNationsMatchGlobalHandler(deps));
 team.listen(0,'127.0.0.1'); global.listen(0,'127.0.0.1'); await Promise.all([once(team,'listening'),once(global,'listening')]);
 return {team:`http://127.0.0.1:${team.address().port}`,global:`http://127.0.0.1:${global.address().port}`,close:()=>{team.close();global.close();},tick:(ms)=>{clock+=ms},failNext:()=>{failNext=true},mem};
}
const teamGet=(a,t)=>fetch(`${a.team}/api/nations/marker/m1?teamId=${t}`,{headers:{authorization:`Bearer ${t}`}});
const teamPost=(a,t,b)=>fetch(`${a.team}/api/nations/marker/m1/events?teamId=${t}`,{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${t}`},body:JSON.stringify(b)});
const gpost=(a,b,token='admin')=>fetch(`${a.global}/api/nations/marker/m1/global`,{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${token}`},body:JSON.stringify(b)});
test('agregado: team GET/substitution y team rechaza pause',async()=>{const a=await app();try{
 assert.equal((await teamGet(a,'t1')).status,200);
 const p=await teamPost(a,'t1',{type:'pause',eventId:'p',idempotencyKey:'p',expectedRevision:0}); assert.equal(p.status,400); assert.equal((await p.json()).code,'GLOBAL_ONLY');
 a.tick(2000); const s=await teamPost(a,'t1',{type:'substitution',eventId:'s',outId:id(1),inId:id(3),idempotencyKey:'s',expectedRevision:0}); assert.equal(s.status,200);
 const j=await (await teamGet(a,'t1')).json(); assert.deepEqual(j.state.active,[id(3),id(2)]);
 const j2=await (await teamGet(a,'t2')).json(); assert.deepEqual(j2.state.active,[id(5),id(6)]);
}finally{a.close();}});
test('global: pause/resume/close ambos mismo serverAt y GET coherente',async()=>{const a=await app();try{
 a.tick(2000); assert.equal((await gpost(a,{type:'pause',idempotencyKey:'g1',expectedRevision:0})).status,200);
 a.tick(2000); assert.equal((await gpost(a,{type:'resume',idempotencyKey:'g2',expectedRevision:1})).status,200);
 a.tick(2000); const c=await gpost(a,{type:'close',idempotencyKey:'g3',expectedRevision:2}); assert.equal(c.status,200);
 const j=await c.json(); assert.equal(j.events.t1.serverAt,j.events.t2.serverAt); assert.ok(j.events.t1.serverAt>=3000);
 const t1=await (await teamGet(a,'t1')).json(); const t2=await (await teamGet(a,'t2')).json();
 assert.equal(t1.state.status,'closed'); assert.equal(t2.state.status,'closed'); assert.equal(t1.state.events.length,t2.state.events.length);
}finally{a.close();}});
test('global: retry dedup y revision vieja 409',async()=>{const a=await app();try{
 const b={type:'pause',idempotencyKey:'g',expectedRevision:0}; assert.equal((await gpost(a,b)).status,200);
 const retry=await gpost(a,{...b,expectedRevision:1}); assert.equal(retry.status,200); const j=await retry.json(); assert.equal(j.revision,1);
 const stale=await gpost(a,{type:'resume',idempotencyKey:'x',expectedRevision:0}); assert.equal(stale.status,409);
}finally{a.close();}});
test('global: carrera una escritura; concurrente pausa vs cambio no parcial',async()=>{const a=await app();try{
 const [r1,r2]=await Promise.all([gpost(a,{type:'pause',idempotencyKey:'a',expectedRevision:0}),gpost(a,{type:'pause',idempotencyKey:'b',expectedRevision:0})]);
 assert.deepEqual([r1.status,r2.status].sort(),[200,409]);
 const [g,s]=await Promise.all([gpost(a,{type:'resume',idempotencyKey:'r',expectedRevision:1}),teamPost(a,'t1',{type:'substitution',eventId:'s',outId:id(1),inId:id(3),idempotencyKey:'s',expectedRevision:1})]);
 assert.deepEqual([g.status,s.status].sort(),[200,409]);
 const t1=await (await teamGet(a,'t1')).json(); const t2=await (await teamGet(a,'t2')).json();
 assert.equal(t1.state.status,t2.state.status);
}finally{a.close();}});
test('fallo save global no deja parcial',async()=>{const a=await app();try{
 a.tick(2000); a.failNext(); const r=await gpost(a,{type:'pause',idempotencyKey:'g',expectedRevision:0}); assert.equal(r.status,409);
 const t1=await (await teamGet(a,'t1')).json(); const t2=await (await teamGet(a,'t2')).json(); assert.equal(t1.state.status,'open'); assert.equal(t2.state.status,'open'); assert.equal(t1.state.events.length,0);
}finally{a.close();}});
test('auth: 401 sin token, 403 team ajeno y global sin canControlMatch',async()=>{const a=await app();try{
 assert.equal((await fetch(`${a.team}/api/nations/marker/m1?teamId=t1`)).status,401);
 assert.equal((await fetch(`${a.team}/api/nations/marker/m1?teamId=t2`,{headers:{authorization:'Bearer t1'}})).status,403);
 assert.equal((await gpost(a,{type:'pause',idempotencyKey:'g',expectedRevision:0},'t1')).status,403);
}finally{a.close();}});
test('timestamp cliente serverNow se ignora',async()=>{const a=await app();try{
 const r=await gpost(a,{type:'pause',idempotencyKey:'g',expectedRevision:0,serverAt:999999,serverNow:999999}); assert.equal(r.status,200);
 const j=await r.json(); assert.notEqual(j.events.t1.serverAt,999999);
}finally{a.close();}});

test('receipts: team misma key distinto contenido/actor =>409',async()=>{const a=await app();try{
 const b={type:'substitution',eventId:'s',outId:id(1),inId:id(3),idempotencyKey:'k',expectedRevision:0};
 assert.equal((await teamPost(a,'t1',b)).status,200);
 const diff=await teamPost(a,'t1',{...b,eventId:'s2',inId:id(4),expectedRevision:1}); assert.equal(diff.status,409); assert.equal((await diff.json()).code,'IDEMPOTENCY_CONFLICT');
 const actor=await fetch(`${a.team}/api/nations/marker/m1/events?teamId=t1`,{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer t1b'},body:JSON.stringify({...b,expectedRevision:1})}); assert.equal(actor.status,409);
}finally{a.close();}});
test('receipts: global misma key distinto comando/actor =>409',async()=>{const a=await app();try{
 assert.equal((await gpost(a,{type:'pause',idempotencyKey:'g',expectedRevision:0})).status,200);
 assert.equal((await gpost(a,{type:'resume',idempotencyKey:'g',expectedRevision:1})).status,409);
 assert.equal((await gpost(a,{type:'pause',idempotencyKey:'g',expectedRevision:1},'admin2')).status,409);
}finally{a.close();}});

test('receipts: key reusada cruzada team->global y global->team =>409 sin escribir',async()=>{const a=await app();try{
 assert.equal((await teamPost(a,'t1',{type:'substitution',eventId:'s',outId:id(1),inId:id(3),idempotencyKey:'cross1',expectedRevision:0})).status,200);
 assert.equal((await gpost(a,{type:'pause',idempotencyKey:'cross1',expectedRevision:1})).status,409);
 assert.equal((await gpost(a,{type:'pause',idempotencyKey:'cross2',expectedRevision:1})).status,200);
 assert.equal((await teamPost(a,'t1',{type:'substitution',eventId:'s2',outId:id(1),inId:id(3),idempotencyKey:'cross2',expectedRevision:2})).status,409);
 const dto=await (await teamGet(a,'t1')).json(); assert.equal(dto.matchRevision,2); assert.equal(dto.state.events.length,2);
}finally{a.close();}});
test('receipts: mismo canon con revision vieja =>200 receipt; mismo key otro actor =>409',async()=>{const a=await app();try{
 const body={type:'substitution',eventId:'s',outId:id(1),inId:id(3),idempotencyKey:'same',expectedRevision:0};
 assert.equal((await teamPost(a,'t1',body)).status,200);
 assert.equal((await teamPost(a,'t1',{...body,expectedRevision:0})).status,200);
 assert.equal((await fetch(`${a.team}/api/nations/marker/m1/events?teamId=t1`,{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer t1b'},body:JSON.stringify({...body,expectedRevision:1})})).status,409);
}finally{a.close();}});
