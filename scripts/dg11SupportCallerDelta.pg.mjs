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
 return q;},async rpc(name,p){assert.equal(name,'crm_register_activity_with_state');try{const data=(await dbq('SELECT crm_register_activity_with_state($1::jsonb,$2::text) result',[JSON.stringify(p.p_activity),p.p_state])).rows[0].result;if(loseRpc){loseRpc=false;throw Error('synthetic response lost AFTER commit');}return {data,error:null};}catch(error){return {data:null,error};}}};}
try{
 execFileSync(bin+'/initdb',['-D',dir+'/data','--username=postgres','--auth-local=trust','--auth-host=reject','--no-locale','--encoding=UTF8'],{stdio:'pipe',env:{...process.env,LC_ALL:'C',LANG:'C'}});
 execFileSync(bin+'/pg_ctl',['-D',dir+'/data','-l',dir+'/server.log','-o',`-F -h '' -k ${dir} -p5432`,'-w','start'],{stdio:'pipe'});running=true;
 pool=new Pool({host:dir,port:5432,user:'postgres',database:'postgres',max:6});
 await pool.query('CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;');
 for(const p of ['sql/20260915000000_crm_unified_inbox.sql','sql/20260916000000_crm_inbound_content.sql','sql/20260917000000_crm_operational_history_and_inbound_events.sql','sql/20261019160000_crm_activity_state_atomic.sql'])await pool.query(await readFile(root+'/'+p,'utf8'));
 await pool.query('ALTER TABLE crm_replies ADD COLUMN provider_message_id text;');
 if(!baseline)await pool.query(await readFile(root+'/sql/candidates/dg11_support_activity_atomic.sql','utf8'));
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
 const {runCrmSupportCommand}=await import(pathToFileURL(process.env.DG11_CALLER_ROOT+'/src/utils/crmSupportCommand.js'));
 const {webcrypto}=await import('node:crypto');const values=new Map();const storage={getItem:k=>values.get(k)||null,setItem:(k,v)=>values.set(k,v),removeItem:k=>values.delete(k)};
 assert.equal(admin.getPermissions({email:users.operator.email,userId:users.operator.id}).supportActivityAtomicEnabled,true);
 assert.equal(admin.getPermissions({email:users.clubB.email,userId:users.clubB.id}).supportActivityAtomicEnabled,undefined);check('capability_advertised_only_to_existing_authorized_operator');
 const execute=async(path,payload,ref)=>{const response=await call(path,{...payload,requestId:ref});if(response.status>=400)throw Object.assign(Error(response.body.error),{status:response.status,code:response.body.code});return response.body;};
 const run=(action,payload,send)=>runCrmSupportCommand({actorId:users.operator.id,conversationId:a.id,action,payload,execute:send,storage,cryptoApi:webcrypto});
 let firstRef;await assert.rejects(run('assignment',{},async ref=>{firstRef=ref;await execute('handoff',{},ref);throw Error('synthetic lost HTTP acknowledgment AFTER commit');}),/lost HTTP/);
 let before=(await pool.query('SELECT count(*) FROM crm_activities')).rows[0].count;await run('assignment',{},async ref=>{assert.equal(ref,firstRef);return execute('handoff',{},ref);});assert.equal((await pool.query('SELECT count(*) FROM crm_activities')).rows[0].count,before);check('frontend_persisted_assignment_request_through_real_handler_repository_PG_commit_loss_and_replay');
 const note={type:'note',summary:'Synthetic local diagnosis',outcome:'Synthetic local solution recorded',conversation_state:'en_atencion'};
 await assert.rejects(run('activity',note,async ref=>{firstRef=ref;await execute('activities',note,ref);throw Error('synthetic lost HTTP response');}),/lost HTTP/);
 let calls=0;await assert.rejects(run('activity',{...note,outcome:'edited while uncertain'},async()=>{calls++;}),{code:'CRM_SUPPORT_PENDING_REVIEW'});assert.equal(calls,0);before=(await pool.query('SELECT count(*) FROM crm_activities')).rows[0].count;
 await run('activity',note,async ref=>{assert.equal(ref,firstRef);return execute('activities',note,ref);});assert.equal((await pool.query('SELECT count(*) FROM crm_activities')).rows[0].count,before);check('frontend_uncertain_edit_blocked_then_original_diagnosis_recovers_without_duplicate');
 const reply=await call('reply',{requestId:'aaaaaaaa-aaaa-4aaa-8aaa-000000000003',body:'Synthetic verified solution'});assert.equal(reply.status,200);assert.equal(sends,1);check('existing_reply_handler_support_sender_and_fake_receipt_confirmed');
 const close={...note,summary:'Synthetic resolution and closure',conversation_state:'cerrado'};
 await assert.rejects(run('activity',close,async ref=>{firstRef=ref;await execute('activities',close,ref);throw Error('synthetic lost close acknowledgment');}),/lost close/);before=(await pool.query('SELECT count(*) FROM crm_activities')).rows[0].count;
 await run('activity',close,async ref=>{assert.equal(ref,firstRef);return execute('activities',close,ref);});assert.equal((await pool.query('SELECT count(*) FROM crm_activities')).rows[0].count,before);assert.equal((await pool.query('SELECT estado FROM crm_conversations WHERE id=$1',[a.id])).rows[0].estado,'cerrado');assert.equal(values.size,0);check('frontend_close_request_identity_survives_commit_ack_loss_actual_audit_single_and_closed');
 for(const identity of ['clubA','clubB'])assert.equal((await call('activities',{...close,requestId:'aaaaaaaa-aaaa-4aaa-8aaa-000000000004'},identity)).status,403);assert.equal((await pool.query('SELECT count(*) FROM crm_activities')).rows[0].count,before);check('integrated_caller_does_not_grant_other_club_authority');
 console.log(JSON.stringify({ok:true,groups:checks.length,checks,root,callerRoot:process.env.DG11_CALLER_ROOT,syntheticProviderCalls:sends,externalCalls:0,realRecords:0,scope:'new frontend identity helper + real backend handlers/repository and private PostgreSQL; no server or provider live'},null,2));
}finally{if(pool)await pool.end();if(running)execFileSync(bin+'/pg_ctl',['-D',dir+'/data','-m','fast','-w','stop'],{stdio:'pipe'});await rm(dir,{recursive:true,force:true});}
