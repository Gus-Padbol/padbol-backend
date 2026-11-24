// Test-only ROOT curation. Real source functions/routes, real owned PG17;
// fixture pauses only the result of cancel's first empty SELECT (not SQL logic).
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import {execFileSync} from 'node:child_process';import {once} from 'node:events';import express from 'express';import pg from 'pg';
import {start} from '../lib/nextGenerationUuid026.fixture.mjs';import {mountCommercialReleaseRoutes} from './commercialRelease.js';
import {prepareDirectOperation} from '../lib/sedeDirectOperations.js';
const A='00000000-0000-4000-8000-0000000000a1',KEY1='11111111-1111-4111-8111-111111111111',KEY2='22222222-2222-4222-8222-222222222222';
const body=(over={})=>({nombre:'Cancel gap fixture',cantidad_canchas:2,direccion:'Fixture 123',ciudad:'Rosario',provincia:'Santa Fe',pais:'Argentina',horario_apertura:'09:00',horario_cierre:'22:00',precio_base:1000,moneda:'ARS',whatsapp:'+5493415550000',email_contacto:'club@fixture.invalid',licenciatario_nombre:'Synthetic Owner',licenciatario_email:'owner@fixture.invalid',licenciatario_telefono:'+5493415550001',licenciatario_pais:'Argentina',operation_key:KEY1,...over});
const defer=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};};
async function bound(p){let timer;try{return await Promise.race([p,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('bounded056 fixture wait')),6000);})]);}finally{clearTimeout(timer);}}
async function fixture(){let fx,server,extra;const gates=[];let cancelGate,authGate,authCalls=0;const pids=new Set();
 try{
  fx=await start({install:false});const pool=fx.pool;extra=new pg.Pool({...pool.options,max:4});
  await pool.query(fs.readFileSync(new URL('../sql/candidates/20261124_sede_direct_operations056.sql',import.meta.url),'utf8'));
  await pool.query('create table organizacion_sedes(organizacion_id uuid not null references organizaciones(id) on delete cascade,sede_id bigint not null references sedes(id) on delete cascade,created_at timestamptz not null default now(),primary key(organizacion_id,sede_id),unique(sede_id))');
  await pool.query("select setval('sedes_id_seq',coalesce((select max(id) from sedes),0)+1,false)");
  await pool.query('insert into auth.users(id) values($1) on conflict(id)do nothing',[A]);
  await pool.query("delete from user_roles");await pool.query("insert into user_roles(user_id,email,role,alcance) values($1,'actor@fixture.invalid','super_admin','global')",[A]);
  const wrapped={query:(...args)=>extra.query(...args),async connect(){const c=await extra.connect();pids.add(c.processID);return{release:()=>c.release(),async query(sql,args){const result=await c.query(sql,args);if(cancelGate&&sql.includes('from public.sede_direct_operations')&&sql.includes('for update')&&result.rowCount===0){const gate=cancelGate;cancelGate=null;gate.pid=c.processID;gate.seen.resolve();await bound(gate.release.promise);}return result;}};}};
  const app=express();app.use(express.json());mountCommercialReleaseRoutes(app,{supabaseAdmin:{auth:{admin:{createUser:async({email})=>{authCalls++;if(authGate){const gate=authGate;authGate=null;gate.seen.resolve();await bound(gate.release.promise);}return{data:{user:{id:'33333333-3333-4333-8333-333333333333',email}},error:null};}}}},runtime:{outboundDeliveryEnabled:false},authUserFromBearer:async req=>req.get('Authorization')==='Bearer synthetic056'?{id:A,email:'actor@fixture.invalid'}:null,assertSuperAdminReq:async()=>{},adminListScopeFromRequest:async()=>null,sedesPermitidasPorScope:async()=>({sedes:[]}),pgPool:wrapped});
  server=app.listen(0,'127.0.0.1');await once(server,'listening');const base='http://127.0.0.1:'+server.address().port;
  const call=async(path,payload={})=>{const response=await fetch(base+path,{method:'POST',signal:AbortSignal.timeout(10000),headers:{Authorization:'Bearer synthetic056','Content-Type':'application/json'},body:JSON.stringify(payload)});return{status:response.status,body:await response.json()};};
  const arm=type=>{const gate={seen:defer(),release:defer(),pid:null};gates.push(gate);if(type==='cancel')cancelGate=gate;else authGate=gate;return gate;};
  return{pool,wrapped,call,arm,pids,authCalls:()=>authCalls,async stop(){for(const gate of gates)gate.release.resolve();server.closeAllConnections();await new Promise(r=>server.close(r));await extra.end();await fx.stop();console.log('CLEANUP_ROOT056_RACE_HTTP_PG');}};
 }catch(error){for(const gate of gates)gate.release.resolve();if(server){server.closeAllConnections();await new Promise(r=>server.close(r));}await extra?.end();await fx?.stop();throw error;}
}
const cancelPath=key=>`/api/admin/sedes-directa/operaciones/${key}/cancelar`;
const state=async(f,key)=>(await f.pool.query('select state,sede_id,receipt from sede_direct_operations where actor_id=$1 and operation_key=$2',[A,key])).rows[0];
// Run separately before curation as a deliberately failing regression, preserving
// actual old C1 module via data URL; only node:crypto import needs resolution.
if(process.env.ROOT056_NEGATIVE==='1')test('056 original C1 negative empty-select prepare gap returns false cancellation',async()=>{
 const f=await fixture();try{
  const source=execFileSync('git',['show','a36944439a145822468ffc296dc69954b6404a10:lib/sedeDirectOperations.js'],{cwd:new URL('..',import.meta.url),encoding:'utf8'});
  const old=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));const gate=f.arm('cancel');
  const cancel=old.cancelDirectOperation(f.wrapped,{actorId:A,actorEmail:'actor@fixture.invalid',operationKey:KEY1});await bound(gate.seen.promise);
  await prepareDirectOperation(f.wrapped,{actorId:A,actorEmail:'actor@fixture.invalid',operationKey:KEY1,payloadDigest:'a'.repeat(64)});gate.release.resolve();const ack=await cancel,row=await state(f,KEY1);
  console.log('NEGATIVE_ROOT056 '+JSON.stringify({oldSource:'a36944439a145822468ffc296dc69954b6404a10',ack:ack.state,persisted:row.state,cancelPid:gate.pid,distinctPIDs:[...f.pids]}));assert.equal(row.state,ack.state,'cancel ACK must agree with persisted state');
 }finally{await f.stop();}
});
test('056 curated current two HTTP gap interleavings and deterministic advisory authority',async()=>{
 const f=await fixture();try{
  // Cancel sees empty; actual HTTP prepare commits, then synthetic Auth holds.
  const cancelGate=f.arm('cancel'),cancel=f.call(cancelPath(KEY1));await bound(cancelGate.seen.promise);const auth=f.arm('auth'),create=f.call('/api/admin/sedes-directa',body());await bound(auth.seen.promise);assert.equal((await state(f,KEY1)).state,'prepared');cancelGate.release.resolve();
  const ack=await cancel;assert.equal(ack.status,200);assert.equal(ack.body.state,'cancelled');assert.equal((await state(f,KEY1)).state,'cancelled');auth.release.resolve();const late=await create;assert.equal(late.status,409);assert.equal(late.body.code,'DIRECT_OPERATION_CANCELLED');assert.equal((await f.pool.query("select count(*)::int n from sedes where nombre='Cancel gap fixture'")).rows[0].n,0);assert.equal(f.authCalls(),1);assert.ok(f.pids.size>=2);console.log('ROOT056_PREPARED_GAP '+JSON.stringify({cancelPid:cancelGate.pid,pids:[...f.pids],response:'cancelled',late409:true,noVenue:true}));
  // Cancel sees empty; complete actually commits the venue/role/receipt first.
  const completeGate=f.arm('cancel'),cancel2=f.call(cancelPath(KEY2));await bound(completeGate.seen.promise);const completed=await f.call('/api/admin/sedes-directa',body({operation_key:KEY2,nombre:'Complete won gap'}));assert.equal(completed.status,200,JSON.stringify(completed.body));completeGate.release.resolve();const ack2=await cancel2;assert.equal(ack2.status,200);assert.equal(ack2.body.state,'completed');assert.equal(ack2.body.sede_id,completed.body.sede_id);assert.deepEqual(ack2.body.receipt,(await state(f,KEY2)).receipt);assert.equal((await state(f,KEY2)).state,'completed');console.log('ROOT056_COMPLETED_GAP '+JSON.stringify({cancelPid:completeGate.pid,pids:[...f.pids],sedeId:ack2.body.sede_id,response:'completed',sameReceipt:true}));
  // External session advisory holder forces BOTH distinct operations to wait;
  // no sleep/scheduler-luck assertion may replace observed pg_blocking_pids.
  const holder=await f.pool.connect();try{
   await holder.query("select pg_advisory_lock(hashtextextended('invitacion_admin_club:shared-root056@fixture.invalid',0))");
   const one=f.call('/api/admin/sedes-directa',body({operation_key:'44444444-4444-4444-8444-444444444444',nombre:'Root advisory one',licenciatario_email:'shared-root056@fixture.invalid'}));
   const two=f.call('/api/admin/sedes-directa',body({operation_key:'55555555-5555-4555-8555-555555555555',nombre:'Root advisory two',licenciatario_email:'shared-root056@fixture.invalid'}));
   let waits=[];const end=Date.now()+6000;while(Date.now()<end){waits=(await f.pool.query("select pid from pg_stat_activity where wait_event_type='Lock' and $1=any(pg_blocking_pids(pid))",[holder.processID])).rows;if(waits.length>=2)break;await new Promise(r=>setTimeout(r,5));}
   assert.equal(waits.length>=2,true,'both real contenders must wait on holderPID');console.log('ROOT056_ADVISORY '+JSON.stringify({holderPid:holder.processID,waitingPIDs:waits.map(x=>x.pid),advisoryWait:true}));await holder.query('select pg_advisory_unlock_all()');const result=await Promise.all([one,two]);assert.ok(result.every(x=>x.status===200),JSON.stringify(result));assert.notEqual(result[0].body.sede_id,result[1].body.sede_id);assert.equal((await f.pool.query("select count(*)::int n from user_roles where email='shared-root056@fixture.invalid'")).rows[0].n,1);
  }finally{await holder.query('select pg_advisory_unlock_all()');holder.release();}
 }finally{await f.stop();}
});
