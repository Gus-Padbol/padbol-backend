import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
const root=process.env.DG11_ROOT;assert.ok(root?.includes('/padbol-backend-canonical/.worktrees/'));
const baseline=process.env.DG11_BASELINE==='1';
const require=createRequire(root+'/package.json');const {Pool}=require('pg');
const load=p=>import(pathToFileURL(root+'/'+p));
const {createCrmService,createSupabaseCrmRepository}=await load('lib/crmService.js');
const {createCrmAdminService,registerCrmAdminRoutes}=await load('lib/crmAdmin.js');
const {createCrmImapInboxSync}=await load('lib/crmImapInbound.js');
const {readCrmSupportImapConfig,createCrmSupportSender}=await load('lib/crmSupportMailbox.js');
const bin='/opt/homebrew/opt/postgresql@17/bin',dir=await mkdtemp('/tmp/dg11-private-pg-');
let running=false,pool;const checks=[];const check=(name)=>checks.push(name);
const ident=x=>{assert.match(x,/^[a-z_][a-z_0-9]*$/);return '"'+x+'"';};
let loseRpc=false;
async function dbq(sql,args){const client=await pool.connect();try{await client.query('SET ROLE service_role');return await client.query(sql,args);}finally{await client.query('RESET ROLE');client.release();}}
function pgTransport(){return {from(table){ident(table);let mode='select',payload,filters=[],selection='*',one=false,order,limit;
 const q={select(s='*'){selection=s;return this;},insert(p){mode='insert';payload=p;return this;},update(p){mode='update';payload=p;return this;},eq(k,v){filters.push([k,'=',v]);return this;},neq(k,v){filters.push([k,'<>',v]);return this;},is(k,v){assert.equal(v,null);filters.push([k,'IS',null]);return this;},order(k,o={}){order=[k,o.ascending!==false];return this;},limit(n){limit=n;return this;},single(){one=true;return this;},maybeSingle(){one=true;return this;},then(ok,bad){return run().then(ok,bad);}};
 async function run(){try{let args=[],where=()=>filters.length?' WHERE '+filters.map(([k,op,v])=>ident(k)+(op==='IS'?' IS NULL':op+'$'+(args.push(v)))).join(' AND '):'';let sql;
 if(mode==='insert'){const keys=Object.keys(payload);args=keys.map(k=>payload[k]);sql=`INSERT INTO ${ident(table)}(${keys.map(ident)}) VALUES(${keys.map((_,i)=>'$'+(i+1))}) RETURNING *`;}
 else if(mode==='update'){const keys=Object.keys(payload);args=keys.map(k=>payload[k]);sql=`UPDATE ${ident(table)} SET ${keys.map((k,i)=>ident(k)+'=$'+(i+1))}${where()} RETURNING *`;}
 else {sql=`SELECT * FROM ${ident(table)}${where()}`;if(order)sql+=' ORDER BY '+ident(order[0])+(order[1]?' ASC':' DESC');if(limit)sql+=' LIMIT '+Number(limit);}
 let rows=(await dbq(sql,args)).rows;
 if(selection.includes('contact:crm_contacts'))for(const row of rows)row.contact=(await dbq('SELECT * FROM crm_contacts WHERE id=$1',[row.contact_id])).rows[0];
 return {data:one?(rows[0]||null):rows,error:null};}catch(error){return {data:null,error};}}
 return q;},async rpc(name,p){assert.equal(name,'crm_register_activity_with_state');try{const data=(await dbq('SELECT crm_register_activity_with_state($1::jsonb,$2::text) result',[JSON.stringify(p.p_activity),p.p_state])).rows[0].result;if(loseRpc&&!p.p_activity?.support_probe){loseRpc=false;throw Error('synthetic response lost AFTER commit');}return {data,error:null};}catch(error){return {data:null,error};}}};}
try{
 execFileSync(bin+'/initdb',['-D',dir+'/data','--username=postgres','--auth-local=trust','--auth-host=reject','--no-locale','--encoding=UTF8'],{stdio:'pipe',env:{...process.env,LC_ALL:'C',LANG:'C'}});
 execFileSync(bin+'/pg_ctl',['-D',dir+'/data','-l',dir+'/server.log','-o',`-F -h '' -k ${dir} -p5432`,'-w','start'],{stdio:'pipe'});running=true;
 pool=new Pool({host:dir,port:5432,user:'postgres',database:'postgres',max:6});
 await pool.query('CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;');
 for(const p of ['sql/20260915000000_crm_unified_inbox.sql','sql/20260916000000_crm_inbound_content.sql','sql/20260917000000_crm_operational_history_and_inbound_events.sql','sql/20261019160000_crm_activity_state_atomic.sql'])await pool.query(await readFile(root+'/'+p,'utf8'));
 await pool.query('ALTER TABLE crm_replies ADD COLUMN provider_message_id text;');
 if(!baseline)await pool.query(await readFile(root+'/sql/candidates/dg11_support_activity_compatible.sql','utf8'));
 const repo=createSupabaseCrmRepository(pgTransport(),{commercialEmailTriageEnabled:false});const service=createCrmService({repository:repo});
 const config=readCrmSupportImapConfig({PADBOL_RUNTIME:'production',NODE_ENV:'production',CRM_SUPPORT_IMAP_ENABLED:'true',CRM_SUPPORT_IMAP_HOST:'imap.example.invalid',CRM_SUPPORT_IMAP_USER:'support@padbol.com',CRM_SUPPORT_IMAP_PASSWORD:'fixture-only',CRM_SUPPORT_IMAP_PORT:'993'});
 // Explicit fixture readiness: no production configuration/credentials are loaded.
 Object.assign(config,{enabled:true,ready:true,readOnly:true,source:'support_email',origin:'support_email',qualificationData:{routing:{workflow:'support'},mailbox:{address:'support@padbol.com'}}});
 const mime=Buffer.from('From: Club A <club-a@example.invalid>\r\nTo: support@padbol.com\r\nMessage-ID: <dg11-club-a@example.invalid>\r\nSubject: Error al abrir el marcador\r\nDate: Sun, 01 Nov 2026 12:00:00 +0000\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nEl marcador no abre. Caso sintetico, sin clientes.');
 let parsedCalls=0;const parser=require('mailparser').simpleParser;
 const sync=()=>createCrmImapInboxSync({crmService:service,config,logger:{error(x,y){throw Error(JSON.stringify(y));}},parseMessage:async bytes=>{parsedCalls++;return parser(bytes);},createClient:()=>({mailbox:{uidValidity:1},async connect(){},async getMailboxLock(){return{release(){}};},async search(){return[1];},async *fetch(){yield{uid:1,source:mime};},async logout(){}})}).syncOnce();
 assert.equal((await sync()).status,'ok');assert.equal((await sync()).status,'ok');
 const a=(await pool.query('SELECT * FROM crm_conversations')).rows[0];assert.equal(a.origin,'support_email');assert.equal((await pool.query('SELECT count(*) FROM crm_conversations')).rows[0].count,'1');assert.equal((await pool.query('SELECT count(*) FROM crm_inbound_events')).rows[0].count,'1');assert.equal(parsedCalls,2);check('real_IMAP_handler_MIME_parser_CRM_service_and_repository_intake_restart_idempotency');
 const users={operator:{id:'11111111-1111-4111-8111-111111111111',email:'support-operator@example.invalid'},clubA:{id:'22222222-2222-4222-8222-222222222222',email:'club-a@example.invalid'},clubB:{id:'33333333-3333-4333-8333-333333333333',email:'club-b@example.invalid'}};
 let sends=0,uncertain=false;const sender=createCrmSupportSender({env:{CRM_SUPPORT_SMTP_HOST:'smtp.example.invalid',CRM_SUPPORT_SMTP_USER:'support@padbol.com',CRM_SUPPORT_SMTP_PASSWORD:'fixture-only',CRM_SUPPORT_SMTP_ENABLED:'true'},runtime:{mode:'production',outboundDeliveryEnabled:true},createTransport:()=>({async sendMail(input){sends++;assert.equal(input.to,'club-a@example.invalid');if(uncertain)throw Error('synthetic accepted but ACK lost');return{messageId:'synthetic-provider-'+sends,accepted:[input.to]};}})});
 const admin=createCrmAdminService({repository:repo,supportActivityAtomicEnabled:!baseline,resolvePermissions:({email})=>({role:email===users.operator.email?'operator':'none',canOperate:email===users.operator.email,canAudit:email===users.operator.email}),sendEmailReply:sender});
 const routes=new Map();const app={};for(const method of ['get','post'])app[method]=(path,fn)=>routes.set(method+' '+path,fn);
 registerCrmAdminRoutes(app,{crmAdminService:admin,authUserFromBearer:async req=>users[req.identity],fetchUserRoleRow:async()=>({role:'admin_club'}),logger:{error(){}}});
 const call=async(path,body={},identity='operator')=>{let status=200,value;const res={status(n){status=n;return this;},json(v){value=v;return this;},set(){return this;}};await routes.get('post /api/admin/crm/inbox/:id/'+path)({identity,params:{id:a.id},body},res);return{status,body:value};};
 const uuid=n=>`aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12,'0')}`;
 for(const identity of ['clubA','clubB'])for(const path of ['handoff','reply','activities'])assert.equal((await call(path,{requestId:uuid(1),body:'Forbidden',type:'note',summary:'Forbidden',conversation_state:'cerrado'},identity)).status,403);
 assert.equal((await pool.query('SELECT count(*) FROM crm_activities')).rows[0].count,'0');assert.equal(sends,0);check('club_A_and_B_cannot_assign_reply_or_close_other_club_CRM_no_writes_or_sends');
 const assigned=await call('handoff',{requestId:uuid(1)});
 if(baseline){assert.equal(assigned.status,409);assert.equal(assigned.body.code,'CRM_HANDOFF_NOT_READY');check('REPRODUCED_support_assignment_blocked_by_commercial_qualification');}
 else{assert.equal(assigned.status,200,JSON.stringify(assigned));assert.equal((await call('handoff',{requestId:uuid(1)})).body.activityId,assigned.body.activityId);assert.equal((await pool.query('SELECT operador,derivado FROM crm_conversations WHERE id=$1',[a.id])).rows[0].derivado,true);check('support_assignment_real_handler_atomic_audited_and_idempotent_without_commercial_qualification');}
 const note={type:'note',summary:'Diagnóstico sintético: reproducido con fixture local; prueba correctiva aprobada',outcome:'Corregido y verificado localmente',requestId:uuid(2),conversation_state:'en_atencion'};
 assert.equal((await call('activities',note)).status,201);check('real_activity_handler_records_diagnosis_solution_and_actor');
 const reply={requestId:uuid(3),body:'Solución de prueba verificada; abrí nuevamente el marcador.'};assert.equal((await call('reply',reply)).status,200);assert.equal((await call('reply',reply)).body.repeated,true);assert.equal(sends,1);check('real_reply_handler_real_support_sender_simulated_provider_receipt_no_duplicate');
 const close={type:'note',summary:'Verificación y cierre sintéticos',outcome:'Prueba local del marcador aprobada',requestId:uuid(4),conversation_state:'cerrado'};
 assert.equal((await call('activities',close)).status,201);const count=Number((await pool.query('SELECT count(*) FROM crm_activities')).rows[0].count);assert.equal((await call('activities',close)).status,201);const after=Number((await pool.query('SELECT count(*) FROM crm_activities')).rows[0].count);
 if(baseline){assert.equal(after,count+1);check('REPRODUCED_close_retry_duplicates_audit_activity');}
 else{assert.equal(after,count);assert.equal((await call('activities',{...close,conversation_state:'nuevo'})).status,409);assert.equal((await call('handoff',{requestId:uuid(9)})).status,409);check('closure_audit_request_state_binding_replay_and_terminal_fence');}
 if(!baseline){
  // New support conversation: same handler path, independent synthetic contact/event.
  const c=await service.ingestInbound({source:'support_email',sourceId:'dg11-second',channel:'email',email:'club-a@example.invalid',origin:'support_email',subject:'Second synthetic case',body:'Synthetic',qualificationData:config.qualificationData});
  const id=a.id;a.id=c.conversation.id;
  assert.equal((await call('activities',{...close,requestId:uuid(20)})).status,409);check('close_requires_assignment_and_confirmed_reply');
  const result=await Promise.all(Array.from({length:6},()=>call('handoff',{requestId:uuid(21)})));assert.ok(result.every(x=>x.status===200));assert.equal(new Set(result.map(x=>x.body.activityId)).size,1);check('PostgreSQL_concurrent_same_assignment_six_clients_one_audit');
  await pool.query(`CREATE FUNCTION synthetic_reject_state() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN IF NEW.estado='en_atencion' THEN RAISE EXCEPTION 'synthetic state failure';END IF;RETURN NEW;END$$;CREATE TRIGGER synthetic_failure BEFORE UPDATE ON crm_conversations FOR EACH ROW EXECUTE FUNCTION synthetic_reject_state();`);
  let before=(await pool.query('SELECT count(*) FROM crm_activities')).rows[0].count;assert.equal((await call('activities',{...note,requestId:uuid(22)})).status,409);assert.equal((await pool.query('SELECT count(*) FROM crm_activities')).rows[0].count,before);await pool.query('DROP TRIGGER synthetic_failure ON crm_conversations');check('state_update_failure_rolls_back_inserted_audit');
  loseRpc=true;assert.equal((await call('activities',{...note,requestId:uuid(23)})).status,503);before=(await pool.query('SELECT count(*) FROM crm_activities')).rows[0].count;assert.equal((await call('activities',{...note,requestId:uuid(23)})).status,201);assert.equal((await pool.query('SELECT count(*) FROM crm_activities')).rows[0].count,before);check('lost_commit_response_same_request_recovers_without_duplicate');
  assert.equal((await call('reply',{...reply,requestId:uuid(26)})).status,200); // previous confirmed reply must not mask newer uncertainty.
  uncertain=true;assert.equal((await call('reply',{...reply,requestId:uuid(24)})).status,503);assert.equal((await call('reply',{...reply,requestId:uuid(24)})).status,409);assert.equal((await call('activities',{...close,requestId:uuid(25)})).status,409);check('uncertain_provider_no_resend_and_no_false_closure');
  uncertain=false;
  const fresh=async n=>{const x=await service.ingestInbound({source:'support_email',sourceId:'race-'+n,channel:'email',email:'club-a@example.invalid',origin:'support_email',subject:'Race fixture',body:'Synthetic',qualificationData:config.qualificationData});a.id=x.conversation.id;assert.equal((await call('handoff',{requestId:uuid(n)})).status,200);assert.equal((await call('reply',{...reply,requestId:uuid(n+1)})).status,200);return x.conversation;};
  const waitLock=async pid=>{for(let i=0;i<50;i++){if((await pool.query("SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1",[pid])).rows[0]?.wait_event_type==='Lock')return;await new Promise(r=>setTimeout(r,10));}assert.fail('Expected actual PostgreSQL lock wait');};
  const race=await fresh(30),one=await pool.connect(),two=await pool.connect();
  try{await one.query('BEGIN');await one.query('SET LOCAL ROLE service_role');
   await one.query('SELECT crm_register_activity_with_state($1::jsonb,$2)',[JSON.stringify({support_protocol:1,support_action:'activity',id:uuid(32),conversation_id:race.id,contact_id:race.contact_id,activity_type:'note',summary:'Race close',outcome:'Recorded synthetic correction',author:users.operator.email}),'cerrado']);
   const waiting=two.query("INSERT INTO crm_replies(id,conversation_id,body,operador,status,support_protocol) VALUES($1,$2,'New synthetic reply',$3,'pending',1)",[uuid(33),race.id,users.operator.email]).then(()=>({ok:true}),error=>({error}));await waitLock(two.processID);await one.query('COMMIT');assert.equal((await waiting).error?.code,'23514');check('close_versus_new_reply_parent_row_lock_rejects_late_insert');
  }finally{await one.query('ROLLBACK');one.release();two.release();}
  const race2=await fresh(40),three=await pool.connect();
  try{await three.query('BEGIN');await three.query("INSERT INTO crm_replies(id,conversation_id,body,operador,status,support_protocol) VALUES($1,$2,'Pending synthetic reply',$3,'pending',1)",[uuid(42),race2.id,users.operator.email]);
   const closing=call('activities',{...close,requestId:uuid(43)});let locked=false;for(let i=0;i<50;i++){const n=(await pool.query("SELECT count(*) FROM pg_stat_activity WHERE wait_event_type='Lock' AND pid<>$1",[three.processID])).rows[0].count;if(Number(n)>0){locked=true;break;}await new Promise(r=>setTimeout(r,10));}assert.equal(locked,true);await three.query('COMMIT');assert.equal((await closing).status,409);assert.notEqual((await pool.query('SELECT estado FROM crm_conversations WHERE id=$1',[race2.id])).rows[0].estado,'cerrado');check('new_pending_reply_versus_close_waits_then_rejects_closure');
  }finally{await three.query('ROLLBACK');three.release();}
  const rr=await pool.connect();try{await rr.query('BEGIN ISOLATION LEVEL REPEATABLE READ');await rr.query('SET LOCAL ROLE service_role');await assert.rejects(rr.query('SELECT crm_register_activity_with_state($1::jsonb,$2)',[JSON.stringify({support_protocol:1,support_action:'activity',id:uuid(44),conversation_id:race2.id,contact_id:race2.contact_id,activity_type:'note',summary:'RR',author:users.operator.email}),'en_atencion']),e=>e.code==='P0001');check('incompatible_isolation_fails_before_write');}finally{await rr.query('ROLLBACK');rr.release();}
  a.id=id;
 }
 const privileges=(await pool.query("SELECT has_function_privilege('anon','crm_register_activity_with_state(jsonb,text)','execute') anon,has_function_privilege('authenticated','crm_register_activity_with_state(jsonb,text)','execute') authenticated,has_function_privilege('service_role','crm_register_activity_with_state(jsonb,text)','execute') service")).rows[0];assert.deepEqual(privileges,{anon:false,authenticated:false,service:true});check('existing_RPC_ACL_preserved_no_new_permission');
 for(const role of ['anon','authenticated']){const client=await pool.connect();try{await client.query('SET ROLE '+role);await assert.rejects(client.query("SELECT crm_register_activity_with_state('{}'::jsonb,'cerrado')"),e=>e.code==='42501');}finally{await client.query('RESET ROLE');client.release();}}check('anonymous_and_authenticated_database_RPC_denied');
 console.log(JSON.stringify({ok:true,baseline,root,checks,groups:checks.length,syntheticProviderCalls:sends,externalCalls:0,realRecords:0,actualHandlers:true,actualRepository:true,postgresVersion:(await pool.query('SHOW server_version')).rows[0].server_version,limit:'fixture operator is injected authority, not a new deployed technical actor or autonomous worker'},null,2));
}finally{if(pool)await pool.end();if(running)execFileSync(bin+'/pg_ctl',['-D',dir+'/data','-m','fast','-w','stop'],{stdio:'pipe'});await rm(dir,{recursive:true,force:true});}
