// Synthetic integration only: disposable PostgreSQL + PostgREST + localhost HTTP.
import {pathToFileURL, fileURLToPath} from 'node:url';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:net';
import {spawn} from 'node:child_process';
import {createHmac} from 'node:crypto';
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
import express from 'express';
import {createClient} from '@supabase/supabase-js';
import {createCrmService,createSupabaseCrmRepository} from '../../lib/crmService.js';
import {attemptIdFor} from '../../lib/crmContact.js';
import {createSupabaseWhatsappRepository,createWhatsappCloudService} from '../../lib/whatsappCloud.js';
import {createWhatsappMenuAtomicStore} from '../../lib/whatsappProductionMenuStoreCandidate.js';
import {createProductionMenuCandidate} from '../../lib/whatsappProductionMenuCandidate.js';
import {createProductionMenuIngressCandidate} from '../../lib/whatsappProductionMenuIngressCandidate.js';
import {createProductionHumanGateCandidate} from '../../lib/whatsappProductionHumanGateCandidate.js';
import {createWhatsappProductionRecoveryCandidate} from '../../lib/whatsappProductionRecoveryCandidate.js';
import {createQaRelay,registerQaRelayReceiver} from '../../lib/whatsappQaRelay.js';
const {Pool}=createRequire(import.meta.url)('pg');
if (!process.env.PADBOL_EMBEDDED_POSTGRES_MODULE) throw Error('isolated PostgreSQL module required');
const {default:EmbeddedPostgres}=await import(pathToFileURL(process.env.PADBOL_EMBEDDED_POSTGRES_MODULE));
async function freePort(){const s=createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return p}
const pgPort=await freePort(),restPort=await freePort(),httpPort=await freePort();
const dir=await mkdtemp(join(tmpdir(),'padbol-relay-full-'));
const pg=new EmbeddedPostgres({databaseDir:join(dir,'data'),user:'postgres',password:'fixture-only',port:pgPort,persistent:true,postgresFlags:['-h','127.0.0.1'],onLog:()=>{},onError:()=>{}});
let dbStarted=false,rest,server,pool,client;
try {
 await pg.initialise();await pg.start();dbStarted=true;client=pg.getPgClient();await client.connect();
 await client.query(`create role anon;create role authenticated;create role service_role bypassrls;create table public.organizaciones(id uuid primary key);create table public.sedes(id bigint primary key);`);
 for(const f of ['20260909173000_whatsapp_cloud_core.sql','20260915000000_crm_unified_inbox.sql','20260916000000_crm_inbound_content.sql','20260917000000_crm_operational_history_and_inbound_events.sql','20261021010000_whatsapp_media_reference.sql','migrations/20261022200000_crm_short_ticket_number.sql','20261022170000_crm_test_visibility.sql']) await client.query(await readFile('sql/'+f,'utf8'));
 await client.query(`alter table crm_conversations add column sede_id bigint,add column assigned_by uuid;create table crm_whatsapp_manual_attempts(conversation_id uuid);grant all on crm_whatsapp_manual_attempts to service_role;`);
 await client.query(await readFile('sql/candidates/whatsapp_prod_menu_atomic_candidate.sql','utf8'));
 const tenant='11111111-1111-4111-8111-111111111111',channel='22222222-2222-4222-8222-222222222222',org='33333333-3333-4333-8333-333333333333';
 await client.query('insert into organizaciones values($1)',[org]);
 await client.query("insert into whatsapp_tenants(id,organization_id,display_name,status) values($1,$2,'Synthetic','active')",[tenant,org]);
 await client.query("insert into whatsapp_tenant_channels(id,tenant_id,meta_phone_number_id,meta_waba_id,credential_ref,active) values($1,$2,'1376102838911694','928900479733370','TEST',true)",[channel,tenant]);
 rest=spawn('postgrest',[],{env:{...process.env,PGRST_DB_URI:`postgres://postgres:fixture-only@127.0.0.1:${pgPort}/postgres`,PGRST_DB_SCHEMAS:'public',PGRST_DB_ANON_ROLE:'service_role',PGRST_SERVER_HOST:'127.0.0.1',PGRST_SERVER_PORT:String(restPort)},stdio:'pipe'});
 let restLog='';rest.stderr.on('data',x=>restLog+=x.toString());let ready=false;for(let i=0;i<100;i++){try{const r=await fetch(`http://127.0.0.1:${restPort}/`);if(r.ok){ready=true;break}}catch{}await new Promise(r=>setTimeout(r,50));}if(!ready)throw Error('PostgREST not ready: '+restLog);
 const supabase=createClient(`http://127.0.0.1:${restPort}`,'fixture-only',{auth:{persistSession:false,autoRefreshToken:false},global:{fetch:async(url,options)=>{const headers=new Headers(options.headers);headers.delete('authorization');const response=await fetch(String(url).replace('/rest/v1/','/'),{...options,headers});if(!response.ok)console.error('fixture PostgREST error',response.status,await response.clone().text());return response}}});
 const crm=createCrmService({repository:createSupabaseCrmRepository(supabase),whatsappAtomicConversationEnabled:true});
 // Two distinct messages arrive concurrently for the same new identity.
 const common={source:'whatsapp_cloud',channel:'whatsapp',phone:'15559990000',identityUsed:'15559990000',origin:'whatsapp:1376102838911694',body:'synthetic concurrent message'};
 const concurrent=await Promise.all([crm.ingestInbound({...common,sourceId:'wamid.concurrent.1'}),crm.ingestInbound({...common,sourceId:'wamid.concurrent.2'})]);
 assert.equal(concurrent[0].conversation.id,concurrent[1].conversation.id);
 const count=(await client.query("select count(*)::int n from crm_inbound_events where source_ref in ('wamid.concurrent.1','wamid.concurrent.2')")).rows[0].n;assert.equal(count,2);
 const other=await crm.ingestInbound({...common,origin:'whatsapp:other',sourceId:'wamid.other.origin'});assert.notEqual(other.conversation.id,concurrent[0].conversation.id);
 const before=(await client.query('select received_at,inbound_body from crm_conversations where id=$1',[concurrent[0].conversation.id])).rows[0];
 await crm.ingestInbound({...common,sourceId:'wamid.late',body:'old text',receivedAt:new Date(before.received_at.getTime()-60000).toISOString()});
 await crm.ingestInbound({...common,sourceId:'wamid.tie',body:'same time text',receivedAt:before.received_at.toISOString()});
 const after=(await client.query('select received_at,inbound_body from crm_conversations where id=$1',[concurrent[0].conversation.id])).rows[0];
 assert.equal(after.inbound_body,before.inbound_body);assert.equal(after.received_at.getTime(),before.received_at.getTime());
 // Legacy partial receipt must preserve original data and fail closed if the
 // operator closes its conversation before the missing event is stored.
 const legacyId='wamid.legacy.partial',legacyAttempt=attemptIdFor({source:'whatsapp_cloud',sourceId:legacyId}),legacyOrigin='whatsapp:legacy';
 const contactId=concurrent[0].contact.id;
 // Legacy writer wins the lock: a new writer waits and joins that thread.
 const mixedOrigin='whatsapp:mixed-legacy-first';
 await client.query('begin');
 const mixed=(await client.query("insert into crm_conversations(contact_id,source_channel,source_ref,attempt_id,identity_used,origin,inbound_body,qualification_data,received_at,estado) values($1,'whatsapp','legacy-source','legacy-attempt',$2,$3,'legacy','{}',now(),'nuevo') returning id",[contactId,common.phone,mixedOrigin])).rows[0].id;
 let mixedDone=false;const mixedArrival=crm.ingestInbound({...common,origin:mixedOrigin,sourceId:'wamid.mixed'}).then(x=>{mixedDone=true;return x});
 await new Promise(r=>setTimeout(r,300));assert.equal(mixedDone,false);await client.query('commit');assert.equal((await mixedArrival).conversation.id,mixed);
 // A legacy insert racing after an open thread exists is rejected rather than
 // creating a second thread. The transport must still retry the failed webhook.
 await assert.rejects(client.query("insert into crm_conversations(contact_id,source_channel,source_ref,attempt_id,identity_used,origin,inbound_body,qualification_data,received_at,estado) values($1,'whatsapp','legacy-loser','legacy-attempt-loser',$2,$3,'legacy','{}',now(),'nuevo')",[contactId,common.phone,mixedOrigin]),/open WhatsApp conversation already exists/);
 const closed=(await client.query("insert into crm_conversations(contact_id,source_channel,source_ref,attempt_id,identity_used,origin,qualification_data,received_at,estado) values($1,'whatsapp','closed-test','closed-attempt',$2,$3,'{}',now(),'cerrado') returning id",[contactId,common.phone,mixedOrigin])).rows[0].id;
 await assert.rejects(client.query("update crm_conversations set estado='nuevo' where id=$1",[closed]),/open WhatsApp conversation already exists/);
 await assert.rejects(client.query('update crm_conversations set origin=$1 where id=$2',[mixedOrigin,other.conversation.id]),/open WhatsApp conversation already exists/);
 // The ingestion lock uses NOWAIT to avoid deadlocking an operator's update.
 const deadlockOrigin='whatsapp:deadlock-test';
 const deadlockId=(await client.query("insert into crm_conversations(contact_id,source_channel,source_ref,attempt_id,identity_used,origin,qualification_data,received_at,estado) values($1,'whatsapp','deadlock-source','deadlock-attempt',$2,$3,'{}',now(),'cerrado') returning id",[contactId,common.phone,deadlockOrigin])).rows[0].id;
 const second=pg.getPgClient();await second.connect();
 try {
   await client.query('begin');await second.query('begin');await client.query('select id from crm_contacts where id=$1 for update',[contactId]);
   const reopen=second.query("update crm_conversations set estado='nuevo' where id=$1",[deadlockId]);
   await new Promise(r=>setTimeout(r,150));
   await assert.rejects(client.query('select id from crm_conversations where id=$1 for update nowait',[deadlockId]),error=>error.code==='55P03');
   await client.query('rollback');await reopen;
 } finally {await client.query('rollback');await second.query('rollback');await second.end();}
 // Actual old service observes no thread, then the new service creates one.
 // Old insert is rejected by the shared guard and its retry joins that thread.
 const legacyRepo=createSupabaseCrmRepository(supabase),originalFind=legacyRepo.findOpenConversation.bind(legacyRepo);
 let observed,releaseFind;const observedRead=new Promise(r=>observed=r),allowLegacy=new Promise(r=>releaseFind=r);let pause=true;
 legacyRepo.findOpenConversation=async(...args)=>{const row=await originalFind(...args);if(pause){pause=false;observed();await allowLegacy;}return row};
 const legacyCrm=createCrmService({repository:legacyRepo}),raceOrigin='whatsapp:mixed-new-first';
 const oldMessage=legacyCrm.ingestInbound({...common,origin:raceOrigin,sourceId:'wamid.old.race'});
 await observedRead;const newMessage=await crm.ingestInbound({...common,origin:raceOrigin,sourceId:'wamid.new.race'});releaseFind();
 await assert.rejects(oldMessage);const retried=await legacyCrm.ingestInbound({...common,origin:raceOrigin,sourceId:'wamid.old.race'});
 assert.equal(retried.conversation.id,newMessage.conversation.id);
 assert.equal((await client.query("select count(*)::int n from crm_inbound_events where source_ref in ('wamid.old.race','wamid.new.race')")).rows[0].n,2);
 await client.query("insert into crm_channel_attempts(attempt_id,contact_id,channel) values($1,$2,'whatsapp')",[legacyAttempt,contactId]);
 const legacy=(await client.query("insert into crm_conversations(contact_id,source_channel,source_ref,attempt_id,identity_used,origin,inbound_body,qualification_data,received_at,estado) values($1,'whatsapp',$2,$3,$4,$5,'original legacy','{}',now(),'nuevo') returning id",[contactId,legacyId,legacyAttempt,common.phone,legacyOrigin])).rows[0].id;
 await client.query('begin');await client.query("update crm_conversations set estado='cerrado' where id=$1",[legacy]);
 const legacyArrival=assert.rejects(crm.ingestInbound({...common,origin:legacyOrigin,sourceId:legacyId,body:'replacement'}),/No se pudo asegurar el hilo entrante/);
 await legacyArrival;await client.query('commit');
 const recoveredLegacy=await crm.ingestInbound({...common,origin:legacyOrigin,sourceId:legacyId,body:'replacement'});
 assert.notEqual(recoveredLegacy.conversation.id,legacy);
 const legacyEvent=(await client.query('select body,conversation_id from crm_inbound_events where source_ref=$1',[legacyId])).rows[0];
 assert.equal(legacyEvent.body,'original legacy');assert.equal(legacyEvent.conversation_id,recoveredLegacy.conversation.id);
 assert.equal((await client.query('select estado from crm_conversations where id=$1',[legacy])).rows[0].estado,'cerrado');
 assert.equal(recoveredLegacy.conversation.qualification_data.legacy_recovery.conversation_id,legacy);
 assert.equal((await crm.ingestInbound({...common,origin:legacyOrigin,sourceId:legacyId})).conversation.id,recoveredLegacy.conversation.id);
 // An operator closes the active thread while a new inbound is arriving.
 // The inbound must wait and create a new open thread after the close commits.
 await client.query('begin');
 await client.query("update crm_conversations set estado='cerrado' where id=$1",[concurrent[0].conversation.id]);
 const arrival=assert.rejects(crm.ingestInbound({...common,sourceId:'wamid.after.close'}),/No se pudo asegurar el hilo entrante/);
 await arrival;
 await client.query('commit');
 const afterClose=await crm.ingestInbound({...common,sourceId:'wamid.after.close'});assert.notEqual(afterClose.conversation.id,concurrent[0].conversation.id);
 assert.equal((await client.query("select c.estado from crm_inbound_events e join crm_conversations c on c.id=e.conversation_id where e.source_ref='wamid.after.close'")).rows[0].estado,'nuevo');
 const menu=createProductionMenuCandidate({enabled:true,env:{BACKEND_RUNTIME_MODE:'production'},crmService:crm,atomicMenuStore:createWhatsappMenuAtomicStore(supabase)});
 pool=new Pool({host:'127.0.0.1',port:pgPort,user:'postgres',password:'fixture-only',database:'postgres',max:8});
 await client.query("insert into whatsapp_inbound_messages(tenant_id,channel_id,provider_message_id,from_wa_id,message_type,text_body,received_at,created_at) values($1,$2,'wamid.recovery.text','15551234567','text','recover safely',now()-interval '2 minutes',now()-interval '2 minutes'),($1,$2,'wamid.recovery.audio','15551234567','text','[WhatsApp: audio no admitido.]',now()-interval '2 minutes',now()-interval '2 minutes'),($1,$2,'wamid.recovery.new','15551234567','text','in flight',now(),now())",[tenant,channel]);
 const recovered=[];const recovery=createWhatsappProductionRecoveryCandidate({pool,channelId:channel,cutoff:new Date(Date.now()-600000).toISOString(),ingress:async item=>recovered.push(item.inbound.providerMessageId)});
 assert.deepEqual(await recovery.run(),{examined:1,completed:1,failed:0});assert.deepEqual(recovered,['wamid.recovery.text']);
 let sends=0,finishProvider,providerEntered;const providerWait=new Promise(r=>finishProvider=r),started=new Promise(r=>providerEntered=r);
 const gate=createProductionHumanGateCandidate({pool,channelId:channel,enabled:true,sender:{async sendText(){sends++;providerEntered();await providerWait;return{providerMessageId:'wamid.synthetic.sent'}}}});
 const ingress=createProductionMenuIngressCandidate({menu,dispatcher:gate,phoneNumberId:'1376102838911694',wabaId:'928900479733370'});
 const whatsappService=createWhatsappCloudService({repository:createSupabaseWhatsappRepository(supabase),automaticOutboxEnabled:false,sendEnabled:false,onInbound:ingress});
 const secret='fixture-relay-secret';const prod={WHATSAPP_QA_RELAY_RECEIVE_ENABLED:'true',BACKEND_RUNTIME_MODE:'production',RENDER_SERVICE_ID:'srv-d7brh3ea2pns73equ2ug',SUPABASE_URL:'https://auth.padbolmatch.com',WHATSAPP_META_APP_SECRET:secret};
 const app=express();app.use(express.raw({type:'application/json',verify:(req,_res,buf)=>{req.rawBody=buf}}));registerQaRelayReceiver(app,{env:prod,whatsappService:{async handleWebhook(p){try{return await whatsappService.handleWebhook(p)}catch(e){console.error('synthetic receiver failure',e);throw e}}},logger:{warn(){}}});server=await new Promise(r=>{const s=app.listen(httpPort,'127.0.0.1',()=>r(s))});
 const qa={WHATSAPP_QA_RELAY_ENABLED:'true',BACKEND_RUNTIME_MODE:'staging',RENDER_SERVICE_ID:'srv-dahbs0dbedkc73a0kf4g',STAGING_SUPABASE_PROJECT_REF:'vxikhdulhuvghfqeutnp',SUPABASE_URL:'https://vxikhdulhuvghfqeutnp.supabase.co',WHATSAPP_META_QA_RESUBSCRIBE_ONCE:'false',WHATSAPP_META_APP_SECRET:secret};
 const relay=createQaRelay({env:qa,timeoutMs:600,fetchImpl:async(_url,options)=>{const res=await fetch(`http://127.0.0.1:${httpPort}/api/webhooks/whatsapp-qa-relay`,options);return{ok:res.ok,redirected:res.redirected}}});
 const rawBody=Buffer.from(JSON.stringify({object:'whatsapp_business_account',entry:[{id:'928900479733370',changes:[{field:'messages',value:{metadata:{phone_number_id:'1376102838911694'},messages:[{id:'wamid.integration',from:'15551234567',timestamp:String(Math.floor(Date.now()/1000)),type:'text',text:{body:'Hola, quiero abrir una cancha'}}]}}]}]}));
 const signature='sha256='+createHmac('sha256',secret).update(rawBody).digest('hex');
 const timedOut=assert.rejects(relay({rawBody,signature}),/relay unavailable/);
 await Promise.race([started,new Promise((_,reject)=>setTimeout(()=>reject(Error('provider not reached')),4000))]);await timedOut;assert.equal(sends,1);
 const replay=relay({rawBody,signature});await new Promise(r=>setTimeout(r,30));finishProvider();await replay;
 const state=await client.query(`select c.inbound_body,c.qualification_data,o.status,r.status reply_status from crm_conversations c join crm_whatsapp_menu_events e on e.conversation_id=c.id join whatsapp_outbox o on o.id=e.outbox_id join crm_replies r on r.id=e.reply_id`);
 assert.equal(state.rows.length,1);assert.equal(state.rows[0].inbound_body,'Hola, quiero abrir una cancha');assert.match(JSON.stringify(state.rows[0].qualification_data),/quiero abrir una cancha/);assert.equal(state.rows[0].status,'sent');assert.equal(state.rows[0].reply_status,'sent');assert.equal(sends,1);
 await client.query("insert into whatsapp_inbound_messages(tenant_id,channel_id,provider_message_id,from_wa_id,message_type,text_body,received_at,created_at) values($1,$2,'wamid.recovery.fresh','15550000002','text','fresh recovery',now()-interval '2 minutes',now()-interval '2 minutes')",[tenant,channel]);
 const realRecovery=createWhatsappProductionRecoveryCandidate({pool,channelId:channel,cutoff:new Date(Date.now()-600000).toISOString(),ingress});
 const firstRecovery=await realRecovery.run();assert.equal(firstRecovery.completed,2);assert.equal(sends,2);
 assert.equal((await realRecovery.run()).examined,0);assert.equal((await realRecovery.run()).examined,0);assert.equal(sends,2);
 assert.equal((await client.query("select count(*)::int n from crm_inbound_events where source_ref='wamid.recovery.text'")).rows[0].n,1);
 assert.equal((await client.query("select count(*)::int n from crm_whatsapp_menu_events e join whatsapp_inbound_messages m on m.id=e.inbound_message_id where m.provider_message_id='wamid.recovery.fresh'")).rows[0].n,1);
 console.log('Integrated localhost relay + real Supabase repositories + PostgreSQL + simulated Meta: preserved original and no duplicate after relay timeout.');
} finally {if(server)await new Promise(r=>server.close(r));if(pool)await pool.end();if(rest){rest.kill();await new Promise(r=>rest.once('exit',r))}if(client)await client.end();if(dbStarted)await pg.stop();await rm(dir,{recursive:true,force:true})}
