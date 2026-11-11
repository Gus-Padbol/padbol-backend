// Private Unix-socket PostgreSQL only. Synthetic fixtures, no commercial transport.
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,chmod} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {userInfo} from 'node:os';
const {default:pg}=await import(process.env.PADBOL_PG_MODULE);
const dir=await mkdtemp('/tmp/crm-long-pg-');await chmod(dir,0o700);
const bin=process.env.PADBOL_PG_BIN||'/opt/homebrew/opt/postgresql@17/bin';
let running=false,a,b,checks=0;
const email='11111111-1111-4111-8111-111111111111',actor='33333333-3333-4333-8333-333333333333',reply='55555555-5555-4555-8555-555555555555';
const read=p=>readFile(`sql/${p}`,'utf8');
const outcome=p=>p.then(value=>({value}),error=>({error}));
try{
 execFileSync(`${bin}/initdb`,['-D',`${dir}/data`,'--auth-local=trust','--auth-host=reject','--no-locale','--encoding=UTF8'],{stdio:'pipe'});
 execFileSync(`${bin}/pg_ctl`,['-D',`${dir}/data`,'-l',`${dir}/postgres.log`,'-o',`-F -h '' -k ${dir} -p 5432`,'-w','start'],{stdio:'pipe'});running=true;
 const config={host:dir,port:5432,user:userInfo().username,database:'postgres'};
 a=new pg.Client(config);b=new pg.Client(config);await a.connect();await b.connect();
 await a.query(await read('tests/crmLongEmailFixture.sql'));await a.query(await read('candidates/crm_long_email_original_function.sql'));
 await a.query('revoke all on function crm_commercial_team_form_claim_reply(uuid,boolean,uuid,uuid,text) from public;grant execute on function crm_commercial_team_form_claim_reply(uuid,boolean,uuid,uuid,text) to service_role');
 await a.query("insert into crm_conversations select gen_random_uuid(),'email' from generate_series(1,98)");
 await a.query("insert into crm_replies(conversation_id,body,status) select $1,repeat('x',300),'sent' from generate_series(1,56)",[email]);
 await a.query('create index fixture_reply_conversation_idx on crm_replies(conversation_id)');
 const fkQuery="select conname,conrelid::regclass::text as relation,pg_get_constraintdef(oid) as definition from pg_constraint where contype='f' and confrelid='crm_replies'::regclass order by conname";
 const originalFks=(await a.query(fkQuery)).rows;assert.equal(originalFks.length,6);
 await a.query('grant select,insert on crm_replies,crm_conversations to service_role;alter role service_role bypassrls;alter table crm_replies enable row level security;alter table crm_conversations enable row level security');
 const securityQuery="select relname,relacl::text as acl,relrowsecurity,relforcerowsecurity from pg_class where oid in ('crm_replies'::regclass,'crm_conversations'::regclass) order by relname";
 const originalSecurity=(await a.query(securityQuery)).rows;
 const before=(await a.query('select id,body,status from crm_replies order by id')).rows;
 // Existing reader: fail immediately rather than queue a DDL upgrade.
 await a.query('begin');await a.query('select count(*) from crm_replies');
 const blockedStart=performance.now();const blocked=await outcome(b.query(await read('candidates/crm_long_email_up.sql')));assert.equal(blocked.error.code,'55P03');await b.query('rollback');await a.query('commit');
 assert.equal((await a.query("select count(*)::int as n from pg_attribute where attrelid='crm_replies'::regclass and attname='long_email_channel' and not attisdropped")).rows[0].n,0);
 console.log(JSON.stringify({nowait_abort_ms:Math.round((performance.now()-blockedStart)*100)/100,atomic_no_schema_change:true,fixture_replies:57,fixture_conversations:100,dependent_fk_tables:6}));checks++;

 const beforeNode=(await a.query("select pg_relation_filenode('crm_replies') as node")).rows[0].node;
 const start=performance.now();
 await a.query(await read('candidates/crm_long_email_up.sql'));
 const ddlMs=performance.now()-start;
 assert.equal((await a.query("select pg_relation_filenode('crm_replies') as node")).rows[0].node,beforeNode);
 console.log(JSON.stringify({candidate:'nullable marker plus CHECK and native FK',heap_rewrite:false,ddl_ms:Math.round(ddlMs*100)/100}));
 assert.deepEqual((await a.query(fkQuery)).rows,originalFks);assert.deepEqual((await a.query(securityQuery)).rows,originalSecurity);checks++;
 assert.equal((await a.query("select has_function_privilege('service_role','crm_reply_long_email_marker()','execute') as allowed")).rows[0].allowed,false);
 await a.query('set role service_role');await a.query('insert into crm_replies(conversation_id,body,long_email_channel)values($1,$2,NULL)',[email,'😀'.repeat(5000)]);await a.query('reset role');checks++;
 for(const isolation of ['READ COMMITTED','REPEATABLE READ','SERIALIZABLE'])for(const order of ['reply-first','channel-first']){
  await a.query('delete from crm_commercial_form_send_attempts;delete from crm_replies');await a.query("update crm_conversations set source_channel='email' where id=$1",[email]);
  await a.query(`begin isolation level ${isolation}`);await b.query(`begin isolation level ${isolation}`);
  await a.query('select count(*) from crm_replies');await b.query('select count(*) from crm_replies');
  let pending;
  if(order==='reply-first'){
   await a.query('insert into crm_replies(id,conversation_id,body)values($1,$2,$3)',[reply,email,'😀'.repeat(8000)]);
   pending=outcome(b.query("update crm_conversations set source_channel='whatsapp' where id=$1",[email]));
  }else{
   await a.query("update crm_conversations set source_channel='whatsapp' where id=$1",[email]);
   pending=outcome(b.query('insert into crm_replies(id,conversation_id,body)values($1,$2,$3)',[reply,email,'😀'.repeat(8000)]));
  }
  await new Promise(r=>setTimeout(r,100));await a.query('commit');const result=await pending;
  assert.ok(result.error);assert.ok(['23503','40001'].includes(result.error.code),result.error.code);await b.query('rollback');
  assert.equal((await a.query("select count(*)::int as n from crm_replies r join crm_conversations c on c.id=r.conversation_id where length(btrim(r.body))>4096 and c.source_channel<>'email'")).rows[0].n,0);checks++;
 }
 // Same-ID concurrent commercial claims serialize and reserve one attempt.
 await a.query('delete from crm_replies');await a.query("update crm_conversations set source_channel='email' where id=$1",[email]);
 await a.query('begin');const args=[actor,email,reply,'Long email '+ '😀'.repeat(6000)];
 const first=(await a.query('select crm_commercial_team_form_claim_reply($1,false,$2,$3,$4) as result',args)).rows[0].result;assert.equal(first.created,true);
 const replay=outcome(b.query('select crm_commercial_team_form_claim_reply($1,false,$2,$3,$4) as result',args));await new Promise(r=>setTimeout(r,100));await a.query('commit');const replayResult=await replay;assert.equal(replayResult.error,undefined);assert.equal(replayResult.value.rows[0].result.created,false);assert.equal((await a.query('select count(*)::int as n from crm_commercial_form_send_attempts')).rows[0].n,1);checks++;
 // Application recovery keeps expanded storage and every existing long character.
 const preserved=(await a.query('select id,body,status from crm_replies')).rows;
 await assert.rejects(a.query(await read('candidates/crm_long_email_down.sql')),/strict rollback blocked/);await a.query('rollback');assert.deepEqual((await a.query('select id,body,status from crm_replies')).rows,preserved);checks++;
 await a.query('delete from crm_commercial_form_send_attempts;delete from crm_replies');for(const row of before)await a.query('insert into crm_replies(id,conversation_id,body,status)values($1,$2,$3,$4)',[row.id,email,row.body,row.status]);
 await a.query(await read('candidates/crm_long_email_down.sql'));assert.deepEqual((await a.query('select id,body,status from crm_replies order by id')).rows,before);checks++;
 assert.deepEqual((await a.query(fkQuery)).rows,originalFks);assert.deepEqual((await a.query(securityQuery)).rows,originalSecurity);checks++;
 assert.equal((await a.query("select to_regprocedure('crm_reply_long_email_marker()') is null as cleaned")).rows[0].cleaned,true);
 assert.equal((await a.query("select count(*)::int as n from pg_trigger where tgrelid='crm_replies'::regclass and tgname='crm_reply_long_email_marker'")).rows[0].n,0);checks++;
 // Hard transaction timeout must abort even if the client does not issue ROLLBACK.
 const timeoutClient=new pg.Client(config);timeoutClient.on('error',()=>{});await timeoutClient.connect();
 await timeoutClient.query('begin');await timeoutClient.query("set local transaction_timeout='100ms'");await timeoutClient.query('create table timeout_must_rollback(id int)');
 const timed=await outcome(timeoutClient.query('select pg_sleep(1)'));assert.ok(timed.error);await timeoutClient.end().catch(()=>{});
 assert.equal((await a.query("select to_regclass('timeout_must_rollback') is null as rolled_back")).rows[0].rolled_back,true);checks++;
 console.log(JSON.stringify({transaction_timeout_aborted_and_rolled_back:true,timeout_code:timed.error.code,service_role_trigger_with_execute_revoked:true,rollback_trigger_function_cleaned:true,six_original_foreign_keys_preserved:true,table_acl_and_rls_preserved:true}));
 console.log(JSON.stringify({postgres:(await a.query('show server_version')).rows[0].server_version,checks,isolations:3,interleavings:6,concurrent_claim_replay:true,history_preserved:true,tcp_listening:false,external_sends:0}));
}finally{if(a)await a.end().catch(()=>{});if(b)await b.end().catch(()=>{});if(running)execFileSync(`${bin}/pg_ctl`,['-D',`${dir}/data`,'-m','immediate','-w','stop'],{stdio:'pipe'});await rm(dir,{recursive:true,force:true});}
