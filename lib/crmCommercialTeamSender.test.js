import {test} from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';import {PGlite} from '@electric-sql/pglite';import {createCommercialTeamSender} from './crmCommercialTeamSender.js';
test('advisor sends only assigned case, and reassignment blocks pending send',async()=>{
 const db=new PGlite(),manager='7225442b-defd-42c1-a5a2-b9c1c339fa69',advisor='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',outsider='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',cid='dddddddd-dddd-4ddd-8ddd-dddddddddddd',rid='eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
 try{
 await db.exec(`create role anon; create role authenticated; create role service_role; create schema auth;
 create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz);
 insert into auth.users values('${manager}','sm@padbol.com',now()),('${advisor}','advisor@example.com',now()),('${outsider}','other@example.com',now());
 create table crm_contacts(id uuid primary key,nombre text,phone_normalized text);
 create table crm_conversations(id uuid primary key,contact_id uuid,source_channel text,origin text,identity_used text);
 create table crm_inbound_events(id uuid primary key,conversation_id uuid,source_channel text,body text,received_at timestamptz);
 create table crm_replies(id uuid primary key,conversation_id uuid,body text,operador text,status text,provider_message_id text,created_at timestamptz default now());
 insert into crm_conversations values('11111111-1111-4111-8111-111111111111',null,'whatsapp','whatsapp:1376102838911694','123');`);
 for(const p of ['../sql/20261020000000_crm_whatsapp_manual_claim.sql','../sql/candidates/crm_commercial_cases.sql','../sql/candidates/crm_commercial_case_reply_claim.sql','../sql/candidates/crm_commercial_team_candidate.sql','../sql/candidates/crm_commercial_team_read_candidate.sql','../sql/candidates/crm_commercial_team_reply_candidate.sql'])await db.exec(await readFile(new URL(p,import.meta.url),'utf8'));
 await db.query('select crm_commercial_advisor_add($1,false,$2)',[manager,'advisor@example.com']);
 await db.query('insert into crm_commercial_cases(id,conversation_id,assigned_user_id) values($1,$2,$3)',[cid,'11111111-1111-4111-8111-111111111111',advisor]);
 const claim=(actor,id)=>db.query('select crm_commercial_team_claim_reply($1,$2,false,$3,$4)',[cid,actor,id,'Hola']);
 await assert.rejects(claim(outsider,rid),/case unavailable/);
 await claim(advisor,rid);
 await assert.rejects(db.query('select crm_commercial_case_assign($1,false,$2,$3,0)',[manager,cid,manager]),/pending send/);
 let sent=0;const pool={async connect(){return{query:(...args)=>db.query(...args),release(){}}}};
 const dispatch=createCommercialTeamSender({pool,send:async()=>{sent++;return{providerMessageId:'provider-1'}}});
 assert.equal((await dispatch({caseId:cid,actorId:outsider,replyId:rid})).status,'already_attempted');
 assert.equal((await dispatch({caseId:cid,actorId:advisor,replyId:rid})).status,'sent');
 assert.equal((await dispatch({caseId:cid,actorId:advisor,replyId:rid})).status,'already_attempted');assert.equal(sent,1);
 await db.query('select crm_commercial_case_assign($1,false,$2,$3,0)',[manager,cid,manager]);
 await assert.rejects(claim(advisor,'ffffffff-ffff-4fff-8fff-ffffffffffff'),/case unavailable/);
 }finally{await db.close();}
});
