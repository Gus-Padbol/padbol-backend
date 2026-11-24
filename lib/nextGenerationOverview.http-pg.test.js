// LOCAL ONLY: actual NG admin handler + exact repository NG DDL on own PostgreSQL.
// Synthetic venue scopes and rows; no families, Auth, production or external API.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {once} from 'node:events';
import express from 'express';
import pg from 'pg';
import {registerNextGenerationAdminRoutes} from './nextGenerationAdmin.js';

const BEFORE=process.env.NG15_REPRO_BEFORE==='1';
const identifier=value=>{assert.match(value,/^[a-z_][a-z0-9_]*$/);return '"'+value+'"';};

function createDb(pool,trace,state){
 return {from(table){
  assert.ok(['ng_sesiones','ng_solicitudes_sede','ng_inscripciones','ng_inscripcion_participantes','ng_inscripcion_eventos','sedes'].includes(table));
  let columns='*',limit=null,orders=[];const filters=[];
  const query={select(value){columns=value;return query;},eq(key,value){filters.push([key,'eq',value]);return query;},in(key,values){filters.push([key,'in',values]);return query;},order(key,opts={}){orders.push([key,opts.ascending===false?'DESC':'ASC']);return query;},limit(value){limit=value;return query;},then(resolve,reject){return execute().then(resolve,reject);}};
  async function execute(){
   trace.push({table,filters,limit});
   if(state.failTable===table)return {data:null,error:{code:'XX000',message:'Synthetic read failure'}};
   const params=[];
   const where=filters.map(([key,op,value])=>{params.push(value);return op==='in'?`${identifier(key)}=ANY($${params.length}::uuid[])`:`${identifier(key)}=$${params.length}`;});
   let sql=`SELECT ${columns==='*'?'*':columns.split(',').map(identifier).join(',')} FROM public.${identifier(table)}`;
   if(where.length)sql+=' WHERE '+where.join(' AND ');
   if(orders.length)sql+=' ORDER BY '+orders.map(([key,dir])=>`${identifier(key)} ${dir}`).join(',');
   if(limit!==null){assert.ok(Number.isInteger(limit)&&limit>0);params.push(limit);sql+=` LIMIT $${params.length}`;}
   try{const result=await pool.query(`SELECT to_jsonb(row) value FROM (${sql}) row`,params);return {data:result.rows.map(r=>r.value),error:null};}
   catch(error){return {data:null,error};}
  }
  return query;
 }};
}

test('NG overview keeps PP data before caps and restricts children, actual HTTP+PG', {timeout:60000},async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ng15-overview-')),data=path.join(dir,'data');
 const port=30000+Math.floor(Math.random()*20000),env={PATH:process.env.PATH,LC_ALL:'C'};
 const run=(command,args)=>execFileSync(command,args,{env,encoding:'utf8',stdio:'pipe'});
 let running=false,pool,server;const trace=[],state={failTable:null},checks=[];let requests=0;
 const pass=name=>{checks.push(name);console.log('PASS '+name);};
 try{
  run('initdb',['-D',data,'-U','postgres','-A','trust','--no-locale','--encoding=UTF8']);
  run('pg_ctl',['-D',data,'-l',path.join(dir,'pg.log'),'-o',`-F -h '' -k ${dir} -p ${port}`,'-w','start']);running=true;
  pool=new pg.Pool({host:dir,port,user:'postgres',database:'postgres',max:8});
  await pool.query("CREATE ROLE anon NOLOGIN;CREATE ROLE authenticated NOLOGIN;CREATE ROLE service_role NOLOGIN;CREATE TABLE sedes(id bigint PRIMARY KEY,nombre text,ciudad text,pais text);CREATE TABLE crm_conversations(id uuid PRIMARY KEY);INSERT INTO sedes VALUES(1,'Synthetic PP A','Synthetic A','Argentina'),(2,'Synthetic PP B','Synthetic B','Argentina'),(3,'Synthetic Empty PP','Synthetic C','Argentina')");
  await pool.query(fs.readFileSync(new URL('../sql/20261005170000_next_generation_operations.sql',import.meta.url),'utf8'));
  await pool.query(`INSERT INTO ng_sesiones(id,sede_id,nombre_publico,categoria,cupo,estado,comienza_at) SELECT md5('session'||n)::uuid,n,'Synthetic session '||n,'U18',36,'programada','2027-02-01' FROM generate_series(1,2)n;
   INSERT INTO ng_solicitudes_sede(canonical_sede_id,sede_club,estado) SELECT n,'Synthetic venue '||n,'aprobada' FROM generate_series(1,2)n;
   INSERT INTO ng_inscripciones(id,sede_id,sesion_id,contacto_nombre,categoria,estado,created_at) SELECT md5('registrationB'||n)::uuid,2,md5('session2')::uuid,'Synthetic B '||n,'U18','confirmada','2027-01-02'::timestamp+n*interval '1 second' FROM generate_series(1,2000)n;
   INSERT INTO ng_inscripcion_participantes(id,inscripcion_id,nombre,categoria,created_at) SELECT md5('participantB'||n)::uuid,md5('registrationB'||(1+n%2000))::uuid,'Synthetic participant B '||n,'U18','2027-01-01' FROM generate_series(1,5000)n;
   INSERT INTO ng_inscripcion_eventos(id,inscripcion_id,tipo,created_at) SELECT md5('eventB'||n)::uuid,md5('registrationB'||(1+n%2000))::uuid,'synthetic_B','2027-01-01'::timestamp+n*interval '1 second' FROM generate_series(1,10000)n;
   INSERT INTO ng_inscripciones(id,sede_id,sesion_id,contacto_nombre,categoria,estado,created_at) SELECT md5('registrationA'||n)::uuid,1,md5('session1')::uuid,'Synthetic A '||n,'U18','confirmada','2026-12-01' FROM generate_series(1,36)n;
   INSERT INTO ng_inscripcion_participantes(id,inscripcion_id,nombre,categoria,created_at) SELECT md5('participantA'||n)::uuid,md5('registrationA'||n)::uuid,'Synthetic participant A '||n,'U18','2027-02-01' FROM generate_series(1,36)n;
   INSERT INTO ng_inscripcion_eventos(id,inscripcion_id,tipo,created_at) SELECT md5('eventA'||n)::uuid,md5('registrationA'||n)::uuid,'synthetic_A','2027-02-01' FROM generate_series(1,36)n;`);
  const scopes={a:{rol:'admin_club',sedeId:1},b:{rol:'admin_club',sedeId:2},empty:{rol:'admin_club',sedeId:3},super:{rol:'super_admin',superA:true},player:{rol:'jugador'},employee:{rol:'empleado',sedeId:1}};
  const app=express();registerNextGenerationAdminRoutes(app,{supabaseAdmin:createDb(pool,trace,state),adminListScopeFromRequest:async req=>scopes[req.headers.authorization?.replace('Bearer ','')]||null});
  server=app.listen(0,'127.0.0.1');await once(server,'listening');
  const get=async(actor='a',suffix='')=>{requests++;const r=await fetch(`http://127.0.0.1:${server.address().port}/api/admin/next-generation/overview${suffix}`,{headers:actor?{authorization:'Bearer '+actor}:{}});return {status:r.status,cache:r.headers.get('cache-control'),body:await r.json()};};
  const first=await get();assert.equal(first.status,200);assert.equal(first.body.inscripciones.length,BEFORE?0:36);console.log('REGISTRATION_CAP',JSON.stringify({observed:first.body.inscripciones.length,expectedOwn:36}));
  await pool.query("UPDATE ng_inscripciones SET created_at='2027-03-01' WHERE sede_id=1");trace.length=0;
  const details=await get();assert.equal(details.status,200);assert.equal(details.body.inscripciones.length,36);
  const participants=details.body.inscripciones.reduce((n,r)=>n+r.participantes.length,0),events=details.body.inscripciones.reduce((n,r)=>n+r.eventos.length,0);
  assert.equal(participants,BEFORE?0:36);assert.equal(events,BEFORE?0:36);console.log('CHILD_CAPS',JSON.stringify({participants,events,expectedEach:36}));
  if(BEFORE)return;
  assert.equal(details.cache,'private, no-store');
  assert.ok(details.body.inscripciones.every(r=>Number(r.sede_id)===1&&r.participantes.every(p=>p.nombre.includes(' A '))&&r.eventos.every(e=>e.tipo==='synthetic_A')));
  assert.deepEqual(details.body.participants,details.body.inscripciones);assert.deepEqual(details.body.sessions,details.body.jornadas);
  pass('36 own registrations and children survive other PP saturation, same DTO/cache');
  const scopedReads=trace.filter(q=>['ng_inscripcion_participantes','ng_inscripcion_eventos'].includes(q.table));
  assert.equal(scopedReads.length,2);assert.ok(scopedReads.every(q=>q.filters.some(([key,op,ids])=>key==='inscripcion_id'&&op==='in'&&ids.length===36)));
  pass('pilot children only requested by the 36 authorized registration IDs');
  const other=await get('b');assert.equal(other.status,200);assert.equal(other.body.inscripciones.length,2000);assert.ok(other.body.inscripciones.every(r=>Number(r.sede_id)===2));
  const spoof=await get('a','?sede_id=2&scope=super_admin');assert.equal(spoof.body.inscripciones.length,36);assert.ok(spoof.body.inscripciones.every(r=>Number(r.sede_id)===1));pass('both venue scopes isolate data and forged query scope is ignored');
  trace.length=0;const global=await get('super');assert.equal(global.status,200);assert.equal(global.body.inscripciones.length,2000);assert.equal(global.body.jornadas.length,2);assert.equal(global.body.sedes.length,3);assert.ok(trace.filter(q=>['ng_inscripcion_participantes','ng_inscripcion_eventos'].includes(q.table)).every(q=>q.filters.length===0));pass('SuperAdmin retains existing global limits, DTO and broad read behavior');
  trace.length=0;const empty=await get('empty');assert.equal(empty.status,200);assert.equal(empty.body.inscripciones.length,0);assert.ok(!trace.some(q=>['ng_inscripcion_participantes','ng_inscripcion_eventos'].includes(q.table)));pass('empty authorized scope makes zero child queries');
  trace.length=0;assert.equal((await get(null)).status,401);assert.equal((await get('player')).status,403);assert.equal((await get('employee')).status,403);assert.equal(trace.length,0);pass('existing unauthenticated/player/employee guards precede all reads');
  state.failTable='ng_inscripcion_eventos';const failed=await get('a');assert.equal(failed.status,503);assert.equal(failed.body.code,'NG_SCHEMA_UNAVAILABLE');state.failTable=null;assert.equal((await get('a')).status,200);pass('child read failure is explicit503, retry succeeds rather than false empty success');
  // Stress only: not a new cohort or a commercial capacity assumption.
  await pool.query("INSERT INTO ng_inscripciones(id,sede_id,sesion_id,contacto_nombre,categoria,estado,created_at) SELECT md5('stressA'||n)::uuid,1,md5('session1')::uuid,'Synthetic stress '||n,'U18','borrador','2027-03-02' FROM generate_series(1,201)n");
  trace.length=0;assert.equal((await get('a')).body.inscripciones.length,237);
  const batched=trace.filter(q=>['ng_inscripcion_participantes','ng_inscripcion_eventos'].includes(q.table));assert.equal(batched.length,6);assert.ok(batched.every(q=>q.filters[0][2].length<=100));assert.equal(trace.length,10);pass('237 parents use bounded100-ID batches, ten queries total not per-record reads');
  await pool.query(`WITH parents AS(SELECT id,row_number() OVER(ORDER BY id)-1 AS rn FROM ng_inscripciones WHERE sede_id=1)
   INSERT INTO ng_inscripcion_participantes(id,inscripcion_id,nombre,categoria,created_at) SELECT md5('budgetP'||n)::uuid,p.id,'Synthetic budget participant '||n,'U18','2027-04-01' FROM generate_series(1,6000)n JOIN parents p ON p.rn=n%237;
   WITH parents AS(SELECT id,row_number() OVER(ORDER BY id)-1 AS rn FROM ng_inscripciones WHERE sede_id=1)
   INSERT INTO ng_inscripcion_eventos(id,inscripcion_id,tipo,created_at) SELECT md5('budgetE'||n)::uuid,p.id,'synthetic_budget','2027-04-01'::timestamp+n*interval '1 second' FROM generate_series(1,11000)n JOIN parents p ON p.rn=n%237;`);
  trace.length=0;const capped=await get('a');assert.equal(capped.status,200);
  assert.equal(capped.body.inscripciones.reduce((n,r)=>n+r.participantes.length,0),5000);
  assert.equal(capped.body.inscripciones.reduce((n,r)=>n+r.eventos.length,0),10000);
  assert.ok(trace.filter(q=>['ng_inscripcion_participantes','ng_inscripcion_eventos'].includes(q.table)).every(q=>q.filters[0][2].length<=100));
  assert.ok(trace.length<=10);pass('shared budgets cap all batches at5000participants/10000events, not per batch');
  console.log('RESULT',JSON.stringify({checks:checks.length,requests,schema:'exact existing NG migration, minimum referenced sedes/CRM parents',auth:'synthetic scoped actors, not JWT/RLS'}));
 }catch(error){const log=path.join(dir,'pg.log');if(fs.existsSync(log))console.error('LOCAL_PG_DIAGNOSTIC',fs.readFileSync(log,'utf8').slice(-1500));throw error;}
 finally{
  if(server)await new Promise(resolve=>{server.close(resolve);server.closeAllConnections?.();});await pool?.end();
  if(running)run('pg_ctl',['-D',data,'-m','immediate','-w','stop']);assert.ok(dir.startsWith(path.join(os.tmpdir(),'ng15-overview-')));fs.rmSync(dir,{recursive:true,force:true});console.log('CLEANUP_OWN_NG15_CLUSTER');
 }
});
