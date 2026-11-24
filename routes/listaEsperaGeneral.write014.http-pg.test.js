// LOCAL ONLY. Exact repository DDL, actual handlers, real PostgreSQL uniqueness.
// Synthetic adapter faults below are explicitly NOT real constraint conflicts.
import test, {before,after,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import pg from 'pg';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {once} from 'node:events';
import {mountListaEsperaGeneralRoutes} from './listaEsperaGeneral.js';

const BIN='/opt/homebrew/bin/',PORT=55491,USER='postgres';
const CHILD_ENV={PATH:'/usr/bin:/bin',LC_ALL:'C'};
const U1='00000000-0000-4000-8000-000000000001',U2='00000000-0000-4000-8000-000000000002';
const BODY={sede_id:7,deporte:'padbol'},TABLE='lista_espera_general';
let root,data,socket,pool,server,base,started=false,gate=null,fault=null,recovering=false,recoveryReads=0;
let snapshots=[],conflicts=0;const tuple=(s,u,d)=>({sede_id:s,user_id:u,deporte:d});
const run=(name,args)=>execFileSync(BIN+name,args,{env:CHILD_ENV,encoding:'utf8',stdio:'pipe',timeout:10000});
const bounded=async(promise,ms=5000)=>{let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Fixture timeout')),ms);})]);}finally{clearTimeout(timer);}};
const ident=value=>{assert.match(value,/^[a-z_][a-z0-9_]*$/);return '"'+value+'"';};
async function cleanup(){
 if(server){const current=server;server=null;await bounded(new Promise(resolve=>{current.close(resolve);current.closeAllConnections?.();}));}
 if(pool){const current=pool;pool=null;await bounded(current.end());}
 if(root){
  assert.ok(root.startsWith(path.join(os.tmpdir(),'waitlist014-root-'))&&path.dirname(data)===root);
  if(started||fs.existsSync(path.join(data,'postmaster.pid')))run('pg_ctl',['-D',data,'-m','immediate','-w','stop']);
  started=false;fs.rmSync(root,{recursive:true,force:true});console.log('OWN_PG_STOPPED_AND_DIRECTORY_REMOVED');root=null;
 }
}
function adapter(){return {from(table){
 assert.ok(['sedes',TABLE].includes(table));
 let action='read',payload,columns='*',single=false,limit,order;const filters=[];
 const q={select(v){columns=v||'*';return q;},insert(v){action='insert';payload=v;return q;},delete(){action='delete';return q;},eq(k,v){filters.push([k,v]);return q;},order(k,{ascending=true}={}){order=[k,ascending?'ASC':'DESC'];return q;},limit(n){limit=n;return q;},single(){single=true;return execute();},maybeSingle(){single=true;return execute();},then(a,b){return execute().then(a,b);}};
 async function execute(){
  if(table===TABLE&&action==='insert'&&fault){recovering=true;return {data:null,error:{code:fault==='other-error'?'23503':'23505',message:'Synthetic insertion fault'}};}
  const exact=table===TABLE&&action==='read'&&['sede_id','user_id','deporte'].every(k=>filters.some(([key])=>key===k));
  if(exact&&recovering){recoveryReads++;if(fault==='reread-error')return {data:null,error:{code:'XX000',message:'Synthetic reread error'}};if(fault==='reread-throw')throw new Error('Synthetic reread exception');if(fault==='reread-missing')return {data:null,error:null};}
  const params=[],projection=columns==='*'?'*':columns.split(',').map(x=>ident(x.trim())).join(',');
  const where=filters.map(([k,v])=>{params.push(v);return `${ident(k)}=$${params.length}`;});
  let sql;
  if(action==='insert'){
   const keys=Object.keys(payload);params.push(...keys.map(k=>payload[k]));sql=`INSERT INTO public.${ident(table)}(${keys.map(ident).join(',')}) VALUES(${keys.map((_,n)=>'$'+(n+1)).join(',')}) RETURNING ${projection}`;
  }else{sql=action==='delete'?`DELETE FROM public.${ident(table)}`:`SELECT ${projection} FROM public.${ident(table)}`;if(where.length)sql+=' WHERE '+where.join(' AND ');if(action==='delete')sql+=' RETURNING '+projection;else{if(order)sql+=` ORDER BY ${ident(order[0])} ${order[1]}`;if(limit!==undefined){assert.ok(Number.isInteger(limit)&&limit>0);params.push(limit);sql+=` LIMIT $${params.length}`;}}}
  let client;
  try{
   client=await pool.connect();
   const result=await client.query(sql,params);
   // Crucially: execute both SELECTs FIRST, retain both distinct leases, and
   // capture their empty snapshots before either handler can attempt INSERT.
   if(exact&&gate&&snapshots.length<2){
    assert.equal(result.rows.length,0);snapshots.push({empty:true,pid:client.processID});
    if(snapshots.length===2)gate.release();await bounded(gate.promise,2000);
   }
   if(single&&result.rows.length>1)return {data:null,error:{code:'PGRST116',message:'Multiple rows'}};
   return {data:single?(result.rows[0]??null):result.rows,error:null};
  }catch(error){if(action==='insert'&&error.code==='23505')conflicts++;return {data:null,error};}
  finally{client?.release();}
 }
 return q;
}};}
async function call(method,url,{auth='u1',body}={}){
 const response=await fetch(base+url,{method,signal:AbortSignal.timeout(5000),headers:{...(auth?{authorization:'Bearer '+auth}:{}),...(body?{'content-type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
 return {status:response.status,body:await response.json()};
}
const rows=async()=>(await pool.query('SELECT sede_id,user_id,deporte FROM lista_espera_general ORDER BY sede_id,user_id,deporte')).rows;
const status=()=>call('GET','/api/lista-espera-general?sede_id=7&deporte=padbol');
before(async()=>{
 try{
  root=fs.mkdtempSync(path.join(os.tmpdir(),'waitlist014-root-'));data=path.join(root,'data');socket=path.join(root,'socket');fs.mkdirSync(socket);
  run('initdb',['-D',data,'-A','trust','-U',USER,'--no-locale','-E','UTF8']);
  run('pg_ctl',['-D',data,'-l',path.join(root,'postgres.log'),'-o',`-F -h '' -k ${socket} -p ${PORT}`,'-w','start']);started=true;
  pool=new pg.Pool({host:socket,port:PORT,user:USER,database:'postgres',max:8,connectionTimeoutMillis:3000,query_timeout:5000});
  assert.equal((await pool.query('SHOW listen_addresses')).rows[0].listen_addresses,'');
  await pool.query('CREATE SCHEMA auth;CREATE TABLE auth.users(id uuid PRIMARY KEY);CREATE TABLE public.sedes(id integer PRIMARY KEY)');
  await pool.query(fs.readFileSync(new URL('../docs/sql/lista_espera_general.sql',import.meta.url),'utf8'));
  await pool.query('INSERT INTO sedes VALUES(7),(8)');
  await pool.query('INSERT INTO auth.users VALUES($1),($2)',[U1,U2]);
  const app=express();app.use(express.json());mountListaEsperaGeneralRoutes(app,{supabaseAdmin:adapter(),getAuthenticatedUser:async req=>{const id=req.headers.authorization==='Bearer u1'?U1:req.headers.authorization==='Bearer u2'?U2:null;return id?{user:{id}}:{user:null,status:401,error:'No autorizado'};},fetchUserRoleRowForAuthUser:async()=>({role:'admin_club',sede_id:7}),legacySuperAdminEmails:[]});
  server=app.listen(0,'127.0.0.1');await bounded(once(server,'listening'));base=`http://127.0.0.1:${server.address().port}`;
 }catch(error){if(root&&fs.existsSync(path.join(root,'postgres.log')))console.error(fs.readFileSync(path.join(root,'postgres.log'),'utf8').slice(-1200));await cleanup();throw error;}
});
after(cleanup);
beforeEach(async()=>{await pool.query('TRUNCATE lista_espera_general RESTART IDENTITY');gate=null;fault=null;recovering=false;recoveryReads=0;snapshots=[];conflicts=0;});

test('two completed empty snapshots on distinct PG connections recover the real unique race', {timeout:10000},async()=>{
 let release;gate={promise:new Promise(r=>release=r),release:()=>release()};
 const result=await Promise.all([call('POST','/api/lista-espera-general',{body:BODY}),call('POST','/api/lista-espera-general',{body:BODY})]);gate=null;
 assert.equal(snapshots.length,2);assert.ok(snapshots.every(s=>s.empty));assert.equal(new Set(snapshots.map(s=>s.pid)).size,2);assert.equal(conflicts,1);
 console.log('DETERMINISTIC_RACE',JSON.stringify({emptySnapshots:2,distinctBackendPids:2,realUniqueViolations:conflicts,statuses:result.map(r=>r.status)}));
 assert.deepEqual(result.map(r=>r.status).sort(),[200,201]);
 assert.equal(result[0].body.entry.id,result[1].body.entry.id);
 for(const response of result){assert.equal(response.body.ok,true);assert.equal(response.body.registrado,true);assert.deepEqual(tuple(response.body.entry.sede_id,response.body.entry.user_id,response.body.entry.deporte),tuple(7,U1,'padbol'));assert.equal(response.body.already_registered,response.status===200);}
 assert.deepEqual(await rows(),[tuple(7,U1,'padbol')]);
 const retry=await call('POST','/api/lista-espera-general',{body:BODY});assert.equal(retry.status,200);assert.equal(retry.body.already_registered,true);assert.equal(retry.body.entry.id,result[0].body.entry.id);assert.equal((await rows()).length,1);
});
test('own GET, forged owner, sport/PP/user isolation, scoped deletion and delete retry', {timeout:10000},async()=>{
 assert.deepEqual((await status()).body,{registrado:false,deporte:null});
 const created=await call('POST','/api/lista-espera-general',{body:{...BODY,user_id:U2}});assert.equal(created.status,201);assert.equal(created.body.entry.user_id,U1);
 assert.deepEqual((await status()).body,{registrado:true,deporte:'padbol'});
 assert.equal((await call('POST','/api/lista-espera-general',{body:{...BODY,deporte:'padel'}})).status,201);
 assert.equal((await call('POST','/api/lista-espera-general',{body:{...BODY,sede_id:8}})).status,201);
 assert.equal((await call('POST','/api/lista-espera-general',{auth:'u2',body:BODY})).status,201);
 const del=await call('DELETE','/api/lista-espera-general?sede_id=7&deporte=padbol');assert.equal(del.status,200);assert.equal(del.body.removed,true);
 assert.deepEqual((await status()).body,{registrado:false,deporte:null});
 const retry=await call('DELETE','/api/lista-espera-general?sede_id=7&deporte=padbol');assert.equal(retry.status,200);assert.equal(retry.body.removed,false);
 assert.deepEqual(await rows(),[tuple(7,U1,'padel'),tuple(7,U2,'padbol'),tuple(8,U1,'padbol')]);
});
test('unauthenticated GET/POST/DELETE cannot read or mutate a tuple', {timeout:10000},async()=>{
 for(const method of ['GET','POST','DELETE'])assert.equal((await call(method,'/api/lista-espera-general?sede_id=7&deporte=padbol',{auth:null,body:method==='POST'?{...BODY,user_id:U1}:undefined})).status,401);
 assert.deepEqual(await rows(),[]);
});
for(const mode of ['reread-missing','reread-error','reread-throw','other-error'])test('synthetic adapter fault fails closed: '+mode,{timeout:10000},async()=>{
 fault=mode;const response=await call('POST','/api/lista-espera-general',{body:BODY});
 assert.equal(response.status,500);assert.equal(response.body.registrado,undefined);assert.equal(response.body.entry,undefined);assert.deepEqual(await rows(),[]);assert.equal(recoveryReads,mode==='other-error'?0:1);
 console.log('SYNTHETIC_FAULT',mode,'no false success');
});
