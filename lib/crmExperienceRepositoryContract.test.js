import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {PGlite} from '@electric-sql/pglite';
import sharp from 'sharp';
import {readFile} from 'node:fs/promises';
import {createCrmService,createSupabaseCrmRepository} from './crmService.js';
import {registerCrmInboundRoutes} from './crmInboundRoutes.js';

const conversationId='11111111-1111-4111-8111-111111111111',contactId='22222222-2222-4222-8222-222222222222';
// SQL-backed Supabase transport adapter; production service/repository factories
// and Express/multipart handlers are real. No production credentials or network.
function supabaseAdapter(pg){return {from(table){let action='read',payload,one=false,cap=null,sort=null;const conditions=[];const params=[];const name=value=>{assert.match(value,/^[a-z_]+$/);return '"'+value+'"';};const bind=value=>{params.push(value);return '$'+params.length;};
 const run=async()=>{let sql;if(action==='insert'){const keys=Object.keys(payload);sql=`insert into ${name(table)} (${keys.map(name).join(',')}) values (${keys.map(k=>bind(typeof payload[k]==='object'&&payload[k]!==null?JSON.stringify(payload[k]):payload[k])).join(',')}) returning *`;}else{sql=action==='update'?`update ${name(table)} set ${Object.keys(payload).map(k=>`${name(k)}=${bind(typeof payload[k]==='object'&&payload[k]!==null?JSON.stringify(payload[k]):payload[k])}`).join(',')}`:`select * from ${name(table)}`;if(conditions.length)sql+=' where '+conditions.map(([k,v])=>`${name(k)}=${bind(v)}`).join(' and ');if(action==='update')sql+=' returning *';else{if(sort)sql+=` order by ${name(sort.key)} ${sort.ascending?'asc':'desc'}`;if(cap!==null)sql+=' limit '+Number(cap);}}const result=await pg.query(sql,params);return {data:one?(result.rows[0]||null):result.rows,error:null};};
 const q={select(){return q;},eq(k,v){conditions.push([k,v]);return q;},limit(n){cap=n;return q;},order(key,{ascending=true}={}){sort={key,ascending};return q;},insert(value){action='insert';payload=value;return q;},update(value){action='update';payload=value;return q;},single(){one=true;return run();},maybeSingle(){one=true;return run();},then(resolve,reject){return run().then(resolve,reject);}};return q;}};}
async function fixture(){const pg=new PGlite();await pg.exec(`
 create role anon;create role authenticated;create role service_role;create schema auth;
 create table auth.users(id uuid primary key,email text);
 insert into auth.users values('7225442b-defd-42c1-a5a2-b9c1c339fa69','sm@padbol.com');
 create table crm_contacts(id uuid primary key default gen_random_uuid(),nombre text,email_normalized text,phone_normalized text,review_needed boolean default false);
 create table crm_conversations(id uuid primary key,contact_id uuid,source_channel text,origin text,estado text,derivado boolean default false,operador text,qualification_data jsonb,created_at timestamptz default now(),updated_at timestamptz default now(),test_hidden_at timestamptz,email_return_linked_to uuid);
 create table crm_commercial_form_cases(conversation_id uuid primary key,assigned_user_id uuid,progress_state text default 'nuevo',commercial_next_step text);
 create table crm_activities(id uuid primary key default gen_random_uuid(),contact_id uuid,conversation_id uuid,activity_type text,summary text,next_step text,follow_up_at timestamptz,author text,created_at timestamptz default now());
 create function crm_commercial_form_is_allowed(p_id uuid) returns boolean language sql as $$select exists(select 1 from crm_conversations where id=p_id and source_channel='email' and origin='web_form:solicitud_licencia')$$;
 create table crm_space_requests(id uuid primary key default gen_random_uuid(),conversation_id uuid,contact_id uuid,status text default 'recibida',length_m numeric,width_m numeric,covered boolean,height_m numeric,desired_courts integer,files jsonb,simulation_path text,actor text,created_at timestamptz default now(),updated_at timestamptz default now());`);
 await pg.exec(await readFile(new URL('../supabase/migrations/20261104211246_crm_space_media_privacy_retention.sql',import.meta.url),'utf8'));
 await pg.query('insert into crm_contacts(id,nombre,email_normalized,phone_normalized) values($1,$2,$3,null)',[contactId,'Fixture','fixture@example.invalid']);
 await pg.query("insert into crm_conversations(id,contact_id,source_channel,origin,estado,qualification_data) values($1,$2,'email','web_form:solicitud_licencia','nuevo',$3)",[conversationId,contactId,JSON.stringify({form_submission:{fields:{Email:'fixture@example.invalid',WhatsApp:'+54 9 11 1234 5678'}}})]);
 const db=supabaseAdapter(pg),uploads=[];db.storage={async createBucket(){return {error:null};},from(){return {async upload(path,buffer){uploads.push({path,size:buffer.length});return {error:null};}};}};
 const crmService=createCrmService({repository:createSupabaseCrmRepository(db)});for(const missing of ['getConversation','createActivity','listActivities','markHandoff'])assert.equal(crmService[missing],undefined,`service intentionally has no ${missing}`);
 const app=express();app.use(express.json());registerCrmInboundRoutes(app,{crmService,db,pool:{query:(...args)=>pg.query(...args)},formInboundSecret:'contract-test',logger:{warn(){}}});const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const base='http://127.0.0.1:'+server.address().port;
 return {pg,uploads,base,async post(path,body){const response=await fetch(base+path,{method:'POST',headers:{Authorization:'Bearer contract-test','Content-Type':'application/json'},body:JSON.stringify(body)});return{status:response.status,body:await response.json()};},async close(){await new Promise(r=>server.close(r));await pg.close();}};
}
test('real inbound service contract identifies the existing legacy contact, records proposal and stores space without invented service methods',async()=>{const f=await fixture();try{
 const identified=await f.post('/api/inbound/crm/experience/contact',{name:'Fixture',email:'fixture@example.invalid',phone:'+54 9 11 1234 5678',conversationId,preferredContact:'email'});assert.equal(identified.status,200);assert.equal(identified.body.conversationId,conversationId);
 assert.equal((await f.pg.query('select count(*) n from crm_conversations')).rows[0].n,1);assert.equal((await f.pg.query('select phone_normalized from crm_contacts where id=$1',[contactId])).rows[0].phone_normalized,null);
 const proposal=await f.post('/api/inbound/crm/experience',{conversationId,action:'proposal'});assert.equal(proposal.status,201);assert.ok(proposal.body.activityId);assert.equal((await f.pg.query('select operador,derivado from crm_conversations where id=$1',[conversationId])).rows[0].operador,'Nicolás Renedo');
 const repeated=await f.post('/api/inbound/crm/experience',{conversationId,action:'proposal'});assert.equal(repeated.status,200);assert.equal(repeated.body.duplicate,true);
 const image=await sharp({create:{width:10,height:10,channels:3,background:'white'}}).jpeg().toBuffer();const form=new FormData();for(const[k,v]of Object.entries({conversationId,consent:'true',lengthM:'20',widthM:'16',covered:'true',heightM:'5.5',desiredCourts:'2',spaceShape:'rectangular'}))form.set(k,v);form.append('photos',new Blob([image],{type:'image/jpeg'}),'fixture.jpg');const response=await fetch(f.base+'/api/inbound/crm/space-request',{method:'POST',headers:{Authorization:'Bearer contract-test'},body:form});const body=await response.json();assert.equal(response.status,201);assert.ok(body.requestId);assert.ok(body.activityId);assert.equal(f.uploads.length,1);assert.equal((await f.pg.query('select count(*) n from crm_activities')).rows[0].n,3);assert.equal((await f.pg.query('select count(*) n from crm_space_requests')).rows[0].n,1);
 }finally{await f.close();}});
test('real SQL eligibility rejects hidden, linked, closed and unclassified enquiries before recording an action',async()=>{const f=await fixture();try{for(const sql of ["update crm_conversations set test_hidden_at=now()",`update crm_conversations set test_hidden_at=null,email_return_linked_to='${contactId}'`,"update crm_conversations set email_return_linked_to=null,estado='cerrado'","update crm_conversations set estado='nuevo',origin='support_email'"]){await f.pg.exec(sql);const response=await f.post('/api/inbound/crm/experience',{conversationId,action:'proposal'});assert.equal(response.status,404);assert.equal(response.body.code,'CRM_EXPERIENCE_NOT_FOUND');}assert.equal((await f.pg.query('select count(*) n from crm_activities')).rows[0].n,0);}finally{await f.close();}});

test('territory requests preserve purpose for email and WhatsApp without stale financial snapshots or extra private fields',async()=>{
 const f=await fixture();try{
  const financial={fingerprint:'saved-project',financials:{investment:999999,totalRevenue:888888}};
  await f.pg.query("update crm_conversations set qualification_data=qualification_data || $2::jsonb where id=$1",[conversationId,JSON.stringify({commercial_simulation:financial})]);
  for(const [index,contactMode]of ['email','whatsapp'].entries()){
   const response=await f.post('/api/inbound/crm/experience',{conversationId,action:'advisor',locale:index?'en':'es',contactMode,requestPurpose:'territory',territoryRequest:{scope:'country',country:index?'Spain':'Italy',details:'Develop a local network',email:'private@invalid.test',budget:765432},simulation:{type:'business-v2',complementaryMode:'monthly',budget:'INVALID STALE FINANCE'}});
   assert.equal(response.status,201);
   const data=(await f.pg.query('select qualification_data from crm_conversations where id=$1',[conversationId])).rows[0].qualification_data;
   assert.deepEqual(data.commercial_simulation,financial);assert.equal(data.commercial_experience_request.requestPurpose,'territory');
   assert.deepEqual(data.commercial_experience_request.territoryRequest,{scope:'country',country:index?'Spain':'Italy',details:'Develop a local network'});
   const activity=(await f.pg.query('select summary,next_step from crm_activities where id=$1',[response.body.activityId])).rows[0];
   assert.match(activity.summary,index?/Territorial advisory/:/asesoramiento territorial/);assert.match(activity.summary,index?/WhatsApp/:/correo electrónico/);
   assert.doesNotMatch(activity.summary,/999999|888888|765432|private@|Simulación|simulation|cotización|Quote|INVESTMENT/i);
   assert.match(activity.next_step,/territorial/);
  }
  assert.equal((await f.pg.query('select count(*)::int n from crm_activities')).rows[0].n,2);
 }finally{await f.close();}
});

test('territory identical retry is deduplicated, changed territory and project-to-territory transitions are retained',async()=>{
 const f=await fixture();try{
  const send=(patch={})=>f.post('/api/inbound/crm/experience',{conversationId,action:'advisor',contactMode:'email',requestPurpose:'territory',territoryRequest:{scope:'region',country:'Argentina',region:'Buenos Aires',details:'Experience and growth plan'},...patch});
  assert.equal((await send()).status,201);assert.equal((await send({contactMode:'whatsapp'})).body.duplicate,true);
  assert.equal((await send({territoryRequest:{scope:'region',country:'Argentina',region:'Córdoba',details:'Experience and growth plan'}})).status,201);
  assert.equal((await send()).status,201,'changed territory is a new request even if earlier region exists');
  const legacy=await f.post('/api/inbound/crm/experience',{conversationId,action:'advisor',contactMode:'phone'});assert.equal(legacy.status,201);
  assert.equal((await f.post('/api/inbound/crm/experience',{conversationId,action:'advisor',contactMode:'phone'})).body.duplicate,true,'legacy null-simulation retry remains deduplicated');
  assert.equal((await send()).status,201,'project to territory cannot be swallowed by an older null-simulation request');
  assert.equal((await send()).body.duplicate,true);
  assert.equal((await f.pg.query('select count(*)::int n from crm_activities')).rows[0].n,5);
 }finally{await f.close();}
});

test('territory optional details stay absent and invalid contracts cannot write activities',async()=>{
 const f=await fixture();try{
  const missing=await f.post('/api/inbound/crm/experience',{conversationId,action:'advisor',contactMode:'email',requestPurpose:'territory'});assert.equal(missing.status,201);
  const stored=(await f.pg.query('select qualification_data from crm_conversations where id=$1',[conversationId])).rows[0].qualification_data.commercial_experience_request;
  assert.equal(stored.requestPurpose,'territory');assert.equal('territoryRequest' in stored,false);
  for(const body of [{requestPurpose:'unknown'},{requestPurpose:'territory',territoryRequest:[]},{requestPurpose:'territory',territoryRequest:{scope:'planet'}}]){
   const result=await f.post('/api/inbound/crm/experience',{conversationId,action:'advisor',...body});assert.equal(result.status,400);
  }
  assert.equal((await f.pg.query('select count(*)::int n from crm_activities')).rows[0].n,1);
 }finally{await f.close();}
});
