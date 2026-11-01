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
 // Compatible proposal is installed below, after probing gate ON against the old RPC.
 const repo=createSupabaseCrmRepository(pgTransport(),{commercialEmailTriageEnabled:false});const service=createCrmService({repository:repo});
 const config=readCrmSupportImapConfig({PADBOL_RUNTIME:'production',NODE_ENV:'production',CRM_SUPPORT_IMAP_ENABLED:'true',CRM_SUPPORT_IMAP_HOST:'imap.example.invalid',CRM_SUPPORT_IMAP_USER:'support@padbol.com',CRM_SUPPORT_IMAP_PASSWORD:'fixture-only',CRM_SUPPORT_IMAP_PORT:'993'});
 // Explicit fixture readiness: no production configuration/credentials are loaded.
 Object.assign(config,{enabled:true,ready:true,readOnly:true,source:'support_email',origin:'support_email',qualificationData:{routing:{workflow:'support'},mailbox:{address:'support@padbol.com'}}});
 const mime=Buffer.from('From: Club A <club-a@example.invalid>\r\nTo: support@padbol.com\r\nMessage-ID: <dg11-club-a@example.invalid>\r\nSubject: Error al abrir el marcador\r\nDate: Sun, 01 Nov 2026 12:00:00 +0000\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nEl marcador no abre. Caso sintetico, sin clientes.');
 let parsedCalls=0;const parser=require('mailparser').simpleParser;
 const sync=()=>createCrmImapInboxSync({crmService:service,config,logger:{error(x,y){throw Error(JSON.stringify(y));}},parseMessage:async bytes=>{parsedCalls++;return parser(bytes);},createClient:()=>({mailbox:{uidValidity:1},async connect(){},async getMailboxLock(){return{release(){}};},async search(){return[1];},async *fetch(){yield{uid:1,source:mime};},async logout(){}})}).syncOnce();
 assert.equal((await sync()).status,'ok');
 const a=(await pool.query('SELECT * FROM crm_conversations')).rows[0];assert.equal(a.origin,'support_email');assert.equal((await pool.query('SELECT count(*) FROM crm_conversations')).rows[0].count,'1');assert.equal((await pool.query('SELECT count(*) FROM crm_inbound_events')).rows[0].count,'1');assert.equal(parsedCalls,1);
 const users={operator:{id:'11111111-1111-4111-8111-111111111111',email:'support-operator@example.invalid'},clubA:{id:'22222222-2222-4222-8222-222222222222',email:'club-a@example.invalid'},clubB:{id:'33333333-3333-4333-8333-333333333333',email:'club-b@example.invalid'}};
 let sends=0,uncertain=false;const sender=createCrmSupportSender({env:{CRM_SUPPORT_SMTP_HOST:'smtp.example.invalid',CRM_SUPPORT_SMTP_USER:'support@padbol.com',CRM_SUPPORT_SMTP_PASSWORD:'fixture-only',CRM_SUPPORT_SMTP_ENABLED:'true'},runtime:{mode:'production',outboundDeliveryEnabled:true},createTransport:()=>({async sendMail(input){sends++;assert.equal(input.to,'club-a@example.invalid');if(uncertain)throw Error('synthetic accepted but ACK lost');return{messageId:'synthetic-provider-'+sends,accepted:[input.to]};}})});
 const admin=createCrmAdminService({repository:repo,supportActivityAtomicEnabled:!baseline,resolvePermissions:({email})=>({role:email===users.operator.email?'operator':'none',canOperate:email===users.operator.email,canAudit:email===users.operator.email}),sendEmailReply:sender});
 const routes=new Map();const app={};for(const method of ['get','post'])app[method]=(path,fn)=>routes.set(method+' '+path,fn);
 registerCrmAdminRoutes(app,{crmAdminService:admin,authUserFromBearer:async req=>users[req.identity],fetchUserRoleRow:async()=>({role:'admin_club'}),logger:{error(){}}});
 const call=async(path,body={},identity='operator')=>{let status=200,value;const res={status(n){status=n;return this;},json(v){value=v;return this;},set(){return this;}};await routes.get('post /api/admin/crm/inbox/:id/'+path)({identity,params:{id:a.id},body},res);return{status,body:value};};
 const uuid=n=>`bbbbbbbb-bbbb-4bbb-8bbb-${String(n).padStart(12,'0')}`;
 const note={type:'note',summary:'Synthetic legacy support activity',outcome:'Synthetic recorded outcome',conversation_state:'en_atencion'};
 const count=async()=>Number((await pool.query('SELECT count(*) FROM crm_activities')).rows[0].count);
 const snap=async()=>JSON.stringify((await pool.query('SELECT estado,operador,derivado FROM crm_conversations WHERE id=$1',[a.id])).rows[0]);
 let before=await count(),prior=await snap();const early=await call('handoff',{requestId:uuid(1)});assert.equal(early.status,503);assert.equal(early.body.code,'CRM_SUPPORT_PROTOCOL_UNAVAILABLE');assert.equal(await count(),before);assert.equal(await snap(),prior);check('gate_ON_before_SQL_probe_rejects_without_any_command_write');
 const legacySource=path=>{const source=execFileSync('git',['show','eb9d32ec8c74be0b3e3b0f9ee3694c767deb4571:'+path],{cwd:root,encoding:'utf8'});return source.replace(/(from\s*|import\s*\()(['"])(\.\/[^'"]+)\2/g,(_all,start,q,ref)=>start+q+pathToFileURL(root+'/lib/'+ref.slice(2)).href+q);};
 const oldAdmin=await import('data:text/javascript;base64,'+Buffer.from(legacySource('lib/crmAdmin.js')).toString('base64'));
 const oldService=await import('data:text/javascript;base64,'+Buffer.from(legacySource('lib/crmService.js')).toString('base64'));
 const permissionResolver=({email})=>({role:email===users.operator.email?'operator':'none',canOperate:email===users.operator.email,canAudit:email===users.operator.email});
 const oldRepo=oldService.createSupabaseCrmRepository(pgTransport(),{commercialEmailTriageEnabled:false});
 const old=oldAdmin.createCrmAdminService({repository:oldRepo,resolvePermissions:permissionResolver,sendEmailReply:sender});
 const off=createCrmAdminService({repository:repo,resolvePermissions:permissionResolver,sendEmailReply:sender});
 function mount(service,register){const rs=new Map(),ap={};for(const method of ['get','post'])ap[method]=(path,fn)=>rs.set(method+' '+path,fn);register(ap,{crmAdminService:service,authUserFromBearer:async req=>users[req.identity],fetchUserRoleRow:async()=>({role:'admin_club'}),logger:{error(){}}});return async(path,body={},identity='operator')=>{let status=200,value;const res={status(n){status=n;return this;},json(v){value=v;return this;},set(){return this;}};await rs.get('post /api/admin/crm/inbox/:id/'+path)({identity,params:{id:a.id},body},res);return{status,body:value};};}
 const oldCall=mount(old,oldAdmin.registerCrmAdminRoutes),offCall=mount(off,registerCrmAdminRoutes);
 assert.equal(old.getPermissions({email:users.operator.email,userId:users.operator.id}).supportActivityAtomicEnabled,undefined);assert.equal(off.getPermissions({email:users.operator.email,userId:users.operator.id}).supportActivityAtomicEnabled,undefined);
 const sql=await readFile(root+'/sql/candidates/dg11_support_activity_compatible.sql','utf8');
 const originalDef=(await pool.query("SELECT pg_get_functiondef('crm_register_activity_with_state(jsonb,text)'::regprocedure) definition")).rows[0].definition;
 const ddlClient=await pool.connect();try{await assert.rejects(ddlClient.query(sql.replace(/commit;\s*$/,'SELECT 1/0;COMMIT;')),e=>e.code==='22012');}finally{await ddlClient.query('ROLLBACK');ddlClient.release();}
 assert.equal((await pool.query("SELECT pg_get_functiondef('crm_register_activity_with_state(jsonb,text)'::regprocedure) definition")).rows[0].definition,originalDef);assert.equal((await pool.query("SELECT count(*) FROM information_schema.columns WHERE table_name='crm_conversations' AND column_name='support_protocol'")).rows[0].count,'0');check('failed_additive_DDL_rolls_back_columns_guards_and_original_RPC_definition');
 const beforeAcl=(await pool.query("SELECT proacl::text acl FROM pg_proc WHERE oid='crm_register_activity_with_state(jsonb,text)'::regprocedure")).rows[0].acl;
 await pool.query(await readFile(root+'/sql/candidates/dg11_support_activity_compatible.sql','utf8'));
 assert.equal((await pool.query("SELECT proacl::text acl FROM pg_proc WHERE oid='crm_register_activity_with_state(jsonb,text)'::regprocedure")).rows[0].acl,beforeAcl);check('additive_SQL_preserves_existing_RPC_ACL_and_does_not_adopt_historical_cases');
 assert.equal((await oldCall('activities',note)).status,201);assert.equal((await oldCall('activities',{...note,conversation_state:'cerrado'})).status,201);assert.equal((await pool.query('SELECT support_protocol FROM crm_conversations WHERE id=$1',[a.id])).rows[0].support_protocol,null);check('actual_old_backend_handlers_and_old_UI_payload_work_with_new_SQL_and_capability_OFF');
 const fresh=async n=>{const x=await service.ingestInbound({source:'support_email',sourceId:'compat-'+n,channel:'email',email:'club-a@example.invalid',origin:'support_email',subject:'Compatibility fixture',body:'Synthetic',qualificationData:config.qualificationData});a.id=x.conversation.id;return x.conversation;};
 await fresh(2);assert.equal((await offCall('activities',note)).status,201);assert.equal((await offCall('activities',{type:'note',summary:'Legacy note without state'})).status,201);check('new_backend_OFF_keeps_old_UI_contract_without_requestId_or_new_guards');
 await fresh(3);assert.equal((await call('activities',note)).status,201);assert.equal((await pool.query('SELECT support_protocol FROM crm_conversations WHERE id=$1',[a.id])).rows[0].support_protocol,null);check('old_UI_tab_on_new_backend_ON_remains_legacy_until_explicit_case_adoption');
 const managed=await fresh(4);assert.equal((await call('handoff',{requestId:uuid(4)})).status,200);assert.equal((await pool.query('SELECT support_protocol FROM crm_conversations WHERE id=$1',[a.id])).rows[0].support_protocol,1);
 before=await count();prior=await snap();for(const payload of [note,{type:'note',summary:'Legacy no-state note'}])assert.ok((await oldCall('activities',payload)).status>=400);assert.equal(await count(),before);assert.equal(await snap(),prior);assert.equal((await call('activities',note)).body.code,'CRM_SUPPORT_CLIENT_REFRESH_REQUIRED');check('adopted_case_fences_actual_old_backend_state_and_direct_note_paths_without_duplicate_or_reopen');
 const {runCrmSupportCommand}=await import(pathToFileURL(process.env.DG11_CALLER_ROOT+'/src/utils/crmSupportCommand.js'));const {webcrypto}=await import('node:crypto');const values=new Map();const storage={getItem:k=>values.get(k)||null,setItem:(k,v)=>values.set(k,v),removeItem:k=>values.delete(k)};let firstRef;
 const execute=async fn=>{const response=await fn();if(response.status>=400)throw Object.assign(Error(response.body.error),{code:response.body.code,status:response.status});return response.body;};
 const run=send=>runCrmSupportCommand({actorId:users.operator.id,conversationId:a.id,action:'activity',payload:note,execute:send,cryptoApi:webcrypto,storage});
 await assert.rejects(run(ref=>{firstRef=ref;return execute(()=>offCall('activities',{...note,requestId:ref}));}),{code:'CRM_SUPPORT_CASE_PAUSED'});assert.equal(await count(),before);assert.equal(await snap(),prior);await run(ref=>{assert.equal(ref,firstRef);return execute(()=>call('activities',{...note,requestId:ref}));});assert.equal(await count(),before+1);check('gate_OFF_after_adoption_pauses_only_owned_case_and_same_request_recovers_on_reenable');
 await pool.query("UPDATE crm_conversations SET qualification_status='qualified',handoff_ready=true WHERE id=$1",[a.id]);prior=await snap();assert.ok((await oldCall('handoff')).status>=400);assert.equal(await snap(),prior);check('adopted_case_fences_legacy_direct_handoff_state_update');
 before=await count();for(const identity of ['clubA','clubB'])assert.equal((await call('activities',{...note,requestId:uuid(5)},identity)).status,403);assert.equal(await count(),before);check('protocol_does_not_grant_other_club_authority');
 await assert.rejects(pool.query('UPDATE crm_conversations SET support_protocol=NULL WHERE id=$1',[a.id]),e=>e.code==='23514');check('protocol_ownership_cannot_be_silently_removed');
 await fresh(5);const rr=await pool.connect();try{await rr.query('BEGIN ISOLATION LEVEL REPEATABLE READ');await rr.query('SET LOCAL ROLE service_role');const c=(await pool.query('SELECT * FROM crm_conversations WHERE id=$1',[a.id])).rows[0];await rr.query('SELECT crm_register_activity_with_state($1::jsonb,$2)',[JSON.stringify({conversation_id:c.id,contact_id:c.contact_id,activity_type:'note',summary:'Legacy RR contract',author:users.operator.email}),'en_atencion']);await rr.query('COMMIT');check('unadopted_legacy_isolation_contract_not_restricted_to_new_protocol_requirements');}finally{await rr.query('ROLLBACK');rr.release();}
 console.log(JSON.stringify({ok:true,checks,groups:checks.length,externalCalls:0,realRecords:0,oldBackendSource:'eb9d32ec8c74be0b3e3b0f9ee3694c767deb4571 actual admin/routes/repository imported as read-only test fixture',scope:'SQLnew + legacy/current backend handlers; no managed case mutation allowed through legacy; opt-in per case no global pause'},null,2));
}finally{if(pool)await pool.end();if(running)execFileSync(bin+'/pg_ctl',['-D',dir+'/data','-m','fast','-w','stop'],{stdio:'pipe'});await rm(dir,{recursive:true,force:true});}
