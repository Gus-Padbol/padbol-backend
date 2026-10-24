import {test} from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';import {PGlite} from '@electric-sql/pglite';import {createCommercialTeamFormSender} from './crmCommercialTeamFormSender.js';
test('form reply denies outsiders, blocks reassignment and does not resend',async()=>{
 const db=new PGlite(),manager='7225442b-defd-42c1-a5a2-b9c1c339fa69',advisor='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',other='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',cid='dddddddd-dddd-4ddd-8ddd-dddddddddddd',rid='eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
 try{
 await db.exec(`create role anon;create role authenticated;create role service_role;create schema auth;create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz);
 insert into auth.users values('${manager}','sm@padbol.com',now()),('${advisor}','advisor@example.com',now()),('${other}','other@example.com',now());
 create table crm_contacts(id uuid primary key,nombre text,email_normalized text,phone_normalized text);insert into crm_contacts values('11111111-1111-4111-8111-111111111111','C','c@example.com',null);
 create table crm_conversations(id uuid primary key,contact_id uuid,source_channel text,origin text,qualification_data jsonb,estado text,received_at timestamptz,subject text,inbound_body text);
 create table crm_commercial_cases(id uuid primary key,conversation_id uuid,assigned_user_id uuid,status text,created_at timestamptz default now());
 create table crm_inbound_events(id uuid,conversation_id uuid,source_channel text,body text,received_at timestamptz);
 create table crm_commercial_case_inbound(case_id uuid,conversation_id uuid,inbound_event_id uuid);create table crm_commercial_case_replies(case_id uuid,conversation_id uuid,reply_id uuid);
 create table crm_commercial_case_send_attempts(case_id uuid,status text);
 create table crm_replies(id uuid primary key,conversation_id uuid,body text,operador text,status text,provider_message_id text,created_at timestamptz default now());`);
 for(const p of ['crm_commercial_team_candidate.sql','crm_commercial_team_read_candidate.sql','crm_commercial_team_forms_candidate.sql','crm_commercial_team_form_reply_candidate.sql'])await db.exec(await readFile(new URL('../sql/candidates/'+p,import.meta.url),'utf8'));
 await db.query('select crm_commercial_advisor_add($1,false,$2)',[manager,'advisor@example.com']);
 await db.query('insert into crm_conversations(id,contact_id,source_channel,origin,qualification_data,estado) values($1,$2,$3,$4,$5,$6)',[cid,'11111111-1111-4111-8111-111111111111','email','web_form:solicitud_licencia',{routing:{workflow:'commercial_lead'}},'nuevo']);
 await db.query('select crm_commercial_form_assign($1,false,$2,$3,0)',[manager,cid,advisor]);
 const claim=(actor,id)=>db.query('select crm_commercial_team_form_claim_reply($1,false,$2,$3,$4)',[actor,cid,id,'Hola']);
 await assert.rejects(claim(other,rid),/case unavailable/);await claim(advisor,rid);
 await assert.rejects(db.query('select crm_commercial_form_assign($1,false,$2,$3,1)',[manager,cid,manager]),/pending send/);
 let calls=0;const pool={async connect(){return{query:(...args)=>db.query(...args),release(){}}}};
 const dispatch=createCommercialTeamFormSender({pool,send:async x=>{calls++;assert.equal(x.conversation.contact.email_normalized,'c@example.com');return{providerMessageId:'mail-1'}}});
 assert.equal((await dispatch({caseId:cid,actorId:other,replyId:rid})).status,'already_attempted');
 assert.equal((await dispatch({caseId:cid,actorId:advisor,replyId:rid})).status,'sent');assert.equal((await dispatch({caseId:cid,actorId:advisor,replyId:rid})).status,'already_attempted');assert.equal(calls,1);
 }finally{await db.close()}
});
