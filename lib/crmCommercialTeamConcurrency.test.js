import {test} from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,readFile,rm} from 'node:fs/promises';import {tmpdir,userInfo} from 'node:os';import {join} from 'node:path';import {execFileSync} from 'node:child_process';import pg from 'pg';
const {Client}=pg;
test('PostgreSQL serializes a claim against reassignment in both orders', {timeout:60000},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'crm-team-pg-'));const port=30000+Math.floor(Math.random()*20000);let running=false,a,b;
 const manager='7225442b-defd-42c1-a5a2-b9c1c339fa69',advisor='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',cid='dddddddd-dddd-4ddd-8ddd-dddddddddddd',conv='11111111-1111-4111-8111-111111111111';
 try{
  execFileSync('initdb',['-D',join(dir,'data'),'-A','trust','--no-locale'],{stdio:'ignore'});
  execFileSync('pg_ctl',['-D',join(dir,'data'),'-l',join(dir,'server.log'),'-o',`-F -h '' -k ${dir} -p ${port}`,'-w','start'],{stdio:'ignore'});running=true;
  const cfg={host:dir,port,user:userInfo().username,database:'postgres'};a=new Client(cfg);b=new Client(cfg);await a.connect();await b.connect();
  await a.query(`create role anon;create role authenticated;create role service_role;create schema auth;create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz);
 create table crm_contacts(id uuid primary key,nombre text,phone_normalized text);
 create table crm_conversations(id uuid primary key,contact_id uuid,source_channel text,origin text,identity_used text);
 create table crm_inbound_events(id uuid primary key,conversation_id uuid,source_channel text,body text,received_at timestamptz);
 create table crm_replies(id uuid primary key,conversation_id uuid,body text,operador text,status text,provider_message_id text,created_at timestamptz default now());
 insert into auth.users values('${manager}','sm@padbol.com',now()),('${advisor}','advisor@example.com',now());
 insert into crm_conversations values('${conv}',null,'whatsapp','whatsapp:1376102838911694','123');`);
  for(const p of ['../sql/20261020000000_crm_whatsapp_manual_claim.sql','../sql/candidates/crm_commercial_cases.sql','../sql/candidates/crm_commercial_case_reply_claim.sql','../sql/candidates/crm_commercial_team_candidate.sql','../sql/candidates/crm_commercial_team_read_candidate.sql','../sql/candidates/crm_commercial_team_reply_candidate.sql'])await a.query(await readFile(new URL(p,import.meta.url),'utf8'));
  await a.query('select crm_commercial_advisor_add($1,false,$2)',[manager,'advisor@example.com']);
  await a.query('insert into crm_commercial_cases(id,conversation_id,assigned_user_id) values($1,$2,$3)',[cid,conv,advisor]);
  await a.query('begin');await a.query('select crm_commercial_team_claim_reply($1,$2,false,$3,$4)',[cid,advisor,'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee','hola']);
  let finished=false;const assigning=b.query('select crm_commercial_case_assign($1,false,$2,$3,0)',[manager,cid,manager]).then(()=>({ok:true}),error=>({error})).finally(()=>{finished=true});
  await new Promise(resolve=>setTimeout(resolve,100));assert.equal(finished,false);await a.query('commit');
  assert.match((await assigning).error.message,/pending send/);
  await a.query("update crm_commercial_case_send_attempts set status='cancelled'");
  await a.query('begin');await a.query('select crm_commercial_case_assign($1,false,$2,$3,0)',[manager,cid,manager]);
  finished=false;const claiming=b.query('select crm_commercial_team_claim_reply($1,$2,false,$3,$4)',[cid,advisor,'ffffffff-ffff-4fff-8fff-ffffffffffff','hola']).then(()=>({ok:true}),error=>({error})).finally(()=>{finished=true});
  await new Promise(resolve=>setTimeout(resolve,100));assert.equal(finished,false);await a.query('commit');
  assert.match((await claiming).error.message,/case unavailable/);
 }finally{if(a)await a.end().catch(()=>{});if(b)await b.end().catch(()=>{});if(running)execFileSync('pg_ctl',['-D',join(dir,'data'),'-m','immediate','-w','stop'],{stdio:'ignore'});await rm(dir,{recursive:true,force:true});}
});
test('PostgreSQL serializes legacy email claim against commercial assignment', {timeout:60000},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'crm-form-pg-'));const port=30000+Math.floor(Math.random()*20000);let running=false,a,b;
 const manager='7225442b-defd-42c1-a5a2-b9c1c339fa69',advisor='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',cid='dddddddd-dddd-4ddd-8ddd-dddddddddddd';
 try{
  execFileSync('initdb',['-D',join(dir,'data'),'-A','trust','--no-locale'],{stdio:'ignore'});
  execFileSync('pg_ctl',['-D',join(dir,'data'),'-l',join(dir,'server.log'),'-o',`-F -h '' -k ${dir} -p ${port}`,'-w','start'],{stdio:'ignore'});running=true;
  const cfg={host:dir,port,user:userInfo().username,database:'postgres'};a=new Client(cfg);b=new Client(cfg);await a.connect();await b.connect();
  await a.query(`create role anon;create role authenticated;create role service_role;create schema auth;create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz);
 create table crm_contacts(id uuid primary key,nombre text,email_normalized text,phone_normalized text);
 create table crm_conversations(id uuid primary key,contact_id uuid,source_channel text,origin text,qualification_data jsonb,estado text);
 create table crm_commercial_cases(id uuid primary key,conversation_id uuid,assigned_user_id uuid,status text);
 create table crm_commercial_case_send_attempts(case_id uuid,status text);
 create table crm_replies(id uuid primary key,conversation_id uuid,body text,operador text,status text,provider_message_id text,created_at timestamptz default now());
 insert into auth.users values('${manager}','sm@padbol.com',now()),('${advisor}','advisor@example.com',now());`);
  for(const p of ['../sql/candidates/crm_commercial_team_candidate.sql','../sql/candidates/crm_commercial_team_forms_candidate.sql'])await a.query(await readFile(new URL(p,import.meta.url),'utf8'));
  // Minimal identical case authorization, independent of list projections.
  await a.query(`create function public.crm_commercial_team_case_allowed(uuid,boolean,uuid) returns boolean language sql stable as $$ select $1=$3 or public.crm_commercial_team_manage($1,$2) $$`);
  await a.query(await readFile(new URL('../sql/candidates/crm_commercial_team_form_reply_candidate.sql',import.meta.url),'utf8'));
  await a.query('select crm_commercial_advisor_add($1,false,$2)',[manager,'advisor@example.com']);
  await a.query(`insert into crm_conversations(id,source_channel,origin,qualification_data,estado) values($1,'email','web_form:solicitud_licencia','{"routing":{"workflow":"commercial_lead"}}','nuevo')`,[cid]);
  await a.query('select crm_commercial_form_assign($1,false,$2,$3,0)',[manager,cid,advisor]);
  await a.query('begin');await a.query("insert into crm_replies(id,conversation_id,body,operador,status) values('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',$1,'Legacy','sm@padbol.com','pending')",[cid]);
  let finished=false;const assigning=b.query('select crm_commercial_form_assign($1,false,$2,$3,1)',[manager,cid,manager]).then(()=>({ok:true}),error=>({error})).finally(()=>{finished=true});
  await new Promise(resolve=>setTimeout(resolve,100));assert.equal(finished,false);await a.query('commit');assert.match((await assigning).error.message,/pending send/);
  const claim=(await a.query("select crm_commercial_team_form_claim_reply($1,false,$2,'ffffffff-ffff-4fff-8fff-ffffffffffff','hello') as data",[advisor,cid])).rows[0].data;
  assert.equal(claim.blocked,true);
 }finally{if(a)await a.end().catch(()=>{});if(b)await b.end().catch(()=>{});if(running)execFileSync('pg_ctl',['-D',join(dir,'data'),'-m','immediate','-w','stop'],{stdio:'ignore'});await rm(dir,{recursive:true,force:true});}
});
