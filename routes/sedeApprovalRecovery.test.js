import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {PGlite} from '/Users/padbol2022/PADBOL-LAB-DEEPSEEK/padbol-backend-canonical/node_modules/@electric-sql/pglite/dist/index.js';
import {mountSedeApprovalRecoveryRoutes} from './sedeApprovalRecovery.js';
import {createAcknowledgedMakeTransport} from '../lib/sedeMakeTransport.js';
const actor='11111111-1111-4111-8111-111111111111';
const prefix='/api/admin/sedes-pendientes/:id';
const source=await fs.readFile(new URL('../lib/fixtures/sedeApprovalFixture.sql',import.meta.url),'utf8');
const migration=await fs.readFile(new URL('../sql/candidates/20261030143000_sede_approval_recovery.sql',import.meta.url),'utf8');
async function fixture(){
 const db=new PGlite();await db.exec(source);await db.exec(migration);
 const pool={query:(...args)=>db.query(...args),connect:async()=>({query:(...args)=>db.query(...args),release(){}})};
 const routes=new Map(),deliveries=[];
 const app={get:(p,h)=>routes.set('GET '+p,h),post:(p,h)=>routes.set('POST '+p,h)};
 let user={id:actor},denied=false;
 mountSedeApprovalRecoveryRoutes(app,{enabled:true,pool,authUserFromBearer:async()=>user,
  assertSuperAdminReq:async()=>{if(denied)throw Object.assign(new Error('sensitive error'),{status:403});},
  deliver:async j=>{deliveries.push(j);if(j.kind==='welcome_email')throw Error('uncertain');return {accepted:true,reference:'synthetic:accepted'};}});
 return {db,routes,deliveries,setUser:u=>user=u,deny:()=>denied=true,
  async call(method,suffix,body={},id='7'){
   const res={statusCode:200,status(n){this.statusCode=n;return this},json(body){this.body=body;return this}};
   await routes.get(method+' '+prefix+suffix)({params:{id},body},res);return res;
  }};
}
test('recovery flag is absent by default and enabled startup rejects missing SQL pool',()=>{
 const app={post(){throw Error('unexpected route')},get(){throw Error('unexpected route')}};
 assert.deepEqual(mountSedeApprovalRecoveryRoutes(app,{}),{enabled:false});
 assert.throws(()=>mountSedeApprovalRecoveryRoutes(app,{enabled:true}),/DATABASE_REQUIRED/);
});
test('authenticated actor ignores forged body, replay does not duplicate and pump freezes ambiguous delivery',async()=>{
 const f=await fixture();try{
  const a=await f.call('POST','/aprobar',{actorId:'forged',recoverySedeId:999});assert.equal(a.statusCode,200);
  assert.equal((await f.call('POST','/aprobar')).body.replayed,true);
  const status=await f.call('GET','/estado-aprobacion');assert.equal(status.body.jobs.length,5);
  await f.call('POST','/procesar-entregas');await f.call('POST','/procesar-entregas');
  assert.equal(f.deliveries.filter(x=>x.kind==='welcome_email').length,1);
  assert.equal((await f.call('GET','/estado-aprobacion')).body.jobs.find(x=>x.kind==='welcome_email').state,'uncertain');
  const r=await f.call('POST','/conciliar-entrega',{kind:'welcome_email',outcome:'confirmed_not_sent',evidence_reference:'synthetic-review'});
  assert.equal(r.body.state,'pending');
  assert.equal((await f.db.query('SELECT count(*)::int AS n FROM sedes')).rows[0].n,1);
 }finally{await f.db.close();}
});
test('HTTP authentication and database superadmin authorization both precede transports',async()=>{
 const f=await fixture();try{
  for(const [method,suffix] of [['POST','/aprobar'],['GET','/estado-aprobacion'],['POST','/recuperar'],['POST','/conciliar-entrega'],['POST','/procesar-entregas']]){
   f.setUser(null);assert.equal((await f.call(method,suffix)).statusCode,401);
   f.setUser({id:'22222222-2222-4222-8222-222222222222'});
   const r=await f.call(method,suffix,{sede_id:1,kind:'welcome_email',outcome:'confirmed_not_sent',evidence_reference:'synthetic'});
   assert.equal(r.statusCode,403);
  }
  assert.equal(f.deliveries.length,0);
  assert.equal((await f.db.query('SELECT count(*)::int AS n FROM sedes')).rows[0].n,0);
  f.setUser({id:actor});f.deny();const denied=await f.call('POST','/aprobar');assert.equal(denied.statusCode,403);assert.ok(!JSON.stringify(denied.body).includes('sensitive'));
 }finally{await f.db.close();}
});
test('invalid request and missing recovery link never approve a new venue',async()=>{
 const f=await fixture();try{
  for(const id of ['0','7foo','1.2','9007199254740992'])assert.equal((await f.call('POST','/aprobar',{},id)).statusCode,400);
  assert.equal((await f.call('POST','/recuperar',{})).statusCode,400);
  assert.equal((await f.call('POST','/recuperar',{sede_id:999})).statusCode,409);
  assert.equal((await f.db.query('SELECT count(*)::int AS n FROM sedes')).rows[0].n,0);
 }finally{await f.db.close();}
});
test('database outage is sanitized and cannot invoke legacy write or transport',async()=>{
 const routes=[];const app={get:(p,h)=>routes.push(h),post:(p,h)=>routes.push(h)};
 mountSedeApprovalRecoveryRoutes(app,{enabled:true,pool:{query(){throw Error('secret')},connect(){throw Error('secret connection URL')}},authUserFromBearer:async()=>({id:actor}),assertSuperAdminReq:async()=>{},deliver(){throw Error('must never deliver')}});
 const res={status(n){this.statusCode=n;return this},json(body){this.body=body;return this}};
 await routes[0]({params:{id:'7'}},res);assert.equal(res.statusCode,503);assert.ok(!JSON.stringify(res.body).includes('secret'));
});
test('Make transport distinguishes HTTP acceptance from uncertain outcomes without retries',async()=>{
 let calls=0;
 const factory=(fetchImpl,extra={})=>createAcknowledgedMakeTransport({runtime:{outboundDeliveryEnabled:true},webhookUrl:'https://synthetic.example.invalid/hook',fetchImpl,...extra});
 const good=factory(async(_url,options)=>{calls++;assert.equal(options.redirect,'error');assert.equal(JSON.parse(options.body).event,'jugador_registrado');return {status:202}});
 assert.deepEqual(await good('jugador_registrado',{event:'forged'}),{accepted:true,reference:'make:http-202'});
 for(const response of [{status:500},{status:302},{},null])await assert.rejects(factory(async()=>{calls++;return response})('jugador_registrado'),/UNCERTAIN/);
 await assert.rejects(factory(async()=>{calls++;throw Error('secret URL')})('jugador_registrado'),/^Error: MAKE_ACCEPTANCE_UNCERTAIN$/);
 assert.equal(calls,6);
 for(const extra of [{runtime:{outboundDeliveryEnabled:false}},{webhookUrl:''},{webhookUrl:'http://synthetic.example.invalid'}])await assert.rejects(factory(()=>{throw Error('must not call')},extra)('jugador_registrado'),e=>e.blocked===true);
});

test('HTTP Auth reconciliation preserves verified identity separately from evidence',async()=>{
 const f=await fixture();try{
  await f.call('POST','/aprobar');await f.db.exec("UPDATE sede_approval_outbox SET state='uncertain' WHERE kind='auth_user'");
  const body={kind:'auth_user',outcome:'confirmed_delivered',evidence_reference:'synthetic-audit',actorId:'forged'};
  assert.equal((await f.call('POST','/conciliar-entrega',body)).statusCode,400);
  assert.equal((await f.call('POST','/conciliar-entrega',{...body,auth_user_id:['22222222-2222-4222-8222-222222222222'],auth_origin:'created'})).statusCode,400);
  const r=await f.call('POST','/conciliar-entrega',{...body,auth_user_id:'22222222-2222-4222-8222-222222222222',auth_origin:'created'});assert.equal(r.statusCode,200);
  assert.equal((await f.db.query("SELECT provider_reference FROM sede_approval_outbox WHERE kind='auth_user'")).rows[0].provider_reference,'auth:22222222-2222-4222-8222-222222222222');
  assert.equal((await f.db.query('SELECT actor_user_id,evidence_reference FROM sede_approval_delivery_reviews')).rows[0].actor_user_id,actor);
 }finally{await f.db.close();}
});
