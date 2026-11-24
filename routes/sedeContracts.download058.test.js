import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import crypto from 'node:crypto';import {execFileSync} from 'node:child_process';import {once}from'node:events';import express from 'express';import pg from 'pg';
import {mountSedeContractsRoutes}from './sedeContracts.js';import{createSedeContractPrivateStorage}from '../lib/sedeContractPrivateStorage.js';
const ACTOR_A='11111111-1111-4111-8111-111111111111',ACTOR_B='22222222-2222-4222-8222-222222222222',ACTOR_C='33333333-3333-4333-8333-333333333333';
const ID='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',PDF=Buffer.from('%PDF-1.7\nsynthetic058\n%%EOF\n'),SHA=crypto.createHash('sha256').update(PDF).digest('hex'),STORAGE_PATH=`501/${ID}/${SHA}.pdf`,PORT=55510;
// Exact base schema reused as source from frozen053 test; no schema assertions fabricated.
const BASE_SCHEMA_SQL = `
create table public.sedes(id bigint primary key, nombre text not null);
create table public.user_roles(
  id bigint not null,
  user_id uuid,
  role text not null,
  pais text,
  sede_id bigint,
  created_at timestamp without time zone default now(),
  email text,
  nombre text,
  torneos_oficiales_habilitados boolean default false,
  alcance text default 'sede',
  ciudad text,
  provincia text,
  organizacion_id uuid
);
create table public.contratos_sedes(
  id uuid primary key default gen_random_uuid(),
  sede_id integer,
  fecha_inicio date not null,
  fecha_vencimiento date,
  referencia text,
  archivo_url text,
  created_at timestamp with time zone default now(),
  constraint contratos_sedes_sede_id_fkey foreign key (sede_id)
    references public.sedes(id) on delete cascade
);
insert into public.sedes(id, nombre) values
  (501, 'Sede Fixture 501'), (502, 'Sede Fixture 502');
insert into public.user_roles(id, user_id, role, alcance, sede_id, email) values
  (1, '${ACTOR_A}', 'super_admin', 'global', null, 'super@fixture.invalid'),
  (2, '${ACTOR_B}', 'admin_club', 'sede', 501, 'club@fixture.invalid'),
  (3, '${ACTOR_C}', 'super_admin', 'global', null, 'other@fixture.invalid');
`;

const STORAGE_SCHEMA_SQL = `
create schema storage;
create table storage.buckets(
  id text primary key,
  name text,
  public boolean,
  file_size_limit bigint,
  allowed_mime_types text[]
);
create table storage.objects(id uuid primary key default gen_random_uuid(), bucket_id text, name text);
alter table storage.objects enable row level security;
`;


let cluster,pool;const run=(name,args)=>execFileSync('/opt/homebrew/bin/'+name,args,{env:{PATH:'/opt/homebrew/bin:/usr/bin:/bin',LC_ALL:'C'},timeout:20000,encoding:'utf8'});
before(async()=>{const root=fs.mkdtempSync(path.join(os.tmpdir(),'contract058-'));cluster={root,data:path.join(root,'data'),socket:path.join(root,'socket'),running:false};fs.mkdirSync(cluster.socket);run('initdb',['-D',cluster.data,'-U','postgres','-A','trust','--no-locale','-E','UTF8']);run('pg_ctl',['-D',cluster.data,'-l',path.join(root,'pg.log'),'-o',`-F -h '' -k ${cluster.socket} -p ${PORT}`,'-w','start']);cluster.running=true;pool=new pg.Pool({host:cluster.socket,port:PORT,user:'postgres',database:'postgres',max:5,query_timeout:12000,connectionTimeoutMillis:2000});assert.equal((await pool.query('show listen_addresses')).rows[0].listen_addresses,'');assert.match((await pool.query('show server_version')).rows[0].server_version,/^17\./);console.log('OWN_PG058',JSON.stringify({pid:Number(fs.readFileSync(path.join(cluster.data,'postmaster.pid'),'utf8').split('\n')[0]),socketOnly:true}));});
after(async()=>{await pool?.end();if(cluster?.running)run('pg_ctl',['-D',cluster.data,'-m','fast','-w','stop']);if(cluster){assert.equal(fs.existsSync(path.join(cluster.socket,`.s.PGSQL.${PORT}`)),false);fs.rmSync(cluster.root,{recursive:true});console.log('CLEANUP_OWN_PG058 true');}});
async function start({enabled=true,column=true}={}){await pool.query('drop schema if exists public cascade;create schema public;'+BASE_SCHEMA_SQL);if(column){await pool.query('alter table contratos_sedes add column storage_path text');await pool.query('insert into contratos_sedes(id,sede_id,fecha_inicio,storage_path)values($1,501,DATE $$2026-11-24$$,$2)',[ID,STORAGE_PATH]);}
 const state={bucket:0,downloads:0,public:false,bytes:PDF,mime:'application/pdf',hold:null};const sdk={getBucket:async name=>{assert.equal(name,'contratos-sedes-privados');state.bucket++;return{data:{public:state.public}};},from:name=>{assert.equal(name,'contratos-sedes-privados');return{download:async objectPath=>{assert.equal(objectPath,STORAGE_PATH);state.downloads++;if(state.hold)await state.hold;return{data:new Blob([state.bytes],{type:state.mime}),error:null};}};}};
 const sb={storage:sdk,from:table=>{assert.equal(table,'user_roles');const conditions=[];const q={select(){return q;},eq(k,v){conditions.push([k,v]);return q;},limit(){return q;},async then(resolve,reject){try{const sql=conditions.map(([k],i)=>{assert.ok(['user_id','role'].includes(k));return `${k}=$${i+1}`;}).join(' AND ');resolve({data:(await pool.query('SELECT role FROM user_roles WHERE '+sql,conditions.map(x=>x[1]))).rows,error:null});}catch(e){reject(e);}}};return q;}};
 const app=express();mountSedeContractsRoutes(app,{supabaseAdmin:sb,pgPool:pool,authUserFromBearer:async req=>req.headers.authorization==='Bearer a'?{id:ACTOR_A}:req.headers.authorization==='Bearer b'?{id:ACTOR_B}:null,privateStorage:createSedeContractPrivateStorage({supabaseAdmin:sb,enabled})});const server=app.listen(0,'127.0.0.1');await once(server,'listening');const base=`http://127.0.0.1:${server.address().port}`;return{state,async call({token='a',sede=501,id=ID}={}){const response=await fetch(`${base}/api/sedes/${sede}/contratos/${id}/archivo`,{headers:token?{Authorization:'Bearer '+token}:{}});return{response,bytes:Buffer.from(await response.arrayBuffer())};},async stop(){await new Promise(r=>{server.close(r);server.closeAllConnections?.();});}};}
const wait=async fn=>{const until=Date.now()+3000;while(!fn()){if(Date.now()>until)throw Error('Bounded barrier timeout');await new Promise(r=>setTimeout(r,5));}};
test('058 private bytes/headers match; each download checks fresh private bucket',async()=>{const fx=await start();try{for(let n=0;n<2;n++){const out=await fx.call();assert.equal(out.response.status,200);assert.deepEqual(out.bytes,PDF);assert.equal(out.response.headers.get('content-type'),'application/pdf');assert.equal(out.response.headers.get('cache-control'),'no-store');assert.equal(out.response.headers.get('x-content-type-options'),'nosniff');assert.match(out.response.headers.get('content-disposition'),/^attachment; filename="contrato-[0-9a-f-]+\.pdf"$/);}assert.equal(fx.state.bucket,2);assert.equal(fx.state.downloads,2);}finally{await fx.stop();}});
test('058 401/foreign/OFF/missing column never touches storage SDK',async()=>{for(const config of [{},{enabled:false},{column:false}]){const fx=await start(config);try{const anon=await fx.call({token:null});assert.equal(anon.response.status,401);const club=await fx.call({token:'b'});assert.equal(club.response.status,403);if(config.enabled===false||config.column===false)assert.equal((await fx.call()).response.status,503);else{assert.equal((await fx.call({sede:502})).response.status,404);assert.equal((await fx.call({id:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'})).response.status,404);}assert.equal(fx.state.bucket,0);assert.equal(fx.state.downloads,0);}finally{await fx.stop();}}});
test('058 revocation committed while SDK waits emits no private bytes',async()=>{const fx=await start();let release,pending;try{fx.state.hold=new Promise(r=>release=r);pending=fx.call();await wait(()=>fx.state.downloads===1);await pool.query("update user_roles set role='admin_club' where user_id=$1",[ACTOR_A]);release();const out=await pending;assert.equal(out.response.status,403);assert.equal(out.bytes.equals(PDF),false);}finally{release?.();await pending?.catch(()=>{});await fx.stop();}});
test('058 path changed during SDK wait emits no old bytes',async()=>{const fx=await start();let release,pending;try{fx.state.hold=new Promise(r=>release=r);pending=fx.call();await wait(()=>fx.state.downloads===1);await pool.query('update contratos_sedes set storage_path=$1 where id=$2',[`501/${ID}/${'b'.repeat(64)}.pdf`,ID]);release();const out=await pending;assert.equal(out.response.status,409);assert.equal(out.bytes.equals(PDF),false);}finally{release?.();await pending?.catch(()=>{});await fx.stop();}});
test('058 bad hash/MIME/public bucket and oversize fail closed without file bytes',async()=>{const fx=await start();try{fx.state.bytes=Buffer.from('%PDF-1.7 wronghash');assert.equal((await fx.call()).response.status,503);fx.state.bytes=PDF;fx.state.mime='text/html';assert.equal((await fx.call()).response.status,503);fx.state.mime='application/pdf';fx.state.bytes=Buffer.alloc(10*1024*1024+1);assert.equal((await fx.call()).response.status,503);fx.state.bytes=PDF;fx.state.public=true;const downloads=fx.state.downloads;assert.equal((await fx.call()).response.status,503);assert.equal(fx.state.downloads,downloads);}finally{await fx.stop();}});
