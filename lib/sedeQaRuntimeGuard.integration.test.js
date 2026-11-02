import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import pg from 'pg';
import express from 'express';
import {createQaGuardedPool,mountSedeQaDiagnostic,QA_PROJECT,QA_SERVICE,QA_URL} from './sedeQaRuntimeGuard.js';
const configPath=process.env.SEDE_APPROVAL_PG_CONFIG;
const runtime={staging:true,mode:'staging',outboundDeliveryEnabled:false,backgroundJobsEnabled:false,pushSendEnabled:false};
const env={RENDER_SERVICE_ID:QA_SERVICE,RENDER_EXTERNAL_URL:QA_URL,SUPABASE_URL:`https://${QA_PROJECT}.supabase.co`,STAGING_SUPABASE_PROJECT_REF:QA_PROJECT,RENDER_GIT_COMMIT:'b'.repeat(40)};
const actor='11111111-1111-4111-8111-111111111111';
test('PG17 actual READ ONLY enforcement and HTTP actor checks; target metadata is explicitly synthetic', {skip:!configPath},async()=>{
 const cfg=JSON.parse(await fs.readFile(configPath,'utf8'));assert.equal(cfg.isolated_synthetic_only,true);assert.match(cfg.socket,/^\/tmp\/pbpg-/);
 const raw=new pg.Pool({host:cfg.socket,port:cfg.port,user:cfg.username,database:'postgres',max:3});
 // The database, SQL and HTTP are real local execution. Only expected remote
 // host metadata/auth resolver are fixtures; this is NOT live QA attestation.
 await raw.query('CREATE SCHEMA guard_fixture');await raw.query('CREATE TABLE guard_fixture.writes(id int)');
 await raw.query('CREATE TABLE IF NOT EXISTS public.user_roles(user_id uuid,role text)');await raw.query('INSERT INTO public.user_roles VALUES($1,$2)',[actor,'super_admin']);
 let metadataHost=`db.${QA_PROJECT}.supabase.co`,reads=0;
 const pool={connect:async()=>{const c=await raw.connect();return {connectionParameters:{...c.connectionParameters,host:metadataHost},query:async(...a)=>{reads++;return c.query(...a)},release:(...a)=>c.release(...a)};}};
 const app=express();mountSedeQaDiagnostic(app,{pool,runtime,env,authUserFromBearer:async req=>req.headers.authorization==='Bearer synthetic-owner'?{id:actor}:req.headers.authorization==='Bearer synthetic-other'?{id:'22222222-2222-4222-8222-222222222222'}:null,assertSuperAdminReq:async()=>{}});
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 const url=`http://127.0.0.1:${server.address().port}/api/admin/sedes-pendientes/diagnostico-qa`;
 try {
  assert.equal((await fetch(url)).status,401);
  const response=await fetch(url,{headers:{authorization:'Bearer synthetic-owner'}});assert.equal(response.status,200);assert.equal((await response.json()).actorAuthorized,true);
  assert.equal((await fetch(url,{headers:{authorization:'Bearer synthetic-other'}})).status,403);
  const c=await raw.connect();try{await c.query('BEGIN READ ONLY');await assert.rejects(c.query('INSERT INTO guard_fixture.writes VALUES(1)'),e=>e.code==='25006');await c.query('ROLLBACK');}finally{c.release();}
  const guarded=createQaGuardedPool(pool,{runtime,env});await guarded.query('INSERT INTO guard_fixture.writes VALUES(2)');assert.equal((await raw.query('SELECT count(*)::int AS n FROM guard_fixture.writes')).rows[0].n,1);
  metadataHost='db.vpldffhsxhgnmitiikof.supabase.co';const n=reads;await assert.rejects(guarded.query('INSERT INTO guard_fixture.writes VALUES(3)'));assert.equal(reads,n);assert.equal((await raw.query('SELECT count(*)::int AS n FROM guard_fixture.writes')).rows[0].n,1);
  assert.equal((await fetch(url,{headers:{authorization:'Bearer synthetic-owner'}})).status,503);
 }finally{await new Promise(r=>server.close(r));await raw.end();}
});
