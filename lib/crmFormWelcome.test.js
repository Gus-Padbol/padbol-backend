import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {createFormWelcomeRuntime,createFormWelcomeContextResolver,welcomeConsentValid,FORM_WELCOME_TEMPLATES} from './crmFormWelcome.js';
import {WELCOME_CONSENT_TEXT,WELCOME_CONSENT_VERSION} from './crmWelcomeConsentCandidate.js';
const contact='11111111-1111-4111-8111-111111111111',cv='22222222-2222-4222-8222-222222222222',event='33333333-3333-4333-8333-333333333333';
const envBase={BACKEND_RUNTIME_MODE:'production',OUTBOUND_DELIVERY_ENABLED:'true',CRM_WHATSAPP_PHONE_NUMBER_ID:'1376102838911694',CRM_WHATSAPP_WABA_ID:'928900479733370',CRM_WHATSAPP_CHANNEL_ID:'1bad838f-b5cc-4ae4-b28d-e63c998c6474',CRM_WHATSAPP_ORGANIZATION_ID:contact,WHATSAPP_META_GRAPH_VERSION:'v26.0',CRM_WHATSAPP_ACCESS_TOKEN:'fixture',WHATSAPP_PRODUCTION_MENU_ENABLED:'true',WHATSAPP_COMMERCIAL_CHIVI_WAIT_ENABLED:'true',CRM_FORM_WELCOME_ENABLED:'true'};
async function fixture({language='es',approved=true,uncertain=false}={}){
 const pg=new PGlite(),now=Date.now();await pg.exec(`create role anon;create role authenticated;create role service_role;
 create table crm_contacts(id uuid primary key,nombre text,phone_normalized text,review_needed boolean);
 create table crm_conversations(id uuid primary key,contact_id uuid,qualification_data jsonb,source_channel text,origin text,source_ref text,estado text,operador text,derivado boolean,created_at timestamptz default now());
 create table crm_inbound_events(id uuid primary key,conversation_id uuid,source_channel text,origin text,source_ref text,created_at timestamptz default now());
 create table crm_replies(id uuid primary key,conversation_id uuid);
 create table crm_commercial_form_cases(conversation_id uuid,progress_state text);
 create table crm_commercial_team_calls(conversation_id uuid);
 create table crm_commercial_followup_optouts(recipient_wa_id text);
 create table crm_activities(contact_id uuid,conversation_id uuid,activity_type text,summary text,author text);
 create function crm_commercial_form_is_allowed(uuid)returns boolean language sql as $$select exists(select 1 from crm_conversations where id=$1 and origin='web_form:fixture')$$;`);
 await pg.exec(await readFile('sql/migrations/20261028210000_crm_form_whatsapp_welcome.sql','utf8'));
 const consent={accepted:true,version:WELCOME_CONSENT_VERSION,text:WELCOME_CONSENT_TEXT[language],language,source:'web:contacto',purpose:'consultation_followup',phone:'+1 555 123 0000',acceptedAt:new Date(now-1000).toISOString()};
 await pg.query('insert into crm_contacts values($1,$2,$3,false)',[contact,'Test\nName','15551230000']);
 await pg.query("insert into crm_conversations(id,contact_id,qualification_data,source_channel,origin,source_ref,estado,derivado)values($1,$2,$3,'email','web_form:fixture','source','nuevo',false)",[cv,contact,JSON.stringify({whatsapp_contact_consent:consent})]);
 await pg.query("insert into crm_inbound_events(id,conversation_id,source_channel,origin,source_ref)values($1,$2,'email','web_form:fixture','source')",[event,cv]);
 await pg.query("insert into crm_commercial_form_cases values($1,'nuevo')",[cv]);
 const env={...envBase,CRM_FORM_WELCOME_ENABLED_SINCE:new Date(now-300000).toISOString()},sent=[];
 const db={from(){const b={select(){return b},eq(){return b},async maybeSingle(){return {data:{id:'channel'}}}};return b}};
 const pool={query:(...args)=>pg.query(...args),async connect(){return {query:(...args)=>pg.query(...args),release(){}}}};
 const fetchImpl=async(url,options)=>{
  if(String(url).includes('/message_templates'))return {ok:true,async json(){return {data:Object.entries(FORM_WELCOME_TEMPLATES).map(([language,t])=>({name:t.name,language,category:'MARKETING',status:approved?'APPROVED':'PAUSED',components:[{type:'BODY',text:t.body}]}))}}};
  sent.push(JSON.parse(options.body));if(uncertain)throw Error('timeout');return {ok:true,async json(){return {messages:[{id:'wamid.fixture'}]}}};
 };
 const runtime=createFormWelcomeRuntime({pool,db,env,fetchImpl,now:()=>now,logger:{error(){}}});
 return {pg,pool,env,sent,runtime,consent,now,close:()=>pg.close()};
}
for(const language of ['es','en'])test(`welcome ${language} is durable, appears in history and cannot resend`,async()=>{
 const f=await fixture({language});try{
  assert.equal((await f.runtime.inspect()).ready,true);assert.equal((await f.runtime.runOnce()).processed,1);assert.equal((await f.runtime.runOnce()).processed,0);assert.equal(f.sent.length,1);
  assert.equal(f.sent[0].template.name,FORM_WELCOME_TEMPLATES[language].name);assert.equal(f.sent[0].template.components[0].parameters[0].text,'Test Name');
  assert.equal((await f.pg.query('select count(*)::int n from crm_activities')).rows[0].n,1);
  const resolve=createFormWelcomeContextResolver({pool:f.pool,env:f.env});assert.equal((await resolve({phoneNumberId:'1376102838911694',fromWaId:'15551230000'})).language,language);
  assert.equal(await resolve({phoneNumberId:'other',fromWaId:'15551230000'}),null);
  await f.pg.query('insert into crm_replies values($1,$2)',[event,cv]);assert.equal(await resolve({phoneNumberId:'1376102838911694',fromWaId:'15551230000'}),null);
 }finally{await f.close();}
});
test('unapproved templates cannot dispatch',async()=>{const f=await fixture({approved:false});try{assert.equal((await f.runtime.runOnce()).processed,0);assert.equal(f.sent.length,0)}finally{await f.close()}});
test('provider uncertainty is recorded and never retried',async()=>{const f=await fixture({uncertain:true});try{await f.runtime.runOnce();await f.runtime.runOnce();assert.equal(f.sent.length,1);assert.equal((await f.pg.query('select status from crm_form_welcome_dispatches')).rows[0].status,'uncertain');assert.equal((await f.pg.query('select count(*)::int n from crm_activities')).rows[0].n,0)}finally{await f.close()}});
for(const mutation of ["update crm_conversations set created_at=now()-interval '1 day'","update crm_conversations set origin='support'","update crm_conversations set estado='cerrado'","update crm_conversations set operador='human'","update crm_contacts set review_needed=true","update crm_commercial_form_cases set progress_state='en_atencion'","insert into crm_commercial_team_calls values('22222222-2222-4222-8222-222222222222')","insert into crm_commercial_followup_optouts values('15551230000')","update crm_contacts set phone_normalized='15550000000'","update crm_conversations set qualification_data=jsonb_set(qualification_data,'{whatsapp_contact_consent,accepted}','false')"])
 test(`welcome excludes ineligible records: ${mutation}`,async()=>{const f=await fixture();try{await f.pg.exec(mutation);await f.runtime.runOnce();assert.equal(f.sent.length,0)}finally{await f.close()}});
test('invalid consent, future, local phone and missing language fail closed',async()=>{const f=await fixture();try{
 const row={qualification_data:{whatsapp_contact_consent:f.consent},phone_normalized:'15551230000',review_needed:false};assert.equal(welcomeConsentValid(row,f.now),true);
 for(const patch of [{text:'other'},{language:'fr'},{acceptedAt:new Date(f.now+1000).toISOString()},{acceptedAt:new Date(f.now-1900000).toISOString()},{phone:'01112345678'},{source:'browser'},{version:'old'}])assert.equal(welcomeConsentValid({...row,qualification_data:{whatsapp_contact_consent:{...f.consent,...patch}}},f.now),false);
}finally{await f.close()}});
test('missing activation timestamp and wrong tenant never arm delivery',async()=>{const f=await fixture();try{delete f.env.CRM_FORM_WELCOME_ENABLED_SINCE;const worker=createFormWelcomeRuntime({pool:f.pool,db:{from(){}},env:f.env});assert.equal(worker.start(),false);assert.equal((await worker.inspect()).ready,false)}finally{await f.close()}});
test('browser roles cannot access welcome records',async()=>{const f=await fixture();try{await f.pg.exec('set role authenticated');await assert.rejects(f.pg.query('select * from crm_form_welcome_dispatches'),/permission denied/)}finally{await f.pg.exec('reset role');await f.close()}});
