import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import {Webhook} from 'svix';
import {PGlite} from '@electric-sql/pglite';
import {createCrmEmailReturn,canonicalMessageId} from './crmEmailReturn.js';
const conversation='11111111-1111-4111-8111-111111111111',contact='22222222-2222-4222-8222-222222222222',reply='33333333-3333-4333-8333-333333333333';
const provider='44444444-4444-4444-8444-444444444444';
async function fixture(fn){
 const db=new PGlite(), secret='whsec_'+randomBytes(32).toString('base64');
 try{
  await db.exec(`create role anon;create role authenticated;create role service_role;
   create table crm_contacts(id uuid primary key,email_normalized text);
   create table crm_conversations(id uuid primary key,contact_id uuid references crm_contacts,source_channel text,origin text,test_hidden_at timestamptz,updated_at timestamptz,inbound_body text,estado text);
   create table crm_replies(id uuid primary key,conversation_id uuid references crm_conversations,provider_message_id text);
   create table crm_inbound_events(id uuid default gen_random_uuid(),conversation_id uuid,source_channel text,source_ref text,origin text,subject text,body text,received_at timestamptz,unique(source_channel,origin,source_ref));
   create table crm_activities(contact_id uuid,conversation_id uuid,activity_type text,summary text,author text);
   insert into crm_contacts values('${contact}','client@example.test');
   insert into crm_conversations values('${conversation}','${contact}','email','web_form:original',null,now(),'Original form','espera');
   insert into crm_replies values('${reply}','${conversation}','${provider}');`);
  await db.exec(await readFile('sql/migrations/20261028160000_crm_email_provider_receipts.sql','utf8'));
  let network=0;const pool={async connect(){network++;return{query:(...a)=>db.query(...a),release(){}};}};
  const env={CRM_OUTBOUND_EMAIL_REPLY_TO:'info@padbol.com',CRM_EMAIL_RETURN_ENABLED:'true',CRM_EMAIL_PROVIDER_WEBHOOK_SECRET:secret};
  const service=createCrmEmailReturn({pool,env});
  const signed=(overrides={},date=new Date())=>{const event={type:'email.sent',created_at:new Date().toISOString(),data:{email_id:provider,message_id:'<outbound@resend.example>',...overrides.data},...overrides};const raw=Buffer.from(JSON.stringify(event)),id='msg_test';return{raw,headers:{'svix-id':id,'svix-timestamp':String(Math.floor(date.getTime()/1000)),'svix-signature':new Webhook(secret).sign(id,date,raw)}};};
  const incoming={externalId:'incoming@example.test',from:'client@example.test',to:'info@padbol.com',inReplyTo:'<outbound@resend.example>',references:[],subject:'Re: Padbol',body:'Podemos hablar el martes.',receivedAt:new Date().toISOString()};
  await fn({db,pool,env,service,signed,incoming,network:()=>network});
 }finally{await db.close();}
}
test('verified provider receipt threads exactly one reply and preserves original form, state and audit',()=>fixture(async f=>{
 const s=f.signed();assert.deepEqual(await f.service.providerEvent(s.raw,s.headers),{recorded:true});
 assert.equal((await f.service.ingestReply(f.incoming)).conversationId,conversation);
 assert.equal((await f.service.ingestReply(f.incoming)).repeated,true);
 assert.equal((await f.db.query('select * from crm_inbound_events')).rows.length,1);
 assert.equal((await f.db.query('select * from crm_activities')).rows.length,1);
 const row=(await f.db.query('select * from crm_conversations')).rows[0];assert.equal(row.inbound_body,'Original form');assert.equal(row.estado,'espera');
}));
test('unsigned, modified and old callbacks cannot touch storage',()=>fixture(async f=>{
 const s=f.signed(),n=f.network();
 for(const [raw,headers]of [[s.raw,{}],[Buffer.from(s.raw.toString()+' '),s.headers],[f.signed({},new Date(Date.now()-600000)).raw,f.signed({},new Date(Date.now()-600000)).headers]])
  await assert.rejects(f.service.providerEvent(raw,headers),e=>e.status===401);
 assert.equal(f.network(),n);
}));
test('sender or subject alone, wrong mailbox, wrong sender and hidden lead never join a commercial thread',()=>fixture(async f=>{
 const s=f.signed();await f.service.providerEvent(s.raw,s.headers);
 for(const event of [{...f.incoming,inReplyTo:null},{...f.incoming,to:'other@padbol.com'},{...f.incoming,from:'attacker@example.test'},{...f.incoming,inReplyTo:'unknown@example.test'}])assert.equal((await f.service.ingestReply(event)).matched,false);
 await f.db.query('update crm_conversations set test_hidden_at=now()');assert.equal((await f.service.ingestReply(f.incoming)).matched,false);
 assert.equal((await f.db.query('select * from crm_inbound_events')).rows.length,0);
}));
test('receipt retries are idempotent, preserve delivery and reject RFC ID reassignment',()=>fixture(async f=>{
 for(const type of ['email.delivered','email.sent','email.delivered']){const s=f.signed({type});await f.service.providerEvent(s.raw,s.headers);}
 const row=(await f.db.query('select * from crm_email_provider_receipts')).rows[0];assert.ok(row.delivered_at);assert.ok(row.sent_at);
 const s=f.signed({data:{email_id:provider,message_id:'different@example.test'}});await assert.rejects(f.service.providerEvent(s.raw,s.headers),e=>e.status===409);
 assert.equal((await f.db.query('select rfc_message_id from crm_email_provider_receipts')).rows[0].rfc_message_id,'outbound@resend.example');
}));
test('unrelated provider mail is ignored and a known pending CRM send requests retry',()=>fixture(async f=>{
 let s=f.signed({data:{email_id:'unknown',message_id:'other@example.test'}});assert.deepEqual(await f.service.providerEvent(s.raw,s.headers),{ignored:true});
 await f.db.query('update crm_replies set provider_message_id=null');
 s=f.signed({data:{email_id:provider,message_id:'other@example.test',tags:{crm_reply_id:reply}}});await assert.rejects(f.service.providerEvent(s.raw,s.headers),e=>e.code==='CRM_EMAIL_PROVIDER_REPLY_NOT_READY');
}));
test('disabled return integration never reads the mailbox or database',async()=>{
 const service=createCrmEmailReturn({pool:{connect(){throw Error('must not read')}},env:{}});
 assert.equal(service.enabled,false);assert.deepEqual(await service.ingestReply({}),{matched:false});await assert.rejects(service.providerEvent(Buffer.from('{}'),{}),e=>e.status===503);
 assert.equal(canonicalMessageId('bad\r\n@example.test'),null);
});
