// LOCAL ONLY: real Express route/helper and exact repository migration on own PG.
// Synthetic operator scope, no Supabase/Auth/provider/files/customer data.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {once} from 'node:events';
import express from 'express';
import pg from 'pg';
import {registerClubCustomerImportRoutes} from './clubCustomerImportRoutes.js';

const ACTOR='11111111-1111-4111-8111-111111111111';
const body={provider:'generic',csv:'ID,Nombre,Email\n001,Synthetic Alpha,alpha@fixture.invalid\n002,Synthetic Beta,beta@fixture.invalid',mapping:{externalId:0,name:1,email:2}};

test('existing customer import: malformed/retry/concurrent/partial rollback on real HTTP+PG', {timeout:60000},async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'import006-'));const data=path.join(dir,'data');
 const port=30000+Math.floor(Math.random()*20000),env={PATH:process.env.PATH,LC_ALL:'C'};
 const run=(cmd,args)=>execFileSync(cmd,args,{env,encoding:'utf8',stdio:'pipe'});
 let running=false,pool,server;let connects=0,requests=0;const checks=[];
 const pass=name=>{checks.push(name);console.log('PASS '+name);};
 try{
  run('initdb',['-D',data,'-U','postgres','-A','trust','--no-locale','--encoding=UTF8']);
  run('pg_ctl',['-D',data,'-l',path.join(dir,'pg.log'),'-o',`-F -h '' -k ${dir} -p ${port}`,'-w','start']);running=true;
  pool=new pg.Pool({host:dir,port,user:'postgres',database:'postgres'});
  await pool.query('CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN');
  await pool.query(fs.readFileSync(new URL('../sql/migrations/20260911170000_club_imported_contacts.sql',import.meta.url),'utf8'));
  const routePool={query:(...args)=>pool.query(...args),connect:()=>{connects++;return pool.connect();}};
  const app=express();app.use(express.json({limit:'3mb'}));
  registerClubCustomerImportRoutes(app,{pool:routePool,enabled:true,
   resolveScope:async req=>req.headers.authorization==='Bearer admin'?{authUserId:ACTOR,rol:'admin_club'}:req.headers.authorization==='Bearer player'?{authUserId:ACTOR,rol:'jugador'}:null,
   allowedVenues:async()=>({sedes:[{id:7}]})});
  server=app.listen(0,'127.0.0.1');await once(server,'listening');const base=`http://127.0.0.1:${server.address().port}`;
  const request=async(suffix,payload,{venue=7,auth='admin'}={})=>{requests++;const r=await fetch(`${base}/api/admin/sedes/${venue}/importaciones/clientes${suffix}`,{method:'POST',headers:{'content-type':'application/json',...(auth?{authorization:`Bearer ${auth}`}:{})},body:JSON.stringify(payload)});return {status:r.status,body:await r.json()};};
  const preview=async input=>{const r=await request('/preview',input);assert.equal(r.status,200);return r.body;};
  const confirm=(input,fingerprint)=>request('/confirm',{...input,fingerprint});
  const counts=async()=>(await pool.query('SELECT (SELECT count(*)::int FROM club_imported_contacts) contacts,(SELECT count(*)::int FROM club_import_batches) batches')).rows[0];
  const empty=()=>assert.deepEqual(counts(),{contacts:0,batches:0});
  const clear=()=>pool.query('TRUNCATE club_imported_contacts,club_import_batches RESTART IDENTITY');
  for(const csv of ['ID,Nombre\n001,"unfinished','ID,Nombre\n001,"Closed"extra']){
   assert.equal((await request('/preview',{...body,csv})).status,400);
   assert.equal((await confirm({...body,csv},'stale')).status,400);
  }
  const width={...body,csv:'ID,Nombre,Email\n001,Synthetic'};const widthPreview=await preview(width);
  assert.equal(widthPreview.canConfirm,false);assert.equal((await confirm(width,widthPreview.fingerprint)).status,400);
  assert.equal(connects,0);assert.deepEqual(await counts(),{contacts:0,batches:0});pass('malformed quotes and row width block before transaction; zero persisted rows');
  const p=await preview(body);assert.equal(p.canConfirm,true);
  assert.equal((await confirm(body,'wrong-fingerprint')).status,400);assert.equal(connects,0);
  const first=await confirm(body,p.fingerprint);assert.equal(first.status,200);assert.deepEqual(first.body,{inserted:2,unchanged:0});
  const retry=await confirm(body,p.fingerprint);assert.equal(retry.status,200);assert.deepEqual(retry.body,{inserted:0,unchanged:2});assert.deepEqual(await counts(),{contacts:2,batches:2});
  pass('sequential identical retry persists exactly two contacts; batches record each attempt');
  await clear();
  const concurrent=await Promise.all([confirm(body,p.fingerprint),confirm(body,p.fingerprint)]);
  assert.deepEqual(concurrent.map(x=>x.status),[200,200]);assert.deepEqual(concurrent.map(x=>x.body.inserted).sort(),[0,2]);assert.deepEqual(await counts(),{contacts:2,batches:2});
  pass('concurrent identical confirms serialize using actual PG advisory lock, no duplicate contacts');
  await clear();
  const duplicate={...body,csv:body.csv+'\n003,Synthetic Other,ALPHA@fixture.invalid'};const dup=await preview(duplicate);
  assert.equal(dup.canConfirm,false);assert.equal(dup.duplicates,1);assert.equal((await confirm(duplicate,dup.fingerprint)).status,400);assert.deepEqual(await counts(),{contacts:0,batches:0});pass('normalized duplicate email rejects entire file before writes');
  await pool.query(`CREATE FUNCTION import006_fail_contact() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.source_key='id:002' THEN RAISE EXCEPTION 'INJECTED_SECOND_CONTACT'; END IF; RETURN NEW; END $$; CREATE TRIGGER import006_fail_contact BEFORE INSERT ON club_imported_contacts FOR EACH ROW EXECUTE FUNCTION import006_fail_contact()`);
  assert.equal((await confirm(body,p.fingerprint)).status,503);assert.deepEqual(await counts(),{contacts:0,batches:0});
  await pool.query('DROP TRIGGER import006_fail_contact ON club_imported_contacts');assert.equal((await confirm(body,p.fingerprint)).status,200);assert.deepEqual(await counts(),{contacts:2,batches:1});pass('second-row PG failure rolls back earlier row and batch; corrected retry commits once');
  await clear();await pool.query(`CREATE FUNCTION import006_fail_batch() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'INJECTED_LATE_BATCH'; END $$; CREATE TRIGGER import006_fail_batch BEFORE INSERT ON club_import_batches FOR EACH ROW EXECUTE FUNCTION import006_fail_batch()`);
  assert.equal((await confirm(body,p.fingerprint)).status,503);assert.deepEqual(await counts(),{contacts:0,batches:0});await pool.query('DROP TRIGGER import006_fail_batch ON club_import_batches');assert.equal((await confirm(body,p.fingerprint)).status,200);assert.deepEqual(await counts(),{contacts:2,batches:1});pass('late batch failure rolls back all contacts; retry safe');
  await clear();await pool.query("INSERT INTO club_imported_contacts(sede_id,provider,source_key,name,email,phone,created_by) VALUES(7,'generic','id:002','Existing unchanged owner','beta@fixture.invalid','',$1)",[ACTOR]);
  assert.equal((await confirm(body,p.fingerprint)).status,400);assert.deepEqual(await counts(),{contacts:1,batches:0});assert.equal((await pool.query('SELECT name FROM club_imported_contacts')).rows[0].name,'Existing unchanged owner');pass('conflict in later existing contact rolls back earlier new contact without overwriting prior data');
  const beforeAuth=connects;
  assert.equal((await request('/confirm',{...body,fingerprint:p.fingerprint},{auth:null})).status,401);
  assert.equal((await request('/confirm',{...body,fingerprint:p.fingerprint},{auth:'player'})).status,403);
  assert.equal((await request('/confirm',{...body,fingerprint:p.fingerprint},{venue:8})).status,403);assert.equal(connects,beforeAuth);pass('unauthenticated, player and other venue rejected before transaction');
  console.log('RESULT',JSON.stringify({checks:checks.length,requests,contacts:(await counts()).contacts,auth:'synthetic scoped operator',schema:'exact repository migration; not effective external schema'}));
 }catch(e){const log=path.join(dir,'pg.log');if(fs.existsSync(log))console.error('LOCAL_PG_LOG',fs.readFileSync(log,'utf8').slice(-1200));throw e;}
 finally{
  if(server)await new Promise(resolve=>{server.close(resolve);server.closeAllConnections?.();});await pool?.end();
  if(running)run('pg_ctl',['-D',data,'-m','immediate','-w','stop']);
  assert.ok(dir.startsWith(path.join(os.tmpdir(),'import006-')));fs.rmSync(dir,{recursive:true,force:true});console.log('CLEANUP_OWN_PG');
 }
});
