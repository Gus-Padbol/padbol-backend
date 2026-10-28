import test from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';import {randomBytes} from 'node:crypto';import {Webhook} from 'svix';import {PGlite} from '@electric-sql/pglite';
import {createCrmEmailReturn} from './crmEmailReturn.js';import {createCrmEmailReturnQueue} from './crmEmailReturnQueue.js';
import {createCrmImapInboxSync} from './crmImapInbound.js';
const lead='11111111-1111-4111-8111-111111111111',contact='22222222-2222-4222-8222-222222222222',reply='33333333-3333-4333-8333-333333333333',provider='44444444-4444-4444-8444-444444444444',fallback='55555555-5555-4555-8555-555555555555';
async function fixture(fn){const db=new PGlite(),secret='whsec_'+randomBytes(32).toString('base64');try{
 await db.exec(`create role anon;create role authenticated;create role service_role;
 create table crm_contacts(id uuid primary key,email_normalized text);
 create table crm_conversations(id uuid primary key,contact_id uuid,source_channel text,source_ref text,origin text,test_hidden_at timestamptz,updated_at timestamptz,inbound_body text,estado text,operador text,derivado boolean default false);
 create table crm_replies(id uuid primary key,conversation_id uuid references crm_conversations,provider_message_id text);
 create table crm_inbound_events(id uuid default gen_random_uuid(),conversation_id uuid,source_channel text,source_ref text,origin text,subject text,body text,received_at timestamptz,unique(source_channel,origin,source_ref));
 create table crm_activities(contact_id uuid,conversation_id uuid,activity_type text,summary text,author text);
 revoke all on crm_conversations from public,anon,authenticated;
 insert into crm_contacts values('${contact}','client@example.test');
 insert into crm_conversations(id,contact_id,source_channel,source_ref,origin,inbound_body,estado)values('${lead}','${contact}','email','original-form','web_form:original','Original form','espera');
 insert into crm_replies values('${reply}','${lead}','${provider}');`);
 await db.exec(await readFile('sql/migrations/20261028160000_crm_email_provider_receipts.sql','utf8'));await db.exec(await readFile('sql/migrations/20261028170000_crm_email_return_queue.sql','utf8'));
 const pool={async connect(){return{query:(...args)=>db.query(...args),release(){}}}},env={CRM_OUTBOUND_EMAIL_REPLY_TO:'info@padbol.com',CRM_EMAIL_RETURN_ENABLED:'true',CRM_EMAIL_RETURN_QUEUE_ENABLED:'true',CRM_EMAIL_PROVIDER_WEBHOOK_SECRET:secret};
 const create=()=>createCrmEmailReturnQueue({pool,env,emailReturn:createCrmEmailReturn({pool,env}),logger:{warn(){}}});
 const event={externalId:'incoming@example.test',from:'client@example.test',to:'info@padbol.com',inReplyTo:'outbound@resend.example',references:[],subject:'Re: Padbol',body:'Hablemos el martes.',receivedAt:new Date().toISOString()};
 const signed=(overrides={})=>{const raw=Buffer.from(JSON.stringify({type:'email.sent',created_at:new Date().toISOString(),data:{email_id:provider,message_id:'<outbound@resend.example>'},...overrides})),date=new Date(),id='test_event';return{raw,headers:{'svix-id':id,'svix-timestamp':String(Math.floor(date.getTime()/1000)),'svix-signature':new Webhook(secret).sign(id,date,raw)}};};
 const makeFallback=async(raw=event)=>{await db.query("insert into crm_conversations(id,contact_id,source_channel,source_ref,origin,inbound_body,estado)values($1,$2,'email',$3,'institutional_email',$4,'nuevo')",[fallback,contact,raw.externalId,raw.body]);await db.query("insert into crm_inbound_events(conversation_id,source_channel,source_ref,origin,subject,body,received_at)values($1,'email',$2,'institutional_email',$3,$4,$5)",[fallback,raw.externalId,raw.subject,raw.body,raw.receivedAt]);};
 await fn({db,pool,env,create,service:create(),event,signed,makeFallback});
 }finally{await db.close();}}
test('IMAP before authenticated mapping survives restart and links the preserved institutional copy',()=>fixture(async f=>{
 assert.deepEqual(await f.service.ingestReply(f.event),{matched:false,queued:true});await f.makeFallback();
 const restarted=f.create(),s=f.signed();await restarted.providerEvent(s.raw,s.headers);
 assert.equal((await f.db.query('select email_return_linked_to from crm_conversations where id=$1',[fallback])).rows[0].email_return_linked_to,lead);
 assert.equal((await f.db.query('select inbound_body from crm_conversations where id=$1',[lead])).rows[0].inbound_body,'Original form');
 assert.equal((await f.db.query('select inbound_body from crm_conversations where id=$1',[fallback])).rows[0].inbound_body,f.event.body);
 assert.equal((await f.db.query('select * from crm_inbound_events')).rows.length,2);assert.equal((await f.db.query('select * from crm_inbound_events where conversation_id=$1',[lead])).rows[0].body,f.event.body);
 assert.equal((await f.db.query("select * from crm_conversations where email_return_linked_to is null")).rows.length,1);
 assert.equal((await f.db.query("select count(*) n from crm_email_return_queue_audit where event_type='fallback_linked'")).rows[0].n,1);
}));
test('mapping can arrive before fallback is created; periodic reconciliation recovers a crash before afterFallback',()=>fixture(async f=>{
 await f.service.ingestReply(f.event);let s=f.signed();await f.service.providerEvent(s.raw,s.headers);await f.makeFallback();
 await f.create().reconcilePending();assert.equal((await f.db.query('select email_return_linked_to from crm_conversations where id=$1',[fallback])).rows[0].email_return_linked_to,lead);
}));
test('afterFallback performs immediate cleanup when provider notification won the race',()=>fixture(async f=>{
 await f.service.ingestReply(f.event);const s=f.signed();await f.service.providerEvent(s.raw,s.headers);await f.makeFallback();await f.service.afterFallback(f.event);assert.equal((await f.db.query('select email_return_linked_to from crm_conversations where id=$1',[fallback])).rows[0].email_return_linked_to,lead);
}));
test('mailbox retries, callback retries and worker retries do not duplicate messages or audit links',()=>fixture(async f=>{
 await f.service.ingestReply(f.event);await f.makeFallback();const s=f.signed();for(let n=0;n<3;n++){await f.service.providerEvent(s.raw,s.headers);await f.service.ingestReply({...f.event,receivedAt:new Date().toISOString()});await f.service.afterFallback(f.event);await f.service.reconcilePending();}
 assert.equal((await f.db.query('select count(*) n from crm_inbound_events')).rows[0].n,2);assert.equal((await f.db.query("select count(*) n from crm_email_return_queue_audit where event_type='fallback_linked'")).rows[0].n,1);
}));
test('wrong identity or ambiguous references never attach or hide the institutional message',()=>fixture(async f=>{
 const s=f.signed();await f.service.providerEvent(s.raw,s.headers);const other={...f.event,from:'attacker@example.test'};await f.service.ingestReply(other);assert.equal((await f.db.query('select count(*) n from crm_inbound_events where conversation_id=$1',[lead])).rows[0].n,0);assert.equal((await f.db.query('select review_reason from crm_email_return_pending')).rows[0].review_reason,'IDENTITY_MISMATCH');
 await f.db.query("insert into crm_conversations(id,contact_id,source_channel,origin,inbound_body,estado)values('66666666-6666-4666-8666-666666666666',$1,'email','web_form:another','Another form','nuevo')",[contact]);await f.db.query("insert into crm_replies values('77777777-7777-4777-8777-777777777777','66666666-6666-4666-8666-666666666666','other-provider')");await f.db.query("insert into crm_email_provider_receipts(reply_id,provider_message_id,rfc_message_id) values('77777777-7777-4777-8777-777777777777','other-provider','other@resend.example')");
 const ambiguous={...f.event,externalId:'ambiguous@example.test',references:['other@resend.example']};assert.equal((await f.service.ingestReply(ambiguous)).matched,false);assert.equal((await f.db.query('select review_reason from crm_email_return_pending where external_id=$1',[ambiguous.externalId])).rows[0].review_reason,'AMBIGUOUS_REFERENCES');
}));
test('original text and conflicting variants are preserved; conflicting IDs never hide another contact',()=>fixture(async f=>{
 const original={...f.event,originalBody:'Texto largo '.repeat(1000)};await f.service.ingestReply(original);await f.service.ingestReply({...original,body:'different payload',originalBody:'different payload'});const q=(await f.db.query('select * from crm_email_return_pending')).rows[0];assert.equal(q.raw_event.originalBody,original.originalBody);assert.equal(q.raw_event.body,original.body);assert.equal(q.review_reason,'PAYLOAD_CONFLICT');const a=(await f.db.query("select details from crm_email_return_queue_audit where event_type='payload_conflict'")).rows[0];assert.equal(a.details.event.originalBody,'different payload');const s=f.signed();await f.service.providerEvent(s.raw,s.headers);assert.equal((await f.db.query('select count(*) n from crm_inbound_events')).rows[0].n,0);
}));
test('a fallback with human work remains visible and explicitly requires review',()=>fixture(async f=>{
 await f.service.ingestReply(f.event);await f.makeFallback();await f.db.query("insert into crm_activities(conversation_id,activity_type,summary,author)values($1,'note','Talked with client','advisor')",[fallback]);const s=f.signed();await f.service.providerEvent(s.raw,s.headers);assert.equal((await f.db.query('select email_return_linked_to from crm_conversations where id=$1',[fallback])).rows[0].email_return_linked_to,null);assert.equal((await f.db.query('select review_reason from crm_email_return_pending')).rows[0].review_reason,'FALLBACK_HAS_HUMAN_WORK');
}));
test('authenticated roles cannot set links, invoke internal linking or read the private queue',()=>fixture(async f=>{
 await assert.rejects(f.db.query('update crm_conversations set email_return_linked_to=$1 where id=$2',[lead,lead]),/INTERNAL_ONLY/);
 await assert.rejects(f.db.query("insert into crm_conversations(id,email_return_linked_to)values('99999999-9999-4999-8999-999999999999',$1)",[lead]),/INTERNAL_ONLY/);
 await f.db.exec('set role authenticated');for(const sql of ['select * from crm_email_return_pending','select * from crm_email_return_queue_audit',`select crm_email_return_link_fallback('x','${lead}','${fallback}')`,`update crm_conversations set email_return_linked_to='${lead}' where id='${fallback}'`])await assert.rejects(f.db.query(sql),/permission denied/);await f.db.exec('reset role');
}));
test('disabled queue preserves the existing integration without touching storage',async()=>{
 let calls=0;const base={enabled:true,webhookEnabled:false,async ingestReply(){calls++;return {matched:false}},async providerEvent(){return {ignored:true}}};const wrapped=createCrmEmailReturnQueue({pool:{connect(){throw Error('no DB')}},emailReturn:base,env:{}});assert.equal(wrapped.queueEnabled,false);assert.deepEqual(await wrapped.ingestReply({}),{matched:false});assert.equal(calls,1);assert.deepEqual(await wrapped.reconcilePending(),{enabled:false,processed:0});
});
test('a failed linking transaction rolls back its audit and recovers after restart without duplicating the contact reply',()=>fixture(async f=>{
 await f.service.ingestReply(f.event);await f.makeFallback();await f.db.exec("create function fail_link_test() returns trigger language plpgsql as $$begin raise exception 'simulated_storage_failure';end$$;create trigger fail_link_test before update of email_return_linked_to on crm_conversations for each row execute function fail_link_test();");
 const s=f.signed();await f.service.providerEvent(s.raw,s.headers);assert.equal((await f.db.query('select count(*) n from crm_inbound_events where conversation_id=$1',[lead])).rows[0].n,1);assert.equal((await f.db.query("select count(*) n from crm_email_return_queue_audit where event_type='fallback_linked'")).rows[0].n,0);assert.equal((await f.db.query('select email_return_linked_to from crm_conversations where id=$1',[fallback])).rows[0].email_return_linked_to,null);
 await f.db.exec('drop trigger fail_link_test on crm_conversations');await f.create().reconcilePending();assert.equal((await f.db.query('select count(*) n from crm_inbound_events where conversation_id=$1',[lead])).rows[0].n,1);assert.equal((await f.db.query('select email_return_linked_to from crm_conversations where id=$1',[fallback])).rows[0].email_return_linked_to,lead);assert.equal((await f.db.query("select count(*) n from crm_email_return_queue_audit where event_type='fallback_linked'")).rows[0].n,1);
}));
test('a forged provider notification cannot resolve pending mail',()=>fixture(async f=>{await f.service.ingestReply(f.event);const s=f.signed();await assert.rejects(f.service.providerEvent(s.raw,{}),e=>e.status===401);assert.equal((await f.db.query('select status from crm_email_return_pending')).rows[0].status,'pending');assert.equal((await f.db.query('select count(*) n from crm_inbound_events')).rows[0].n,0);}));

function imapReader(f,{emailReturn=f.service,noNewUid=false,ingest}={}){
 return createCrmImapInboxSync({emailReturn,config:{enabled:true,ready:true,host:'imap.example.test',port:993,secure:true,user:'info@padbol.com',password:'fixture-only',mailbox:'INBOX',expectedRecipient:'info@padbol.com',lookbackDays:7,redactErrors:true},logger:{error(){}},
 crmService:{async ingestInbound(input){if(ingest)return ingest(input);await f.makeFallback({...f.event,body:input.body,externalId:input.sourceId});return {conversation:{id:fallback}};}},
 createClient:()=>({mailbox:{uidValidity:1},async connect(){},async search(){return noNewUid?[]:[1]},async getMailboxLock(){return{release(){}}},async *fetch(){yield{uid:1,source:Buffer.from('fixture source')}},async logout(){}}),
 parseMessage:async()=>({messageId:f.event.externalId,from:{value:[{address:f.event.from}]},to:{value:[{address:f.event.to}]},subject:f.event.subject,text:f.event.body,date:new Date(f.event.receivedAt),inReplyTo:f.event.inReplyTo})});
}
test('real IMAP adapter persists first, then a later signed callback links the owner-visible fallback',()=>fixture(async f=>{
 const result=await imapReader(f).syncOnce();assert.equal(result.status,'ok');assert.equal(result.processed,1);assert.equal((await f.db.query('select email_return_linked_to from crm_conversations where id=$1',[fallback])).rows[0].email_return_linked_to,null);
 const s=f.signed();await f.create().providerEvent(s.raw,s.headers);assert.equal((await f.db.query('select email_return_linked_to from crm_conversations where id=$1',[fallback])).rows[0].email_return_linked_to,lead);
}));
test('an IMAP afterFallback failure does not acknowledge UID and an empty restarted mailbox still reconciles durable work',()=>fixture(async f=>{
 const s=f.signed(),wrapped={...f.service,async afterFallback(){throw Error('simulated restart')}};
 const first=imapReader(f,{emailReturn:wrapped,async ingest(input){await f.service.providerEvent(s.raw,s.headers);await f.makeFallback({...f.event,body:input.body});return {conversation:{id:fallback}};}});
 const failed=await first.syncOnce();assert.equal(failed.status,'error');assert.equal(failed.processed,0);
 assert.equal((await f.db.query('select email_return_linked_to from crm_conversations where id=$1',[fallback])).rows[0].email_return_linked_to,null);
 const second=await imapReader(f,{emailReturn:f.create(),noNewUid:true}).syncOnce();assert.equal(second.status,'ok');assert.equal(second.processed,0);assert.equal((await f.db.query('select email_return_linked_to from crm_conversations where id=$1',[fallback])).rows[0].email_return_linked_to,lead);
}));

test('a linked institutional copy rejects subsequent human reply claims before any outbound dispatch',()=>fixture(async f=>{
 await f.service.ingestReply(f.event);await f.makeFallback();const s=f.signed();await f.service.providerEvent(s.raw,s.headers);
 await assert.rejects(f.db.query("insert into crm_replies(id,conversation_id,provider_message_id)values('99999999-9999-4999-8999-999999999999',$1,null)",[fallback]),/CRM_EMAIL_ALREADY_LINKED/);
 await assert.rejects(f.db.query("insert into crm_activities(conversation_id,activity_type,summary,author)values($1,'note','Human update','advisor')",[fallback]),/CRM_EMAIL_ALREADY_LINKED/);
}));
