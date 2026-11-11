import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {createSupabaseCrmRepository} from './crmService.js';
import {createCrmAdminService} from './crmAdmin.js';
import {CRM_COMMERCIAL_OPERATORS,CRM_COMMERCIAL_FORM_ORIGINS,isCommercialConversation} from './crmCommercialScope.js';
import {markVerifiedCommercialEmail} from './crmCommercialEmailTriage.js';

const owner='8beebdbe-e1d7-4607-9bb0-9a7d64701408',manager=CRM_COMMERCIAL_OPERATORS[0].userId;
const advisor='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',otherAdvisor='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const target='cccccccc-cccc-4ccc-8ccc-cccccccccccc',neighbor='dddddddd-dddd-4ddd-8ddd-dddddddddddd',contact='eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
async function fixture(fn){const db=new PGlite();try{
 await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;create schema auth;
 create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz);
 insert into auth.users values('${owner}','padbolinternacional@gmail.com',now()),('${manager}','sm@padbol.com',now()),('${advisor}','advisor@example.test',now()),('${otherAdvisor}','other@example.test',now());
 create table user_roles(user_id uuid,email text,role text);insert into user_roles values('${owner}','padbolinternacional@gmail.com','super_admin');
 create table crm_contacts(id uuid primary key,nombre text,email_normalized text,phone_normalized text);insert into crm_contacts values('${contact}','Fixture','client@example.test',null);
 create table crm_conversations(id uuid primary key,contact_id uuid,source_channel text,source_ref text,origin text,qualification_data jsonb,estado text,received_at timestamptz,subject text,inbound_body text,updated_at timestamptz default now(),test_hidden_at timestamptz,email_return_linked_to uuid);
 create table crm_commercial_cases(id uuid primary key,conversation_id uuid,assigned_user_id uuid,status text,created_at timestamptz default now());
 create table crm_inbound_events(id uuid default gen_random_uuid(),conversation_id uuid,source_channel text,source_ref text,origin text,body text,received_at timestamptz);
 create table crm_commercial_case_inbound(case_id uuid,conversation_id uuid,inbound_event_id uuid);create table crm_commercial_case_replies(case_id uuid,conversation_id uuid,reply_id uuid);
 create table crm_commercial_case_send_attempts(case_id uuid,status text);
 create table crm_replies(id uuid primary key,conversation_id uuid,body text,operador text,status text,provider_message_id text,created_at timestamptz default now());
 create table crm_activities(id uuid,conversation_id uuid,contact_id uuid,activity_type text,summary text,outcome text,next_step text,follow_up_at timestamptz,author text,created_at timestamptz);
 `);
 for(const file of ['crm_commercial_team_candidate.sql','crm_commercial_team_read_candidate.sql','crm_commercial_team_forms_candidate.sql','crm_commercial_team_form_reply_candidate.sql','crm_commercial_team_form_read_candidate.sql'])await db.exec(await readFile(new URL('../sql/candidates/'+file,import.meta.url),'utf8'));
 const approval=await readFile(new URL('../sql/migrations/20261025223000_commercial_advisor_approval.sql',import.meta.url),'utf8');
 await db.exec(approval.slice(approval.indexOf('create function public.crm_commercial_owner('),approval.indexOf('create function public.crm_commercial_advisor_request_json(')));
 await db.exec(await readFile(new URL('../sql/migrations/20261028190000_crm_commercial_email_triage.sql',import.meta.url),'utf8'));
 await db.query('select crm_commercial_advisor_add($1,false,$2)',[manager,'advisor@example.test']);
 await db.query('select crm_commercial_advisor_add($1,false,$2)',[manager,'other@example.test']);
 for(const id of [target,neighbor]){
  await db.query("insert into crm_conversations(id,contact_id,source_channel,source_ref,origin,qualification_data,estado,received_at,subject,inbound_body) values($1,$2,'email',$3,'institutional_email',$4,'nuevo','2026-10-26T12:00:00Z','Consulta institucional','Texto original de correo')",[id,contact,'stored-mail:'+id,{routing:{workflow:'institutional'},commercial_triage:{kind:'forged-client-metadata'}}]);
  await db.query("insert into crm_inbound_events(conversation_id,source_channel,source_ref,origin,body,received_at) values($1,'email',$2,'institutional_email','Texto original de correo','2026-10-26T12:00:00Z')",[id,'stored-mail:'+id]);
 }
 const classify=(actor=owner,id=target,assigned=advisor)=>db.query('select crm_commercial_email_classify($1,$2,$3,$4) result',[actor,id,assigned,'Consulta comercial recibida por correo, revisada por administración.']);
 await fn({db,classify});
}finally{await db.close();}}

test('owner classification preserves actual email provenance and makes only that case visible to its advisor and director',()=>fixture(async({db,classify})=>{
 const before=(await db.query('select origin,source_ref,received_at,subject,inbound_body from crm_conversations where id=$1',[target])).rows[0];
 assert.equal((await db.query('select crm_commercial_form_is_allowed($1) ok',[target])).rows[0].ok,false);
 await db.exec('set role service_role');
 try{await classify();}finally{await db.exec('reset role');}
 assert.deepEqual((await db.query('select origin,source_ref,received_at,subject,inbound_body from crm_conversations where id=$1',[target])).rows[0],before);
 const q=(await db.query('select qualification_data from crm_conversations where id=$1',[target])).rows[0].qualification_data;
 assert.equal(q.routing.workflow,'institutional');assert.equal(q.form_submission,undefined);assert.equal(q.commercial_triage.kind,'owner_classified_institutional_email');
 assert.equal((await db.query('select crm_commercial_form_is_allowed($1) ok',[neighbor])).rows[0].ok,false);
 for(const actor of [manager,advisor]){const r=(await db.query('select crm_commercial_team_form_list($1,false) data',[actor])).rows[0].data;assert.deepEqual(r.map(x=>x.id),[target]);}
 assert.deepEqual((await db.query('select crm_commercial_team_form_list($1,false) data',[otherAdvisor])).rows[0].data,[]);
 assert.equal((await db.query('select crm_commercial_team_form_read($1,false,$2) data',[otherAdvisor,target])).rows[0].data,null);
 assert.equal((await db.query('select count(*) n from crm_commercial_email_triage_audit')).rows[0].n,1);
}));
test('classification is idempotent and does not reset a later legitimate reassignment',()=>fixture(async({db,classify})=>{
 await classify();await classify();
 assert.equal((await db.query('select count(*) n from crm_commercial_email_triage_audit')).rows[0].n,1);
 await db.query('select crm_commercial_form_assign($1,false,$2,$3,0)',[manager,target,otherAdvisor]);
 const r=(await classify()).rows[0].result;assert.equal(r.alreadyClassified,true);assert.equal(r.assignedUserId,otherAdvisor);
 await assert.rejects(classify(owner,target,otherAdvisor),/already classified/);
 assert.equal((await db.query('select crm_commercial_team_form_read($1,false,$2) data',[advisor,target])).rows[0].data,null);
 assert.equal((await db.query('select crm_commercial_team_form_read($1,false,$2) data',[otherAdvisor,target])).rows[0].data.id,target);
 await assert.rejects(db.query('update crm_commercial_email_triage set reason=$1',['change']),/IMMUTABLE/);
 await assert.rejects(db.query('delete from crm_commercial_email_triage_audit'),/IMMUTABLE/);
}));
test('director and ordinary advisor cannot classify; persisted owner must be confirmed and service RPC is not public',()=>fixture(async({db,classify})=>{
 for(const actor of [manager,advisor,otherAdvisor])await assert.rejects(classify(actor),/not authorized/);
 await db.query('update auth.users set email_confirmed_at=null where id=$1',[owner]);await assert.rejects(classify(),/not authorized/);
 await db.query('update auth.users set email_confirmed_at=now() where id=$1',[owner]);await db.query("update user_roles set role='jugador'");await assert.rejects(classify(),/not authorized/);
 assert.equal((await db.query('select count(*) n from crm_commercial_email_triage')).rows[0].n,0);
 for(const role of ['anon','authenticated'])assert.equal((await db.query("select has_function_privilege($1,'crm_commercial_email_classify(uuid,uuid,uuid,text)','execute') allowed",[role])).rows[0].allowed,false);
 assert.equal((await db.query("select has_function_privilege('service_role','crm_commercial_email_classify(uuid,uuid,uuid,text)','execute') allowed")).rows[0].allowed,true);
 assert.equal((await db.query("select has_table_privilege('service_role','crm_commercial_email_triage','insert') allowed")).rows[0].allowed,false);
 await db.exec('set role authenticated');
 try{await assert.rejects(classify(),/permission denied/);}finally{await db.exec('reset role');}
}));
test('hidden, linked, non-institutional and unbacked messages are not eligible and invalid advisors grant nothing',()=>fixture(async({db,classify})=>{
 await db.query('update crm_conversations set test_hidden_at=now() where id=$1',[target]);await assert.rejects(classify(),/unavailable/);
 await db.query('update crm_conversations set test_hidden_at=null,email_return_linked_to=$2 where id=$1',[target,neighbor]);await assert.rejects(classify(),/unavailable/);
 await db.query("update crm_conversations set email_return_linked_to=null,origin='support_email' where id=$1",[target]);await assert.rejects(classify(),/unavailable/);
 await db.query("update crm_conversations set origin='institutional_email' where id=$1",[target]);await db.query('delete from crm_inbound_events where conversation_id=$1',[target]);await assert.rejects(classify(),/original inbound/);
 await db.query('update crm_commercial_advisors set active=false where user_id=$1',[advisor]);await assert.rejects(classify(owner,neighbor),/advisor unavailable/);
 assert.equal((await db.query('select count(*) n from crm_commercial_email_triage')).rows[0].n,0);
}));
test('network metadata and serialized trusted flags never grant institutional access in JS',()=>{
 const row={id:target,source_channel:'email',origin:'institutional_email',commercial_email_classified:true,qualification_data:{commercial_triage:{kind:'owner_classified_institutional_email'},routing:{workflow:'commercial_lead'}}};
 assert.equal(isCommercialConversation(row),false);
 const verified=markVerifiedCommercialEmail(row,{conversation_id:target});assert.equal(isCommercialConversation(verified),true);
 assert.equal(isCommercialConversation(JSON.parse(JSON.stringify(verified))),false);
 assert.equal(isCommercialConversation({...verified}),false);
 assert.equal(isCommercialConversation(markVerifiedCommercialEmail(row,{conversation_id:neighbor})),false);
});

function repositoryFixture({enabled=true,missing=false}={}){
 const triaged={id:target,source_channel:'email',origin:'institutional_email',test_hidden_at:null,email_return_linked_to:null,estado:'nuevo',updated_at:'2026-10-28',qualification_data:{commercial_triage:{kind:'from-client'}},contact:{email_normalized:'fixture@example.test'}};
 const records=[triaged,{...triaged,id:neighbor},{...triaged,id:'hidden',test_hidden_at:'2026-10-26'},{...triaged,id:'linked',email_return_linked_to:neighbor},{...triaged,id:'form',origin:CRM_COMMERCIAL_FORM_ORIGINS[0]}];
 const classified=new Set([target,'hidden','linked']),queries=[];
 const db={from(table){const q={table,filters:[]};queries.push(q);const b={select(v){q.select=v;return b;},eq(k,v){q.filters.push(r=>r[k]===v);return b;},in(k,v){q.filters.push(r=>v.includes(r[k]));return b;},is(k,v){q.filters.push(r=>r[k]===v);return b;},not(k,_op,v){q.filters.push(r=>r[k]!==v);return b;},order(){return b;},limit(){return b;},maybeSingle(){q.single=true;return b;},then(resolve){let data;if(table==='crm_commercial_email_triage')data=[...classified].map(conversation_id=>({conversation_id}));else data=records;
 if(q.select?.includes('crm_commercial_email_triage!inner'))data=data.filter(r=>classified.has(r.id)).map(r=>({...r,commercial_email_triage:{conversation_id:r.id}}));
 data=data.filter(r=>q.filters.every(f=>f(r)));return Promise.resolve({data:q.single?data[0]||null:data,error:missing&&(table==='crm_commercial_email_triage'||q.select?.includes('crm_commercial_email_triage!inner'))?{code:'42P01'}:null}).then(resolve);}};return b;}};
 const repo=createSupabaseCrmRepository(db,{commercialEmailTriageEnabled:enabled});
 return {repo,queries,service:createCrmAdminService({repository:repo,commercialOperators:CRM_COMMERCIAL_OPERATORS})};
}
test('Nico generic inbox includes only authoritative joined email IDs, and direct institutional detail stays scoped',async()=>{
 const f=repositoryFixture(),actor={email:'sm@padbol.com',userId:manager,role:'admin_nacional'};
 const rows=await f.service.listInbox({...actor,filters:{sourceChannel:'email'}});assert.deepEqual(rows.map(r=>r.id).sort(),[target,'form'].sort());
 assert.equal((await f.service.getInbox({...actor,id:target})).id,target);
 await assert.rejects(f.service.getInbox({...actor,id:neighbor}),e=>e.status===404);
 const joined=f.queries.find(q=>q.select?.includes('crm_commercial_email_triage!inner'));assert.ok(joined);
});
test('flag off or missing migration excludes institutional emails without breaking existing forms',async()=>{
 for(const config of [{enabled:false},{missing:true}]){
  const f=repositoryFixture(config),actor={email:'sm@padbol.com',userId:manager,role:'admin_nacional'};
  assert.deepEqual((await f.service.listInbox({...actor,filters:{sourceChannel:'email'}})).map(r=>r.id),['form']);
  await assert.rejects(f.service.getInbox({...actor,id:target}),e=>e.status===404);
  if(config.enabled===false)assert.equal(f.queries.some(q=>q.table==='crm_commercial_email_triage'||q.select?.includes('crm_commercial_email_triage!inner')),false);
 }
});
