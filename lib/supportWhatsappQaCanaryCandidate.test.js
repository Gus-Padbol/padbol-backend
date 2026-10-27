import test from 'node:test';import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';import {pathToFileURL} from 'node:url';
import {createSupportWhatsappQaCanaryCandidate} from './supportWhatsappQaCanaryCandidate.js';
const uuid=n=>`70000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
function env(){return{CRM_SUPPORT_QA_CANARY_ENABLED:'true',CRM_SUPPORT_QA_CANARY_SECURITY_APPROVED:'true',CRM_SUPPORT_QA_CANARY_PRINCIPAL_ID:uuid(1),CRM_SUPPORT_QA_CANARY_EFFECT_ID:'10',CRM_SUPPORT_QA_CANARY_AUTHORIZED_RECIPIENT:'15555555555',BACKEND_RUNTIME_MODE:'staging',STAGING_SUPABASE_PROJECT_REF:'vxikhdulhuvghfqeutnp',PRODUCTION_SUPABASE_PROJECT_REF:'vpldffhsxhgnmitiikof',SUPABASE_URL:'https://vxikhdulhuvghfqeutnp.supabase.co',SUPABASE_KEY:'synthetic-key',SUPABASE_SERVICE_ROLE_KEY:'synthetic-service-key',RENDER_SERVICE_ID:'srv-dahbs0dbedkc73a0kf4g',RENDER_EXTERNAL_URL:'https://padbol-backend-qa.onrender.com',WHATSAPP_META_GRAPH_VERSION:'v26.0',OUTBOUND_DELIVERY_ENABLED:'false',BACKGROUND_JOBS_ENABLED:'false',PUSH_SEND_ENABLED:'false',WHATSAPP_CLOUD_SEND_ENABLED:'true',WHATSAPP_CLOUD_MAX_SEND_ATTEMPTS:'1',WHATSAPP_META_TOKEN_TEST:'synthetic-token'}}
function harness(){
 let claims=0,sends=0,permit=true;const e=env();
 const pool={async connect(){return {async query(sql,args){claims++;assert.deepEqual(args,[10,uuid(1),'15555555555']);return {rows:[{result:{reserved:permit}}]}},release(){}}}};
 return {e,pool,claims:()=>claims,sends:()=>sends,setPermit:v=>permit=v,options(){return {
  env:e,pool,
  fetchImpl:async(_url,options)=>{sends++;assert.equal(options.redirect,'error');return {ok:true,json:async()=>({messages:[{id:'synthetic-receipt'}]})}},
  dispatcherFactory:({sender})=>({async dispatch(effect){
   assert.equal(effect,10);
   await sender.sendText({channel:{id:'81bba438-eb65-4f70-bdf9-32f6c113d5bf',meta_phone_number_id:'1376102838911694',credential_ref:'TEST'},toWaId:'15555555555',body:'Synthetic reviewed final'});
   return {status:'sent',sent:true,retryAllowed:false};
  }})
 }}};
}
test('QA canary disabled default; does not instantiate transport/storage',()=>assert.equal(createSupportWhatsappQaCanaryCandidate({env:{}}),null));
test('QA canary requires exact QA identity, independent approval, recipient, effect and globals OFF',()=>{for(const patch of [{CRM_SUPPORT_QA_CANARY_SECURITY_APPROVED:'false'},{CRM_SUPPORT_QA_CANARY_AUTHORIZED_RECIPIENT:''},{CRM_SUPPORT_QA_CANARY_EFFECT_ID:'0'},{OUTBOUND_DELIVERY_ENABLED:'true'},{BACKGROUND_JOBS_ENABLED:'true'},{RENDER_SERVICE_ID:'wrong'},{STAGING_SUPABASE_PROJECT_REF:'production'},{BACKEND_RUNTIME_MODE:'production'},{CRM_SUPPORT_WHATSAPP_SEND_ENABLED:'true'}]){const h=harness();assert.throws(()=>createSupportWhatsappQaCanaryCandidate({...h.options(),env:{...h.e,...patch}}));assert.equal(h.claims(),0);assert.equal(h.sends(),0)}});
test('one explicit effect, durable permit before one exact recipient mock; no second run',async()=>{const h=harness();const c=createSupportWhatsappQaCanaryCandidate(h.options());assert.equal((await c.runOnce()).status,'sent');assert.equal((await c.runOnce()).status,'held');assert.equal(h.claims(),1);assert.equal(h.sends(),1)});
test('existing or uncertain quota does not call dispatcher or transport',async()=>{const h=harness();h.setPermit(false);const c=createSupportWhatsappQaCanaryCandidate(h.options());assert.equal((await c.runOnce()).status,'held');assert.equal(h.sends(),0)});
test('lost permit acknowledgement is not retried in process',async()=>{const h=harness();const c=createSupportWhatsappQaCanaryCandidate({...h.options(),pool:{async connect(){return{async query(){throw Error('LOST_COMMIT_ACK')},release(){}}}}});await assert.rejects(c.runOnce(),/LOST_COMMIT_ACK/);assert.equal((await c.runOnce()).status,'held');assert.equal(h.sends(),0)});
test('SQL quota is unique and rejects arbitrary/production principals and clients',{skip:!process.env.PADBOL_PGLITE_MODULE},async()=>{
 const {PGlite}=await import(pathToFileURL(process.env.PADBOL_PGLITE_MODULE).href);const db=new PGlite();try{
  await db.exec(`create role anon;create role authenticated;create role service_role;
  create table crm_support_delivery_principals(id uuid primary key,active boolean,capability text,tenant_id uuid,channel_id uuid,organization_id uuid,phone_number_id text,waba_id text,origin text,credential_ref text);
  create table crm_support_cases(id bigint primary key,conversation_id uuid,source_channel text,lifecycle_state text,tenant_id uuid,channel_id uuid);
  create table crm_support_lifecycle_effects(id bigint primary key,case_id bigint,effect_type text,disposition text);
  create table crm_conversations(id uuid primary key,origin text,identity_used text);
  create table crm_support_delivery_journal(effect_id bigint);`);
  await db.exec(await readFile(new URL('../sql/candidates/support_whatsapp_qa_canary.sql',import.meta.url),'utf8'));
  await db.query("insert into crm_support_delivery_principals values($1,true,'support.whatsapp.send','3a2e5306-e1fc-4b24-b03b-fe965fc37e97','81bba438-eb65-4f70-bdf9-32f6c113d5bf','067d7269-27e3-4aaf-9da4-c80ba56e1d2a','1376102838911694','928900479733370','whatsapp:1376102838911694','TEST')",[uuid(1)]);
  await db.query("insert into crm_conversations values($1,'whatsapp:1376102838911694','15555555555')",[uuid(2)]);
  await db.query("insert into crm_support_cases values(1,$1,'whatsapp','response_draft_ready','3a2e5306-e1fc-4b24-b03b-fe965fc37e97','81bba438-eb65-4f70-bdf9-32f6c113d5bf')",[uuid(2)]);
  await db.exec("insert into crm_support_lifecycle_effects values(10,1,'response_draft','draft_only'),(11,1,'response_draft','draft_only')");
  const reserve=(effect,principal=uuid(1),recipient='15555555555')=>db.query('select crm_support_reserve_qa_canary($1,$2,$3) result',[effect,principal,recipient]);
  await assert.rejects(reserve(10,uuid(9)),/PRINCIPAL_DENIED/);await assert.rejects(reserve(10,uuid(1),'15555555556'),/SCOPE_DENIED/);
  assert.equal((await reserve(10)).rows[0].result.reserved,true);assert.equal((await reserve(10)).rows[0].result.reserved,false);assert.equal((await reserve(11)).rows[0].result.reserved,false);
  assert.equal((await db.query('select count(*)::int n from crm_support_qa_canary_permits')).rows[0].n,1);
  assert.equal((await db.query("select has_function_privilege('authenticated','crm_support_reserve_qa_canary(bigint,uuid,text)','EXECUTE') allowed")).rows[0].allowed,false);
 }finally{await db.close()}
});
