import test from 'node:test';import assert from 'node:assert/strict';
import express from 'express';import {createHash} from 'node:crypto';import {readFile} from 'node:fs/promises';import {pathToFileURL} from 'node:url';
import {createSupportWhatsappQaCanaryAccessFactory} from './supportWhatsappQaCanaryAccessCandidate.js';
import {createSupportWhatsappQaCanaryCandidate} from './supportWhatsappQaCanaryCandidate.js';
import {installStagingFetchGuard} from './backendRuntime.js';
const uuid=n=>`60000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const environment=()=>({BACKEND_RUNTIME_MODE:'staging',STAGING_SUPABASE_PROJECT_REF:'vxikhdulhuvghfqeutnp',PRODUCTION_SUPABASE_PROJECT_REF:'vpldffhsxhgnmitiikof',SUPABASE_URL:'https://vxikhdulhuvghfqeutnp.supabase.co',SUPABASE_KEY:'synthetic-key',SUPABASE_SERVICE_ROLE_KEY:'synthetic-service-key',RENDER_SERVICE_ID:'srv-dahbs0dbedkc73a0kf4g',RENDER_EXTERNAL_URL:'https://padbol-backend-qa.onrender.com',WHATSAPP_META_GRAPH_VERSION:'v26.0',OUTBOUND_DELIVERY_ENABLED:'false',BACKGROUND_JOBS_ENABLED:'false',PUSH_SEND_ENABLED:'false',WHATSAPP_CLOUD_SEND_ENABLED:'true',WHATSAPP_CLOUD_MAX_SEND_ATTEMPTS:'1',WHATSAPP_META_TOKEN_TEST:'synthetic-test-token'});
test('private canary route never mounts in production or foreign QA',()=>{assert.equal(createSupportWhatsappQaCanaryAccessFactory({env:{...environment(),BACKEND_RUNTIME_MODE:'production'}}),null);assert.equal(createSupportWhatsappQaCanaryAccessFactory({env:{...environment(),RENDER_SERVICE_ID:'other'}}),null)});
test('private HTTP + real SQL quota/default denial + captured narrow transport',{skip:!process.env.PADBOL_PGLITE_MODULE},async()=>{
 const {PGlite}=await import(pathToFileURL(process.env.PADBOL_PGLITE_MODULE).href);const db=new PGlite();let server;let transports=0;const token='synthetic_separate_service_key_1234567890123456';const tokenHash=createHash('sha256').update(token).digest('hex');
 try{
  await db.exec(`create role anon;create role authenticated;create role service_role;
  create table crm_support_delivery_principals(id uuid primary key,active boolean,capability text,tenant_id uuid,channel_id uuid,organization_id uuid,phone_number_id text,waba_id text,origin text,credential_ref text);
  create table crm_support_cases(id bigint primary key,conversation_id uuid,source_channel text,lifecycle_state text,tenant_id uuid,channel_id uuid);
  create table crm_support_lifecycle_effects(id bigint primary key,case_id bigint,effect_type text,disposition text);
  create table crm_conversations(id uuid primary key,origin text,identity_used text);
  create table crm_support_delivery_journal(effect_id bigint);`);
  for(const file of ['support_whatsapp_qa_canary.sql','support_whatsapp_qa_canary_access.sql'])await db.exec(await readFile(new URL('../sql/candidates/'+file,import.meta.url),'utf8'));
  const pool={query:(...a)=>db.query(...a),async connect(){return{query:(...a)=>db.query(...a),release(){}}}};
  const target={fetch:async(url,options)=>{transports++;assert.equal(url,'https://graph.facebook.com/v26.0/1376102838911694/messages');assert.equal(JSON.parse(options.body).to,'15555555555');return{ok:true,json:async()=>({messages:[{id:'synthetic-receipt'}]})}}};
  const canaryFactory=options=>createSupportWhatsappQaCanaryCandidate({...options,dispatcherFactory:({sender})=>({async dispatch(effect){assert.equal(effect,10);await sender.sendText({channel:{id:'81bba438-eb65-4f70-bdf9-32f6c113d5bf',meta_phone_number_id:'1376102838911694',credential_ref:'TEST'},toWaId:'15555555555',body:'Synthetic approved final'});return{status:'sent',sent:true}}})});
  const factory=createSupportWhatsappQaCanaryAccessFactory({env:environment(),fetchImpl:target.fetch,canaryFactory});
  installStagingFetchGuard(environment(),target);await assert.rejects(target.fetch('https://graph.facebook.com/v26.0/1376102838911694/messages'),/deshabilit|disabled|bloque|staging/i);
  const app=express();factory(app,{pool});server=await new Promise(r=>{const s=app.listen(0,'127.0.0.1',()=>r(s))});
  const base=`http://127.0.0.1:${server.address().port}/api/internal/support-qa-canary`;
  const request=(path,body,auth=token)=>fetch(base+path,{method:body===undefined?'GET':'POST',headers:{...(auth?{authorization:'Bearer '+auth}:{}),'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
  assert.equal((await request('/status',undefined,null)).status,401);assert.equal((await request('/status')).status,401);
  await db.query('insert into crm_support_qa_canary_access(singleton,token_sha256)values(true,$1)',[tokenHash]);
  const initial=await(await request('/status')).json();assert.equal(initial.enabled,false);assert.equal(initial.securityApproved,false);assert.equal(initial.quotaConsumed,false);assert.equal((await request('/run-once',{})).status,409);assert.equal(transports,0);
  assert.equal((await request('/run-once',{effectId:999,recipient:'15555555556'})).status,400);
  await db.query("insert into crm_support_delivery_principals values($1,true,'support.whatsapp.send','3a2e5306-e1fc-4b24-b03b-fe965fc37e97','81bba438-eb65-4f70-bdf9-32f6c113d5bf','067d7269-27e3-4aaf-9da4-c80ba56e1d2a','1376102838911694','928900479733370','whatsapp:1376102838911694','TEST')",[uuid(1)]);
  await db.query("insert into crm_conversations values($1,'whatsapp:1376102838911694','15555555555')",[uuid(2)]);
  await db.query("insert into crm_support_cases values(1,$1,'whatsapp','response_draft_ready','3a2e5306-e1fc-4b24-b03b-fe965fc37e97','81bba438-eb65-4f70-bdf9-32f6c113d5bf')",[uuid(2)]);await db.exec("insert into crm_support_lifecycle_effects values(10,1,'response_draft','draft_only')");
  await db.query("update crm_support_qa_canary_access set enabled=true,security_approved=true,effect_id=10,principal_id=$1,authorized_recipient='15555555555'",[uuid(1)]);
  const first=await request('/run-once',{});assert.equal(first.status,200);assert.equal((await first.json()).sent,true);assert.equal((await request('/run-once',{})).status,409);assert.equal(transports,1);assert.equal((await(await request('/status')).json()).quotaConsumed,true);
  assert.equal((await db.query('select count(*)::int n from crm_support_qa_canary_permits')).rows[0].n,1);
  assert.equal((await db.query("select has_table_privilege('authenticated','crm_support_qa_canary_access','SELECT') allowed")).rows[0].allowed,false);
 }finally{if(server)await new Promise(r=>server.close(r));await db.close()}
});
