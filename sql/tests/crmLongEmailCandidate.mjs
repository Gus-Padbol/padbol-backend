// In-memory compatibility candidate. Never connects to Supabase or sends messages.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const {PGlite}=await import(process.env.PADBOL_PGLITE_MODULE);
const original=await readFile('sql/candidates/crm_long_email_original_function.sql','utf8');
const up=await readFile('sql/candidates/crm_long_email_up.sql','utf8'),down=await readFile('sql/candidates/crm_long_email_down.sql','utf8');
const ids={email:'11111111-1111-4111-8111-111111111111',wa:'22222222-2222-4222-8222-222222222222',actor:'33333333-3333-4333-8333-333333333333',other:'44444444-4444-4444-8444-444444444444',reply:'55555555-5555-4555-8555-555555555555'};
async function fixture(){const db=new PGlite();await db.exec(await readFile('sql/tests/crmLongEmailFixture.sql','utf8'));await db.exec(original+';');await db.exec('revoke all on function public.crm_commercial_team_form_claim_reply(uuid,boolean,uuid,uuid,text) from public,anon,authenticated;grant execute on function public.crm_commercial_team_form_claim_reply(uuid,boolean,uuid,uuid,text) to service_role;');return db;}
const db=await fixture();let checks=0;
try{
 const acl=(await db.query("select proacl::text as acl from pg_proc where oid='public.crm_commercial_team_form_claim_reply(uuid,boolean,uuid,uuid,text)'::regprocedure")).rows[0].acl;
 await db.exec(up);checks++;
 assert.equal((await db.query("select proacl::text as acl from pg_proc where oid='public.crm_commercial_team_form_claim_reply(uuid,boolean,uuid,uuid,text)'::regprocedure")).rows[0].acl,acl);checks++;
 for(const char of ['x','😀']){
  await db.query('insert into public.crm_replies(conversation_id,body) values($1,$2)',[ids.email,char.repeat(16384)]);checks++;
  await assert.rejects(db.query('insert into public.crm_replies(conversation_id,body) values($1,$2)',[ids.email,char.repeat(16385)]),e=>e.code==='23514');checks++;
  await db.query('insert into public.crm_replies(conversation_id,body) values($1,$2)',[ids.wa,char.repeat(4096)]);checks++;
  await assert.rejects(db.query('insert into public.crm_replies(conversation_id,body) values($1,$2)',[ids.wa,char.repeat(4097)]),e=>['23514','23503'].includes(e.code));checks++;
 }
 await assert.rejects(db.query('insert into public.crm_replies(conversation_id,body) values($1,$2)',[ids.email,'   ']),e=>e.code==='23514');checks++;
 await assert.rejects(db.query('update public.crm_conversations set source_channel=$1 where id=$2',['whatsapp',ids.email]),e=>e.code==='23503');checks++;
 await db.query('insert into public.crm_conversations values($1,$2)',['66666666-6666-4666-8666-666666666666','email']);await db.query('update public.crm_conversations set source_channel=$1 where id=$2',['whatsapp','66666666-6666-4666-8666-666666666666']);checks++;
 await db.query('insert into public.crm_replies(conversation_id,body,status) values($1,$2,$3)',['66666666-6666-4666-8666-666666666666','short preserved history','sent']);
 await db.query('update public.crm_conversations set source_channel=$1 where id=$2',['email','66666666-6666-4666-8666-666666666666']);checks++;
 await assert.rejects(db.query('insert into public.crm_replies(conversation_id,body,long_email_channel) values($1,$2,$3)',[ids.wa,'x'.repeat(5000),null]),e=>e.code==='23503');checks++;
 await assert.rejects(db.query('update public.crm_replies set conversation_id=$1 where conversation_id=$2 and length(body)>4096',[ids.wa,ids.email]),e=>e.code==='23503');checks++;
 await db.exec("update public.crm_replies set status='sent'"); // Boundary fixtures are historical; leave no unrelated pending send.
 const text='Long reply\n'+ '😀'.repeat(5000),claim=async(body,actor=ids.actor)=> (await db.query('select public.crm_commercial_team_form_claim_reply($1,false,$2,$3,$4) as result',[actor,ids.email,ids.reply,body])).rows[0].result;
 assert.equal((await claim(text)).created,true);assert.equal((await claim(text)).created,false);checks+=2;
 await assert.rejects(claim(text+'changed'),/reply conflict/);checks++;
 await assert.rejects(claim(text,ids.other),/case unavailable/);checks++;
 assert.equal((await db.query('select count(*)::int as n from public.crm_commercial_form_send_attempts where reply_id=$1',[ids.reply])).rows[0].n,1);checks++;
 await db.query("update public.crm_replies set status='sent',provider_message_id='fixture-provider' where id=$1",[ids.reply]);assert.equal((await db.query('select body from public.crm_replies where id=$1',[ids.reply])).rows[0].body,text);checks++;
 const before=(await db.query('select id::text,body,status,provider_message_id from public.crm_replies order by id')).rows;
 await assert.rejects(db.exec(down),/strict rollback blocked/);await db.exec('rollback');assert.deepEqual((await db.query('select id::text,body,status,provider_message_id from public.crm_replies order by id')).rows,before);checks++;
 console.log(JSON.stringify({checks,long_email_storage:true,whatsapp_unchanged:true,claim_replay_once:true,acl_unchanged:true,history_preserved:true,strict_rollback_refused_with_long_history:true,external_sends:0,concurrency_tested:false}));
}finally{await db.close();}
const fresh=await fixture();try{await fresh.exec(up);await fresh.exec(down);assert.equal((await fresh.query("select md5(pg_get_functiondef('public.crm_commercial_team_form_claim_reply(uuid,boolean,uuid,uuid,text)'::regprocedure)) as hash")).rows[0].hash,'e4628b120b2b9478de08076a5ec0ef6a');assert.equal((await fresh.query('select body from public.crm_replies')).rows[0].body,'preserved historical message');console.log('STRICT_ROLLBACK_WITHOUT_LONG_ROWS_PASS');}finally{await fresh.close();}
for(const char of ['\u0001','😀']){const text=char.repeat(16384);assert.ok(Buffer.byteLength(JSON.stringify({channel:'form',body:text,requestId:ids.reply}),'utf8')<100*1024);}console.log('REQUEST_JSON_UNDER_EXISTING_100KB_LIMIT_PASS');
