import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {createProductionHumanGateCandidate} from '../../lib/whatsappProductionHumanGateCandidate.js';
import {createSupportWhatsappDispatcherCandidate,createSupportWhatsappTransport} from '../../lib/supportWhatsappDispatcherCandidate.js';
const {PGlite}=await import(pathToFileURL(process.env.PADBOL_PGLITE_MODULE).href);
let pgPool;let admin;let database;
let db=new PGlite();
if(process.env.SUPPORT_TEST_PG_SOCKET){
 if(!process.env.SUPPORT_TEST_PG_SOCKET.startsWith('/'))throw Error('LOCAL_UNIX_SOCKET_REQUIRED');
 await db.close();const {default:pg}=await import(pathToFileURL(process.env.PADBOL_PG_MODULE).href);
 const config={host:process.env.SUPPORT_TEST_PG_SOCKET,port:Number(process.env.SUPPORT_TEST_PG_PORT||55447),user:'padbol_support_test'};
 admin=new pg.Pool({...config,database:'postgres'});database='support_dispatch_'+process.pid;
 await admin.query('create database '+database);pgPool=new pg.Pool({...config,database,max:6});
 db={query:(...a)=>pgPool.query(...a),exec:q=>pgPool.query(q),async close(){await pgPool.end();await admin.query('drop database '+database);await admin.end()}};
}
globalThis.fetch=()=>{throw Error('NETWORK_FORBIDDEN')};
const u=n=>`80000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
let calls=0;const checks=[];
try{
 await db.exec(`do $$begin create role anon;exception when duplicate_object then null;end$$;do $$begin create role authenticated;exception when duplicate_object then null;end$$;do $$begin create role service_role;exception when duplicate_object then null;end$$;
 create table crm_conversations(id uuid primary key,source_channel text,origin text,identity_used text,estado text default 'nuevo',operador text,sede_id bigint,assigned_by uuid,derivado boolean default false,handoff_ready boolean default false,test_visibility_version bigint default 1,qualification_data jsonb default '{}');
 create table crm_inbound_events(id uuid primary key,conversation_id uuid,source_channel text,origin text,received_at timestamptz default now(),created_at timestamptz default now());
 create table crm_support_cases(id bigint primary key,conversation_id uuid,source_event_id uuid,source_channel text,lifecycle_state text,public_reference text,lifecycle_data jsonb,tenant_id uuid,channel_id uuid);
 create table crm_support_lifecycle_actions(id bigint primary key,case_id bigint,action text,actor_id uuid,payload jsonb);
 create table crm_support_lifecycle_effects(id bigint primary key,case_id bigint,action_id bigint,effect_type text,disposition text,payload jsonb,effect_key text);
 create table crm_support_event_context(event_id uuid,conversation_id uuid,confirmed boolean,effective_topic text,tenant_id uuid,channel_id uuid,origin text,menu_revision bigint,menu_inbound_id uuid,source_ref text);
 create table crm_replies(id uuid primary key,conversation_id uuid,body text,operador text,status text,provider_message_id text);
 create table crm_whatsapp_manual_attempts(reply_id uuid,conversation_id uuid);
 create table crm_whatsapp_automation_releases(conversation_id uuid);
 create table whatsapp_outbox(id uuid primary key,status text,last_error text,attempts integer default 0,last_attempt_at timestamptz,updated_at timestamptz);
 create table crm_whatsapp_menu_events(conversation_id uuid,inbound_message_id uuid,outbox_id uuid);
 create table whatsapp_inbound_messages(id uuid,tenant_id uuid,channel_id uuid,provider_message_id text,from_wa_id text,message_type text,meta_media_type text);
 create table whatsapp_tenants(id uuid primary key,status text,organization_id uuid);
 create table whatsapp_tenant_channels(id uuid primary key,tenant_id uuid,active boolean,meta_phone_number_id text,meta_waba_id text,credential_ref text);`);
 await db.exec(await readFile('sql/candidates/support_whatsapp_dispatcher.sql','utf8'));
 await db.exec(await readFile('sql/20261020000000_crm_whatsapp_manual_claim.sql','utf8'));
 await db.query("insert into whatsapp_tenants values($1,'active',$2)",[u(1),u(3)]);
 await db.query("insert into whatsapp_tenant_channels values($1,$2,true,'1376102838911694','928900479733370','synthetic-ref')",[u(2),u(1)]);
 await db.query("insert into crm_support_delivery_principals values($1,true,'support.whatsapp.send',$2,$3,'whatsapp:1376102838911694',$4,'1376102838911694','928900479733370','synthetic-ref')",[u(4),u(1),u(2),u(3)]);
 async function seed(n){
  const conv=u(n*10),event=u(n*10+1),inbound=u(n*10+2),out=u(n*10+3);
  await db.query("insert into crm_conversations(id,source_channel,origin,identity_used)values($1,'whatsapp','whatsapp:1376102838911694','5491111111111')",[conv]);
  await db.query("insert into crm_inbound_events(id,conversation_id,source_channel,origin)values($1,$2,'whatsapp','whatsapp:1376102838911694')",[event,conv]);
  await db.query("insert into crm_support_cases values($1,$2,$3,'whatsapp','response_draft_ready',$4,$5,$6,$7)",[n,conv,event,'PB-'+n,JSON.stringify({proposal_actor_id:u(6),proposal_request_id:'synthetic-proposal',proposal:{reply:'Synthetic reviewed response',verification:{status:'passed'}}}),u(1),u(2)]);
  await db.query("insert into crm_support_lifecycle_actions values($1,$1,'coordination_approve',$2,'{\"evidence_verified\":true,\"approved_proposal_request_id\":\"synthetic-proposal\"}')",[n,u(7)]);
  await db.query("insert into crm_support_lifecycle_effects values($1,$1,$1,'response_draft','draft_only',$2,'response:synthetic-proposal')",[n,JSON.stringify({body:'Synthetic reviewed response',conversation_id:conv,case_reference:'PB-'+n,channel:'whatsapp',send_enabled:false})]);
  await db.query("insert into crm_support_event_context values($1,$2,true,'soporte',$3,$4,'whatsapp:1376102838911694',1,$5,'synthetic-provider-in')",[event,conv,u(1),u(2),inbound]);
  await db.query("insert into whatsapp_inbound_messages values($1,$2,$3,'synthetic-provider-in','5491111111111','text',null)",[inbound,u(1),u(2)]);
  await db.query("insert into whatsapp_outbox(id,status,last_error) values($1,'sent',null)",[out]);await db.query('insert into crm_whatsapp_menu_events values($1,$2,$3)',[conv,inbound,out]);return{conv,event,out};
 }
 const pool=pgPool||{async connect(){return{query:(...a)=>db.query(...a),release(){}}}};
 let mode='success';const sender={async sendText(request){calls++;assert.equal(request.toWaId,'5491111111111');assert.equal(request.channel.id,u(2));if(mode==='throw')throw Error('ACK_LOST');if(mode==='empty')return{};return{providerMessageId:'synthetic-provider-'+calls}}};
 const dispatcher=createSupportWhatsappDispatcherCandidate({pool,sender,principalId:u(4),enabled:true});
 assert.equal(createSupportWhatsappDispatcherCandidate(),null);checks.push('disabled_default');
 await seed(10);assert.equal((await dispatcher.dispatch(10)).status,'sent');assert.equal((await dispatcher.dispatch(10)).sent,false);assert.equal(calls,1);checks.push('approved_final_sent_once_same_conversation_service_actor');
 assert.equal((await db.query('select count(*)::int n from crm_whatsapp_manual_attempts')).rows[0].n,0);
 const s=await seed(11);mode='throw';assert.equal((await dispatcher.dispatch(11)).status,'uncertain');assert.equal((await dispatcher.dispatch(11)).sent,false);assert.equal(calls,2);checks.push('unknown_ack_no_retry');
 await assert.rejects(db.query('select crm_claim_whatsapp_reply($1,$2,$3,$4)',[u(998),s.conv,'Synthetic manual','real-operator']),/SUPPORT_DELIVERY_RESERVED/);assert.equal((await db.query('select count(*)::int n from crm_replies where id=$1',[u(998)])).rows[0].n,0);
 await db.query("update whatsapp_outbox set status='pending' where id=$1",[s.out]);const existingGate=createProductionHumanGateCandidate({pool,sender:{sendText(){throw Error('MENU_TRANSPORT_FORBIDDEN')}},channelId:u(2),enabled:true});await assert.rejects(existingGate.dispatch(s.out),/SUPPORT_DELIVERY_RESERVED/);assert.equal((await db.query('select status from whatsapp_outbox where id=$1',[s.out])).rows[0].status,'pending');checks.push('uncertain_support_blocks_exact_manual_RPC_and_existing_menu_gate_claim_rollback');
 const m=await seed(12);await db.query('select crm_claim_whatsapp_reply($1,$2,$3,$4)',[u(999),m.conv,'Synthetic manual first','real-operator']);await assert.rejects(dispatcher.dispatch(12),/SUPPORT_COMPETING_DELIVERY/);checks.push('manual_reservation_blocks_support');
 const menu=await seed(13);await db.query("update whatsapp_outbox set status='sending' where id=$1",[menu.out]);await assert.rejects(dispatcher.dispatch(13),/SUPPORT_COMPETING_DELIVERY/);checks.push('menu_reservation_blocks_support');
 const stale=await seed(14);await db.query("update crm_inbound_events set received_at=now()-interval '25 hours' where id=$1",[stale.event]);await assert.rejects(dispatcher.dispatch(14),/SUPPORT_DELIVERY_WINDOW_OR_EVENT_STALE/);checks.push('window_24h');
 await seed(15);await db.query("update crm_support_event_context set effective_topic='sede' where conversation_id=$1",[u(150)]);await assert.rejects(dispatcher.dispatch(15),/SUPPORT_DELIVERY_SCOPE_STALE/);checks.push('commercial_followup_not_support');
 await seed(16);await db.query("update crm_support_delivery_principals set active=false where id=$1",[u(4)]);await assert.rejects(dispatcher.dispatch(16),/SUPPORT_DELIVERY_PRINCIPAL_DENIED/);await db.query('update crm_support_delivery_principals set active=true');checks.push('principal_fail_closed');
 await seed(17);await db.query("update crm_support_cases set lifecycle_data=jsonb_set(lifecycle_data,'{proposal,verification,status}','\"not_run\"')where id=17");await assert.rejects(dispatcher.dispatch(17),/SUPPORT_APPROVED_RESPONSE_REQUIRED/);checks.push('unverified_proposal_denied');
 await seed(18);mode='empty';assert.equal((await dispatcher.dispatch(18)).status,'uncertain');assert.equal((await dispatcher.dispatch(18)).sent,false);assert.equal(calls,3);checks.push('empty_provider_receipt_no_retry');
 let httpCalls=0;const transport=createSupportWhatsappTransport({graphVersion:'v23.0',resolveAccessToken:async()=> 'synthetic-token',fetchImpl:async(url,options)=>{httpCalls++;assert.equal(options.redirect,'error');assert.equal(url,'https://graph.facebook.com/v23.0/1376102838911694/messages');return{ok:true,json:async()=>({messages:[{id:'synthetic-http-receipt'}]})}}});
 assert.equal((await transport.sendText({channel:{meta_phone_number_id:'1376102838911694'},toWaId:'5491111111111',body:'Synthetic'})).providerMessageId,'synthetic-http-receipt');assert.equal(httpCalls,1);checks.push('existing_meta_primitive_no_redirect_mock');
 if(pgPool){
  const hold=await seed(20);let releaseSend,started;const startedPromise=new Promise(r=>started=r);const heldSender={async sendText(){started();await new Promise(r=>releaseSend=r);return{providerMessageId:'synthetic-held'}}};
  const held=createSupportWhatsappDispatcherCandidate({pool,sender:heldSender,principalId:u(4),enabled:true});const sending=held.dispatch(20);await startedPromise;
  let manualDone=false;const manual=db.query('select crm_claim_whatsapp_reply($1,$2,$3,$4)',[u(997),hold.conv,'Synthetic after support','real-operator']).then(r=>{manualDone=true;return r});
  await new Promise(r=>setTimeout(r,80));assert.equal(manualDone,false);releaseSend();assert.equal((await sending).status,'sent');await manual;assert.equal(manualDone,true);checks.push('real_PostgreSQL_manual_waits_for_support_HTTP_transaction_lock');
  const reserved=await seed(21);await db.query('select crm_support_prepare_whatsapp_delivery($1,$2)',[21,u(4)]);await assert.rejects(db.query('select crm_claim_whatsapp_reply($1,$2,$3,$4)',[u(996),reserved.conv,'Synthetic while claimed','real-operator']),/SUPPORT_DELIVERY_RESERVED/);checks.push('durable_claim_before_HTTP_blocks_manual_RPC');
  await seed(19);mode='success';const before=calls;const concurrent=await Promise.all([dispatcher.dispatch(19),dispatcher.dispatch(19)]);assert.equal(concurrent.filter(r=>r.sent).length,1);assert.equal(calls,before+1);checks.push('real_PostgreSQL_two_connection_same_effect_exactly_one_mock_send');}
 await seed(22);await db.query("insert into crm_support_lifecycle_effects values(999,22,22,'technical_delegation','draft_only','{}','technical-only')");mode='success';const swept=await dispatcher.sweep(999);assert.ok(swept.selected<=20);assert.equal(swept.sent,2);assert.equal((await db.query('select count(*)::int n from crm_support_delivery_journal where effect_id=999')).rows[0].n,0);checks.push('sweep_only_response_draft_scope_bound_no_technical_delivery');
 const grant=(await db.query("select has_function_privilege('authenticated','crm_support_prepare_whatsapp_delivery(bigint,uuid)','EXECUTE') a")).rows[0];assert.equal(grant.a,false);checks.push('client_cannot_claim');
 console.log(JSON.stringify({ok:true,checksPassed:checks.length,checks,mockTransportCalls:calls,networkCalls:0,realMessages:0,engine:pgPool?'PostgreSQL17-multisession':'PGlite-single-session',limitation:pgPool?'synthetic fixture only; QA schema and real provider still untested':'real PostgreSQL concurrency still required'}));
}finally{await db.close()}
