import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {createSupabaseCrmRepository} from './crmService.js';
import {isVerifiedCommercialEmail} from './crmCommercialEmailTriage.js';
const migration=await readFile(new URL('../supabase/migrations/20261105170349_crm_inbox_effective_state_filter.sql',import.meta.url),'utf8');
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const origin='web_form:Consulta Padbol · Quiero una cancha Padbol';
async function fixture(){
 const pg=new PGlite();await pg.exec(`create role anon;create role authenticated;create role service_role;
 create table crm_contacts(id uuid primary key,nombre text,email_normalized text,phone_normalized text,review_needed boolean);
 create table crm_conversations(id uuid primary key,contact_id uuid,source_channel text,origin text,qualification_data jsonb default '{}'::jsonb,estado text,updated_at timestamptz,ticket_number text,test_hidden_at timestamptz,email_return_linked_to uuid);
 create table crm_commercial_form_cases(conversation_id uuid primary key,assigned_user_id uuid,progress_state text,commercial_next_step text);
 create table crm_commercial_email_triage(conversation_id uuid primary key);`);await pg.exec(migration);
 async function add(n,{state='nuevo',commercialState=null,hidden=false,channel='email',source=origin,workflow='commercial_lead',topic='sede',triage=false}={}){
  await pg.query('insert into crm_conversations values($1,null,$2,$3,$4,$5,$6,$7,$8,null)',[id(n),channel,source,JSON.stringify({routing:{workflow},whatsapp_menu:{topic}}),state,new Date(Date.UTC(2026,10,1,0,n)).toISOString(),String(n),hidden?'2026-11-01':null]);
  if(commercialState)await pg.query('insert into crm_commercial_form_cases values($1,$2,$3,$4)',[id(n),id(9000),commercialState,'Siguiente paso']);
  if(triage)await pg.query('insert into crm_commercial_email_triage values($1)',[id(n)]);
 }
 const db={from(){throw Error('State filtering must not read an already limited page');},async rpc(name,p){try{return {data:(await pg.query(`select * from ${name}($1,$2,$3,$4,$5,$6,$7,$8)`,Object.values(p))).rows.map(r=>r.crm_inbox_effective_state_list),error:null};}catch(error){return{data:null,error};}}};
 return{pg,add,repo:createSupabaseCrmRepository(db),triageRepo:createSupabaseCrmRepository(db,{commercialEmailTriageEnabled:true})};
}
test('state is filtered before limit: old closed case survives 205 newer new cases',async()=>{const f=await fixture();try{
 await f.add(1,{commercialState:'cerrado'});for(let n=2;n<=207;n++)await f.add(n,{commercialState:'nuevo'});
 const closed=await f.repo.listCommercialConversations({estado:'cerrado'});assert.deepEqual(closed.map(r=>r.id),[id(1)]);assert.equal(closed[0].estado,'nuevo');assert.equal(closed[0].commercial_management.progress_state,'cerrado');assert.equal(closed[0].commercial_management.assigned_user_id,id(9000));
 assert.equal((await f.repo.listCommercialConversations({estado:'nuevo'})).length,200);
 assert.deepEqual((await f.repo.listConversations({estado:'cerrado'})).map(r=>r.id),[id(1)]);
 }finally{await f.pg.close();}});
test('scopes, hidden flags, channels, workflow, origin, ticket and id precede limit',async()=>{const f=await fixture();try{
 await f.add(1,{commercialState:'cerrado'});await f.add(2,{commercialState:'cerrado',hidden:true});await f.add(3,{state:'cerrado',commercialState:'nuevo',source:'support_email'});await f.add(4,{state:'cerrado',workflow:'support'});await f.add(5,{state:'cerrado',channel:'whatsapp',source:'whatsapp:1376102838911694'});await f.add(6,{state:'cerrado',channel:'whatsapp',source:'whatsapp:1376102838911694',topic:'soporte'});await f.add(7,{commercialState:'cerrado',source:'institutional_email',triage:true});
 assert.deepEqual((await f.repo.listCommercialConversations({estado:'cerrado'})).map(r=>r.id),[id(5),id(1)]);
 assert.deepEqual((await f.repo.listCommercialConversations({estado:'cerrado',hiddenOnly:true})).map(r=>r.id),[id(2)]);
 assert.deepEqual((await f.repo.listCommercialConversations({estado:'cerrado',sourceChannel:'email'})).map(r=>r.id),[id(1)]);
 assert.deepEqual((await f.repo.listConversations({estado:'cerrado',origins:['support_email'],ticketNumber:'3',conversationId:id(3)})).map(r=>r.id),[id(3)]);
 const triage=await f.triageRepo.listCommercialConversations({estado:'cerrado'});assert.equal(isVerifiedCommercialEmail(triage[0]),true);assert.equal(triage[0].id,id(7));
 const global=await f.repo.listConversations({estado:'cerrado'});assert.ok(global.some(r=>r.id===id(3)));assert.ok(global.some(r=>r.id===id(6)));assert.ok(!global.some(r=>r.id===id(2)));
 }finally{await f.pg.close();}});
test('service-only RPC: anon and authenticated cannot call it',async()=>{const f=await fixture();try{for(const role of ['anon','authenticated']){await f.pg.exec(`set role ${role}`);await assert.rejects(f.pg.query("select * from public.crm_inbox_effective_state_list('nuevo')"),/permission denied/);await f.pg.exec('reset role');}const grants=await f.pg.query("select has_function_privilege('service_role','public.crm_inbox_effective_state_list(text,boolean,boolean,text,text[],uuid,text,boolean)','execute') allowed");assert.equal(grants.rows[0].allowed,true);}finally{await f.pg.close();}});
test('missing RPC errors fail closed and never return a partial filtered page',async()=>{const repo=createSupabaseCrmRepository({from(){throw Error('must not fallback');},rpc:async()=>({error:{message:'missing migration'}})});await assert.rejects(repo.listCommercialConversations({estado:'cerrado'}),e=>e.code==='CRM_INBOX_STATE_UNAVAILABLE');});
