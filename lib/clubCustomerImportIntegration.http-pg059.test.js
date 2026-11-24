// LOCAL HTTP -> real binding/helper -> owned PG17 socket. Bearer identity is synthetic;
// persisted roles/venues and contact migration are real SQL. No SDK/provider/Auth user calls.
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import {once} from 'node:events';import express from 'express';
import {start} from './nextGenerationUuid026.fixture.mjs';
import {createClubCustomerImportBodyGate,mountClubCustomerImport} from './clubCustomerImportIntegration.js';
const A='11111111-1111-4111-8111-111111111111',S='22222222-2222-4222-8222-222222222222';
const body={provider:'generic',csv:'ID,Nombre,Email\n001,Synthetic Alpha,alpha@fixture.invalid',mapping:{externalId:0,name:1,email:2}};
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};};
const bounded=p=>Promise.race([p,new Promise((_,reject)=>{const t=setTimeout(()=>reject(Error('bounded fixture wait')),5000);t.unref();})]);
test('059 mounted binding: private import, scoped parser, retry and persisted revocation', {timeout:60000},async()=>{
 let fx,server,serverOff,ownedDirectory;let authCalls=0,queries=0,connections=0,holdWrite=null,holdRead=null;const checks=[];
 const pass=x=>{checks.push(x);console.log('PASS059 '+x);};
 try{
  fx=await start({install:false});const pool=fx.pool;ownedDirectory=pool.options.host;
  await pool.query(fs.readFileSync(new URL('../sql/migrations/20260911170000_club_imported_contacts.sql',import.meta.url),'utf8'));
  await pool.query('insert into auth.users(id) values($1),($2)',[A,S]);
  await pool.query("insert into user_roles(user_id,email,role,alcance,sede_id) values($1,'club@fixture.invalid','admin_club','sede',1),($2,'super@fixture.invalid','super_admin','global',null)",[A,S]);
  const routePool={async query(...args){queries++;const r=await pool.query(...args);if(holdRead&&args[0].startsWith('SELECT id,provider')){const hold=holdRead;holdRead=null;hold.enter.resolve();await bounded(hold.release.promise);}return r;},async connect(){connections++;const c=await pool.connect();return{release:()=>c.release(),async query(...args){if(holdWrite&&args[0].includes('SELECT id,role,sede_id')){const hold=holdWrite;holdWrite=null;hold.enter.resolve();await bounded(hold.release.promise);}return c.query(...args);}};}};
  const auth=async req=>{authCalls++;const token=req.headers.authorization;return{user:token==='Bearer club'?{id:A}:token==='Bearer super'?{id:S}:null,status:401};};
  const make=enabled=>{const app=express();app.use(createClubCustomerImportBodyGate());app.use(express.json());app.post('/ordinary',(req,res)=>res.json({ok:true}));mountClubCustomerImport(app,{pool:routePool,getAuthenticatedUser:auth,enabled});app.use((error,req,res,next)=>res.status(error.status||500).json({error:error.type||error.message}));return app;};
  server=make(true).listen(0,'127.0.0.1');await once(server,'listening');serverOff=make(false).listen(0,'127.0.0.1');await once(serverOff,'listening');const base=`http://127.0.0.1:${server.address().port}`,off=`http://127.0.0.1:${serverOff.address().port}`;
  const call=async(suffix,{method='POST',payload=body,venue=1,token='club',origin=base}={})=>{const response=await fetch(origin+`/api/admin/sedes/${venue}/importaciones/clientes`+suffix,{method,signal:AbortSignal.timeout(8000),headers:{'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{})},...(method!=='GET'?{body:JSON.stringify(payload)}:{})});return{status:response.status,body:await response.json()};};
  const before=[authCalls,queries,connections];assert.equal((await call('/preview',{origin:off})).status,409);assert.deepEqual([authCalls,queries,connections],before);pass('flag OFF makes no Auth/SDK/DB call');
  assert.equal((await call('/preview',{token:null})).status,401);assert.equal((await call('/preview',{venue:2})).status,403);assert.equal((await call('',{method:'GET',venue:2})).status,403);
  const p=await call('/preview');assert.equal(p.status,200);assert.equal(p.body.canConfirm,true);const confirm={...body,fingerprint:p.body.fingerprint};
  assert.deepEqual((await call('/confirm',{payload:confirm})),{status:200,body:{inserted:1,unchanged:0}});assert.deepEqual((await call('/confirm',{payload:confirm})),{status:200,body:{inserted:0,unchanged:1}});
  assert.equal((await pool.query('select count(*)::int n from club_imported_contacts')).rows[0].n,1);assert.equal((await pool.query('select count(*)::int n from club_import_batches')).rows[0].n,2);
  const own=await call('',{method:'GET'});assert.equal(own.status,200);assert.equal(own.body.contacts[0].email,'alpha@fixture.invalid');const foreign=await call('',{method:'GET',venue:2});assert.equal(foreign.status,403);assert.equal(JSON.stringify(foreign.body).includes('alpha@'),false);assert.equal((await call('/preview',{token:'super',venue:2})).status,200);pass('own preview/confirm/retry persists one contact; foreign PP gets no PII; Super explicit PP');
  await pool.query("insert into user_roles(user_id,email,role,alcance) values($1,'club@fixture.invalid','empleado','sede')",[A]);assert.equal((await call('/preview')).status,403);await pool.query("delete from user_roles where user_id=$1 and role='empleado'",[A]);pass('multiple persisted role rows fail closed without email fallback');
  const csv='ID,Nombre,Email\n'+Array.from({length:600},(_,i)=>`${i},${'N'.repeat(180)},fixture${i}@example.invalid`).join('\n');assert.ok(Buffer.byteLength(csv)>102400);assert.equal((await call('/preview',{payload:{...body,csv}})).status,200);
  const prior=[authCalls,queries,connections];assert.equal((await call('/preview',{payload:{...body,csv:'X'.repeat(4*1024*1024)}})).status,413);assert.deepEqual([authCalls,queries,connections],prior);
  const ordinary=await fetch(base+'/ordinary',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text:'X'.repeat(110000)})});assert.equal(ordinary.status,413);pass('CSV above100KB passes exact4MiB gate; oversized rejected before DB; ordinary100KB unchanged');
  holdWrite={enter:deferred(),release:deferred()};const hold=holdWrite;const pending=call('/confirm',{payload:confirm});await bounded(hold.enter.promise);await pool.query("update user_roles set role='empleado' where user_id=$1",[A]);hold.release.resolve();assert.equal((await pending).status,403);assert.equal((await pool.query('select count(*)::int n from club_import_batches')).rows[0].n,2);pass('role revoked after outer check before locked write blocks transaction and creates no batch');
  await pool.query("update user_roles set role='admin_club' where user_id=$1",[A]);holdRead={enter:deferred(),release:deferred()};const read=holdRead;const pendingRead=call('',{method:'GET'});await bounded(read.enter.promise);await pool.query("update user_roles set role='empleado' where user_id=$1",[A]);read.release.resolve();const deniedRead=await pendingRead;assert.equal(deniedRead.status,403);assert.equal(JSON.stringify(deniedRead.body).includes('alpha@'),false);pass('GET result delayed across revocation is revalidated and emits no contacts');
  const network=(await pool.query("select inet_server_addr() address,current_setting('listen_addresses') listen")).rows[0];assert.equal(network.address,null);assert.equal(network.listen,'');console.log('PROOF059 '+JSON.stringify({checks:checks.length,authCalls,queries,connections,network,contacts:1,batches:2,externalAuthUsersCalls:0,deliveryCalls:0}));
 }finally{for(const s of [server,serverOff])if(s)await new Promise(r=>{s.close(r);s.closeAllConnections?.();});if(fx)await fx.stop();if(ownedDirectory)assert.equal(fs.existsSync(ownedDirectory),false);console.log('CLEANUP059_OWNED_HTTP_AND_PG '+JSON.stringify({socketDirectoryRemoved:ownedDirectory?!fs.existsSync(ownedDirectory):null}));}
});

// Regression: the final venue await after an authorized role read is itself a privacy boundary.
test('059 final read authorization has one PG decision point across revocation orders',{timeout:60000},async()=>{
 let fx,server,owned,revoker;let roleReads=0,mode='venue',barrier=deferred(),release=deferred(),held=false;
 try{
  fx=await start({install:false});const pool=fx.pool;owned=pool.options.host;
  await pool.query(fs.readFileSync(new URL('../sql/migrations/20260911170000_club_imported_contacts.sql',import.meta.url),'utf8'));
  await pool.query('insert into auth.users(id) values($1)',[A]);await pool.query("insert into user_roles(user_id,email,role,alcance,sede_id) values($1,'club@fixture.invalid','admin_club','sede',1)",[A]);
  await pool.query("insert into club_imported_contacts(sede_id,provider,source_key,name,email,created_by) values(1,'generic','id:private','Synthetic Private','private@fixture.invalid',$1)",[A]);
  async function query(db,sql,args,pid){
   if(sql.startsWith('SELECT id,role,sede_id')){
    roleReads++;
    if(mode==='before-role'&&roleReads===2&&!held){held=true;barrier.resolve({pid});await bounded(release.promise);}
   }
   const result=await db.query(sql,args);
   if(mode==='venue'&&sql.startsWith('SELECT id FROM public.sedes')&&roleReads===2&&!held){held=true;barrier.resolve({locked:sql.includes('FOR SHARE'),pid});await bounded(release.promise);}
   return result;
  }
  const routePool={query:(sql,args)=>query(pool,sql,args,null),async connect(){const c=await pool.connect();return{query:(sql,args)=>query(c,sql,args,c.processID),release:()=>c.release()};}};
  const app=express();app.use(express.json());mountClubCustomerImport(app,{pool:routePool,enabled:true,getAuthenticatedUser:async()=>({user:{id:A}})});
  server=app.listen(0,'127.0.0.1');await once(server,'listening');const url=`http://127.0.0.1:${server.address().port}/api/admin/sedes/1/importaciones/clientes`;
  const get=async()=>{const r=await fetch(url,{signal:AbortSignal.timeout(8000)});return{status:r.status,body:await r.json()};};
  const pending=get();const point=await bounded(barrier.promise);console.log('FINAL059_VENUE_BARRIER '+JSON.stringify(point));
  revoker=await pool.connect();let revoked=false;const revoke=revoker.query("update user_roles set role='empleado' where user_id=$1",[A]).then(()=>{revoked=true;});
  if(!point.locked){await revoke;release.resolve();const leaked=await pending;console.log('BEFORE059_PRIVACY '+JSON.stringify({status:leaked.status,pii:JSON.stringify(leaked.body).includes('private@')}));assert.equal(leaked.status,403,'revocation committed during final venue read must not emit PII');}
  else{
   let waited=false;for(let n=0;n<150;n++){if((await pool.query('select wait_event_type from pg_stat_activity where pid=$1',[revoker.processID])).rows[0]?.wait_event_type==='Lock'){waited=true;break;}await new Promise(r=>setTimeout(r,5));}
   assert.equal(waited,true,'real revoker must wait on authorization role lock');assert.equal(revoked,false);release.resolve();const authorized=await pending;assert.equal(authorized.status,200);assert.equal(authorized.body.contacts[0].email,'private@fixture.invalid');await revoke;assert.equal((await get()).status,403);console.log('PASS059 authorization locks win, revocation waits, following read403');
  }
  revoker.release();revoker=null;
  await pool.query("update user_roles set role='admin_club' where user_id=$1",[A]);mode='before-role';roleReads=0;held=false;barrier=deferred();release=deferred();const second=get();await bounded(barrier.promise);await pool.query("update user_roles set role='empleado' where user_id=$1",[A]);release.resolve();const denied=await second;assert.equal(denied.status,403);assert.equal(JSON.stringify(denied.body).includes('private@'),false);console.log('PASS059 revocation commits before final role lock, read403 noPII');
 }finally{release.resolve();if(revoker){revoker.release();revoker=null;}if(server)await new Promise(r=>{server.close(r);server.closeAllConnections?.();});if(fx)await fx.stop();if(owned)assert.equal(fs.existsSync(owned),false);console.log('CLEANUP059_READTX_OWNED');}
});
