// LOCAL ONLY: actual NG admin handler + exact repository NG-026 catalog/DDL on own PostgreSQL.
// Synthetic venues/requests/rows; no families, Auth, production or external API.
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
import {catalog} from './nextGenerationUuid026.fixture.mjs';

const BEFORE=process.env.NG15_REPRO_BEFORE==='1';
const VA='00000000-0000-4000-8000-000000000101',VB='00000000-0000-4000-8000-000000000102',VC='00000000-0000-4000-8000-000000000103';
const SID='00000000-0000-4000-8000-000000000001',SID2='00000000-0000-4000-8000-000000000002';
const identifier=value=>{assert.match(value,/^[a-z_][a-z0-9_]*$/);return '"'+value+'"';};
const privileges={r:'SELECT',a:'INSERT',w:'UPDATE',d:'DELETE',D:'TRUNCATE',x:'REFERENCES',t:'TRIGGER',m:'MAINTAIN'};

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
 const port=30000+Math.floor(Math.random()*20000),env={PATH:'/usr/bin:/bin:/opt/homebrew/bin',LC_ALL:'C'};
 const run=(command,args)=>execFileSync(command,args,{env,encoding:'utf8',stdio:'pipe'});
 let running=false,pool,server;const trace=[],state={failTable:null},checks=[];let requests=0;
 const pass=name=>{checks.push(name);console.log('PASS '+name);};
 try{
  run('initdb',['-D',data,'-U','postgres','-A','trust','--no-locale','--encoding=UTF8']);
  run('pg_ctl',['-D',data,'-l',path.join(dir,'pg.log'),'-o',`-F -h '' -k ${dir} -p ${port}`,'-w','start']);running=true;
  pool=new pg.Pool({host:dir,port,user:'postgres',database:'postgres',max:8});
  if((await pool.query('SHOW listen_addresses')).rows[0].listen_addresses!=='')throw Error('Fixture must be socket only');
  await pool.query('CREATE ROLE anon NOLOGIN;CREATE ROLE authenticated NOLOGIN;CREATE ROLE service_role NOLOGIN BYPASSRLS;CREATE SCHEMA auth');
  // Exact QA NG-026 catalog footprint, with only FK parent stubs outside it.
  const tableNames=new Set(catalog.tables.map(t=>t.name));
  for(const parent of catalog.foreign_parent_columns)if(parent.schema!=='public'||!tableNames.has(parent.table))await pool.query(`CREATE TABLE IF NOT EXISTS ${identifier(parent.schema)}.${identifier(parent.table)}(${identifier(parent.column)} ${parent.type} PRIMARY KEY)`);
  for(const col of catalog.columns)if(col.default?.startsWith('nextval(')){const sequence=col.default.match(/nextval\('([^']+)'/)[1];await pool.query('CREATE SEQUENCE '+identifier(sequence));}
  for(const t of catalog.tables){const columns=catalog.columns.filter(c=>c.table===t.name).map(c=>`${identifier(c.column)} ${c.type}${c.identity?` GENERATED ${c.identity==='a'?'ALWAYS':'BY DEFAULT'} AS IDENTITY`:c.default?' DEFAULT '+c.default:''}${c.not_null?' NOT NULL':''}`);await pool.query(`CREATE TABLE public.${identifier(t.name)}(${columns.join(',')})`);}
  for(const fk of [false,true])for(const c of catalog.constraints)if((c.kind==='f')===fk)await pool.query(`ALTER TABLE public.${identifier(c.table)} ADD CONSTRAINT ${identifier(c.name)} ${c.definition}`);
  for(const i of catalog.indexes)if(!catalog.constraints.some(c=>c.name===i.name))await pool.query(i.definition);
  for(const t of catalog.tables){if(t.rls)await pool.query(`ALTER TABLE ${identifier(t.name)} ENABLE ROW LEVEL SECURITY`);if(t.force_rls)await pool.query(`ALTER TABLE ${identifier(t.name)} FORCE ROW LEVEL SECURITY`);
   for(const entry of (t.acl||'{}').slice(1,-1).split(',').filter(Boolean)){const [role,tail]=entry.split('=');const rights=tail.split('/')[0].replaceAll('*','').split('').map(c=>privileges[c]);if(rights.length)await pool.query(`GRANT ${rights.join(',')} ON ${identifier(t.name)} TO ${role?identifier(role):'PUBLIC'}`);}}
  for(const f of catalog.functions){await pool.query(f.definition);const args=f.args.split(',').map(a=>a.trim().split(/\s+/).slice(1).join(' ')).join(',');await pool.query(`REVOKE ALL ON FUNCTION public.${identifier(f.name)}(${args}) FROM PUBLIC,anon,authenticated;GRANT EXECUTE ON FUNCTION public.${identifier(f.name)}(${args}) TO service_role`);}
  await pool.query(fs.readFileSync(new URL('../sql/candidates/20261124_nextgen_uuid_compat026.sql',import.meta.url),'utf8'));
  await pool.query("INSERT INTO sedes(id,nombre,pais,ciudad,cantidad_canchas,horario_apertura,horario_cierre,precio_por_reserva,whatsapp_contacto) VALUES(1,'Synthetic PP A','AR','Synthetic A',1,'08:00','23:00',0,'+541155550000'),(2,'Synthetic PP B','AR','Synthetic B',1,'08:00','23:00',0,'+541155550000'),(3,'Synthetic Empty PP','AR','Synthetic C',1,'08:00','23:00',0,'+541155550000')");
  await pool.query("INSERT INTO ng_solicitudes_sede(id,canonical_sede_id,nombre,sede_club,ciudad,pais,email,whatsapp,motivo_solicitud,direccion,consentimiento_datos,estado) VALUES($1,1,'Synthetic contact A','Synthetic PP A','Synthetic A','AR','a@example.invalid','+541155550000','conocer','Address A',true,'aprobada'),($2,2,'Synthetic contact B','Synthetic PP B','Synthetic B','AR','b@example.invalid','+541155550000','conocer','Address B',true,'aprobada'),($3,3,'Synthetic contact C','Synthetic Empty PP','Synthetic C','AR','c@example.invalid','+541155550000','conocer','Address C',true,'aprobada')",[VA,VB,VC]);
  await pool.query("INSERT INTO ng_sesiones(id,sede_id,nombre_publico,ciudad,pais,categoria,comienza_at,termina_at,cupo,estado,creado_por) VALUES($1,$2,'Synthetic session 1','Synthetic A','AR','Sub-18','2027-02-01T18:00:00Z','2027-02-01T19:00:00Z',36,'publicada','fixture@example.invalid'),($3,$4,'Synthetic session 2','Synthetic B','AR','Sub-18','2027-02-01T18:00:00Z','2027-02-01T19:00:00Z',36,'publicada','fixture@example.invalid')",[SID,VA,SID2,VB]);
  await pool.query(`INSERT INTO ng_inscripciones(id,sesion_id,sede_id,idempotency_key,payload_hash,contacto_nombre,contacto_email,contacto_whatsapp,consentimiento_datos,consentimiento_terminos,version_privacidad,version_terminos,categoria,estado,created_at)
   SELECT md5('registrationB'||n)::uuid,$1,2,md5('registrationB'||n)::uuid,'synthetic-hash','Synthetic B '||n,'b'||n||'@example.invalid','+541155550000',true,true,'synthetic-v1','synthetic-v1','Sub-18','confirmada','2027-01-02'::timestamptz+n*interval '1 second' FROM generate_series(1,2000)n;`, [SID2]);
  await pool.query(`INSERT INTO ng_inscripcion_participantes(id,inscripcion_id,nombre,categoria,created_at)
   SELECT md5('participantB'||n)::uuid,md5('registrationB'||(1+n%2000))::uuid,'Synthetic participant B '||n,'Sub-18','2027-01-01' FROM generate_series(1,5000)n;`);
  await pool.query(`INSERT INTO ng_inscripcion_eventos(inscripcion_id,sesion_id,tipo,actor,detalle,created_at)
   SELECT md5('registrationB'||(1+n%2000))::uuid,$1,'cancelada','fixture','{"fixture":true}'::jsonb,'2027-01-01'::timestamptz+n*interval '1 second' FROM generate_series(1,10000)n;`, [SID2]);
  await pool.query(`INSERT INTO ng_inscripciones(id,sesion_id,sede_id,idempotency_key,payload_hash,contacto_nombre,contacto_email,contacto_whatsapp,consentimiento_datos,consentimiento_terminos,version_privacidad,version_terminos,categoria,estado,created_at)
   SELECT md5('registrationA'||n)::uuid,$1,1,md5('registrationA'||n)::uuid,'synthetic-hash','Synthetic A '||n,'a'||n||'@example.invalid','+541155550000',true,true,'synthetic-v1','synthetic-v1','Sub-18','confirmada','2026-12-01' FROM generate_series(1,36)n;`, [SID]);
  await pool.query(`INSERT INTO ng_inscripcion_participantes(id,inscripcion_id,nombre,categoria,created_at)
   SELECT md5('participantA'||n)::uuid,md5('registrationA'||n)::uuid,'Synthetic participant A '||n,'Sub-18','2027-02-01' FROM generate_series(1,36)n;`);
  await pool.query(`INSERT INTO ng_inscripcion_eventos(inscripcion_id,sesion_id,tipo,actor,detalle,created_at)
   SELECT md5('registrationA'||n)::uuid,$1,'corregida','fixture','{"fixture":true}'::jsonb,'2027-02-01' FROM generate_series(1,36)n;`, [SID]);
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
  assert.ok(details.body.inscripciones.every(r=>Number(r.sede_id)===1&&r.participantes.every(p=>p.nombre.includes(' A '))&&r.eventos.every(e=>e.tipo==='corregida')));
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
  await pool.query(`INSERT INTO ng_inscripciones(id,sesion_id,sede_id,idempotency_key,payload_hash,contacto_nombre,contacto_email,contacto_whatsapp,consentimiento_datos,consentimiento_terminos,version_privacidad,version_terminos,categoria,estado,created_at)
   SELECT md5('stressA'||n)::uuid,$1,1,md5('stressA'||n)::uuid,'synthetic-hash','Synthetic stress '||n,'stress'||n||'@example.invalid','+541155550000',true,true,'synthetic-v1','synthetic-v1','Sub-18','borrador','2027-03-02' FROM generate_series(1,201)n;`, [SID]);
  trace.length=0;assert.equal((await get('a')).body.inscripciones.length,237);
  const batched=trace.filter(q=>['ng_inscripcion_participantes','ng_inscripcion_eventos'].includes(q.table));assert.equal(batched.length,6);assert.ok(batched.every(q=>q.filters[0][2].length<=100));assert.equal(trace.length,10);pass('237 parents use bounded100-ID batches, ten queries total not per-record reads');
  await pool.query(`WITH parents AS(SELECT id,row_number() OVER(ORDER BY id)-1 AS rn FROM ng_inscripciones WHERE sede_id=1)
   INSERT INTO ng_inscripcion_participantes(id,inscripcion_id,nombre,categoria,created_at) SELECT md5('budgetP'||n)::uuid,p.id,'Synthetic budget participant '||n,'Sub-18','2027-04-01' FROM generate_series(1,6000)n JOIN parents p ON p.rn=n%237;`);
  await pool.query(`WITH parents AS(SELECT id,row_number() OVER(ORDER BY id)-1 AS rn FROM ng_inscripciones WHERE sede_id=1)
   INSERT INTO ng_inscripcion_eventos(inscripcion_id,sesion_id,tipo,actor,detalle,created_at) SELECT p.id,$1,'corregida','fixture','{"fixture":true}'::jsonb,'2027-04-01'::timestamptz+n*interval '1 second' FROM generate_series(1,11000)n JOIN parents p ON p.rn=n%237;`, [SID]);
  trace.length=0;const capped=await get('a');assert.equal(capped.status,200);
  assert.equal(capped.body.inscripciones.reduce((n,r)=>n+r.participantes.length,0),5000);
  assert.equal(capped.body.inscripciones.reduce((n,r)=>n+r.eventos.length,0),10000);
  assert.ok(trace.filter(q=>['ng_inscripcion_participantes','ng_inscripcion_eventos'].includes(q.table)).every(q=>q.filters[0][2].length<=100));
  assert.ok(trace.length<=10);pass('shared budgets cap all batches at5000participants/10000events, not per batch');
  console.log('RESULT',JSON.stringify({checks:checks.length,requests,schema:'exact existing NG-026 catalog/migration',auth:'synthetic scoped actors, not JWT/RLS'}));
 }catch(error){const log=path.join(dir,'pg.log');if(fs.existsSync(log))console.error('LOCAL_PG_DIAGNOSTIC',fs.readFileSync(log,'utf8').slice(-1500));throw error;}
 finally{
  if(server)await new Promise(resolve=>{server.close(resolve);server.closeAllConnections?.();});await pool?.end();
  if(running)run('pg_ctl',['-D',data,'-m','immediate','-w','stop']);assert.ok(dir.startsWith(path.join(os.tmpdir(),'ng15-overview-')));fs.rmSync(dir,{recursive:true,force:true});console.log('CLEANUP_OWN_NG15_CLUSTER');
 }
});
