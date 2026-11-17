import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {readFile,writeFile} from 'node:fs/promises';
import {randomUUID,randomBytes} from 'node:crypto';
const base=fileURLToPath(new URL('../../',import.meta.url)).replace(/\/$/,'');
const require=createRequire(base+'/package.json'),{Pool,Client}=require('pg'),{Webhook}=require('svix');
const {createCaseEmailFollowup}=await import(base+'/lib/crmCaseEmailFollowup.js');
const {createCaseEmailFollowupSender}=await import(base+'/lib/crmCaseEmailFollowupSender.js');
const {createCrmEmailSender}=await import(base+'/lib/crmEmailSender.js');
const {createCrmEmailReturn}=await import(base+'/lib/crmEmailReturn.js');
const dbname='crm_root_verify_'+randomBytes(5).toString('hex');
const adminUrl=new URL(process.env.CRM_CASE_EMAIL_TEST_ADMIN_URL||'postgresql:///postgres?host=/tmp&port=55432');
assert.ok(['','localhost','127.0.0.1','[::1]'].includes(adminUrl.hostname),'Local test PostgreSQL only');
const admin=new Client({connectionString:adminUrl.toString()});await admin.connect();await admin.query(`create database "${dbname}"`);
const testUrl=new URL(adminUrl);testUrl.pathname='/'+dbname;
const pool=new Pool({connectionString:testUrl.toString(),max:8,statement_timeout:5000});
const results=[],sent=[];let clock=new Date('2026-11-01T12:00:00Z');
process.env.CRM_INBOUND_FORM_SECRET='root-local-test-only';process.env.PADBOL_EXPERIENCE_URL='https://padbol.com/experiencia-comercial';
const env={CRM_OUTBOUND_EMAIL_PROVIDER:'resend',CRM_OUTBOUND_EMAIL_ENABLED:'true',CRM_OUTBOUND_EMAIL_FROM:'info@padbol.com',CRM_OUTBOUND_EMAIL_REPLY_TO:'info@padbol.com',CRM_OUTBOUND_EMAIL_API_KEY:'local-fake-provider',CRM_EMAIL_RETURN_ENABLED:'true',CRM_EMAIL_PROVIDER_WEBHOOK_SECRET:'whsec_'+randomBytes(32).toString('base64')};
const emailSender=createCrmEmailSender({env,runtime:{outboundDeliveryEnabled:true},fetchImpl:async(url,req)=>{assert.equal(url,'https://api.resend.com/emails');const payload=JSON.parse(req.body);sent.push({payload,id:'provider-'+sent.length,idem:req.headers['Idempotency-Key']});return {ok:true,status:200,json:async()=>({id:sent.at(-1).id})};}});
const service=()=>createCaseEmailFollowup({pool,sendEmail:createCaseEmailFollowupSender({emailSender}),now:()=>clock});
const ret=createCrmEmailReturn({pool,env});
async function check(name,fn){try{await fn();results.push({name,ok:true});}catch(e){results.push({name,ok:false,error:e.code||e.message,actual:e.actual,expected:e.expected,stack:e.stack?.split('\n').slice(0,4).join('\n')});}}
async function lead(address,channel='email'){const cv=randomUUID(),ct=randomUUID(),caseId=channel==='email'?cv:randomUUID();await pool.query('insert into crm_contacts values($1,$2)',[ct,address]);await pool.query("insert into crm_conversations(id,contact_id,estado,source_channel,origin,received_at,updated_at) values($1,$2,'en_atencion',$3,'web_form:contacto',$4,$4)",[cv,ct,channel,new Date('2026-10-01T12:00:00Z')]);await pool.query(channel==='email'?"insert into crm_commercial_form_cases values($1,'en_espera')":"insert into crm_commercial_cases values($1,$2,'en_espera')",channel==='email'?[cv]:[caseId,cv]);return {cv,ct,caseId,type:channel==='email'?'form':'whatsapp',address};}
async function activate(l){return service().activatePlan({caseType:l.type,caseId:l.caseId,explicitHuman:true,consentEvidence:'Permiso de contacto de prueba',startedAt:clock});}
async function first(l){const a=await activate(l),d=(await service().claimDispatch()).find(x=>x.plan_id===a.planId);assert.ok(d);const out=await service().deliver({dispatch:d});assert.equal(out.status,'accepted');return {a,d,provider:sent.at(-1).id};}
async function providerEvent(provider,rfc,type='email.sent'){const raw=Buffer.from(JSON.stringify({type,created_at:clock.toISOString(),data:{email_id:provider,message_id:'<'+rfc+'>'}}));const id=randomUUID(),headers={'svix-id':id,'svix-timestamp':String(Math.floor(Date.now()/1000)),'svix-signature':new Webhook(env.CRM_EMAIL_PROVIDER_WEBHOOK_SECRET).sign(id,new Date(),raw)};return ret.providerEvent(raw,headers);}
try{
 await pool.query(`create table crm_contacts(id uuid primary key,email_normalized text);
 create table crm_conversations(id uuid primary key,contact_id uuid references crm_contacts,estado text,source_channel text,origin text,received_at timestamptz,updated_at timestamptz,test_hidden_at timestamptz);
 create table crm_commercial_form_cases(conversation_id uuid primary key,progress_state text);
 create table crm_commercial_cases(id uuid primary key,conversation_id uuid,progress_state text);
 create table crm_commercial_followups(id uuid primary key,conversation_id uuid,status text,recipient_wa_id text,case_type text);
 create table crm_prospect_suppressions(id uuid primary key default gen_random_uuid(),email text,active boolean default true,reason text);
 create table crm_replies(id uuid primary key,conversation_id uuid references crm_conversations,body text,operador text,status text,provider_message_id text,created_at timestamptz default now());
 create table crm_inbound_events(id uuid default gen_random_uuid(),conversation_id uuid,source_channel text,source_ref text,origin text,subject text,body text,received_at timestamptz,unique(source_channel,origin,source_ref));
 create table crm_activities(contact_id uuid,conversation_id uuid,activity_type text,summary text,author text);
 create function root_reply_guard() returns trigger language plpgsql as $$begin perform 1 from crm_conversations where id=new.conversation_id for update;return new;end$$;
 create trigger root_reply_guard before insert on crm_replies for each row execute function root_reply_guard();`);
 await pool.query(await readFile(base+'/sql/migrations/20261028160000_crm_email_provider_receipts.sql','utf8'));
 await pool.query(await readFile(base+'/sql/20261117_crm_case_email_followup.sql','utf8'));
 await check('Real sender + signed webhook + inbound reply stops remaining form mails',async()=>{clock=new Date('2026-11-01T12:00:00Z');const l=await lead('form@example.test'),{a,provider}=await first(l);assert.equal(sent.at(-1).payload.subject,'Una nueva oportunidad deportiva y comercial para su club');assert.equal((await providerEvent(provider,'form-reply@resend.example')).recorded,true);clock=new Date('2026-11-02T12:00:00Z');assert.equal((await ret.ingestReply({externalId:'incoming-form@example.test',from:l.address,to:'info@padbol.com',inReplyTo:'form-reply@resend.example',references:[],subject:'Re',body:'Podemos hablar',receivedAt:clock.toISOString()})).matched,true);const before=sent.length;clock=new Date('2026-11-08T12:00:00Z');const d=(await service().claimDispatch()).find(x=>x.plan_id===a.planId);assert.ok(d);assert.equal((await service().deliver({dispatch:d})).status,'stopped');assert.equal(sent.length,before);assert.equal((await pool.query("select count(*)::int n from crm_case_email_followup_outbox where plan_id=$1 and status in ('queued','claimed')",[a.planId])).rows[0].n,0);});
 await check('WhatsApp-origin case email preserves real reply threading',async()=>{clock=new Date('2026-11-01T12:00:00Z');const l=await lead('wa-email@example.test','whatsapp'),{provider}=await first(l);assert.equal((await providerEvent(provider,'wa-reply@resend.example')).recorded,true);assert.equal((await ret.ingestReply({externalId:'incoming-wa@example.test',from:l.address,to:'info@padbol.com',inReplyTo:'wa-reply@resend.example',body:'Gracias, hablemos',receivedAt:'2026-11-02T12:00:00Z'})).matched,true);});
 await check('Late scheduler does not send three mails together',async()=>{clock=new Date('2026-11-01T12:00:00Z');const l=await lead('late@example.test'),a=await activate(l);clock=new Date('2026-12-01T12:00:00Z');let d=(await service().claimDispatch()).filter(x=>x.plan_id===a.planId);assert.equal(d.length,1);assert.equal((await service().deliver({dispatch:d[0]})).status,'accepted');assert.equal((await service().claimDispatch()).filter(x=>x.plan_id===a.planId).length,0);});
 await check('Concurrent cases with same email create only one active plan',async()=>{clock=new Date('2026-11-01T12:00:00Z');const a=await lead('duplicate@example.test'),b=await lead('duplicate@example.test');await Promise.allSettled([activate(a),activate(b)]);assert.equal((await pool.query("select count(*)::int n from crm_case_email_followup_plans where recipient_email='duplicate@example.test' and status='active'")).rows[0].n,1);});
 await check('Three steps end in human review without closing the lead',async()=>{clock=new Date('2026-11-01T12:00:00Z');const l=await lead('three@example.test'),a=await activate(l);for(const day of [1,8,15]){clock=new Date(`2026-11-${String(day).padStart(2,'0')}T12:00:00Z`);const d=(await service().claimDispatch()).find(x=>x.plan_id===a.planId);assert.ok(d);await service().deliver({dispatch:d});}assert.equal((await pool.query('select status from crm_case_email_followup_plans where id=$1',[a.planId])).rows[0].status,'human_review');assert.equal((await pool.query('select estado from crm_conversations where id=$1',[l.cv])).rows[0].estado,'en_atencion');});
}finally{await pool.end();await admin.query(`drop database "${dbname}"`);await admin.end();}
const receipt={at:new Date().toISOString(),testEnvironment:'isolated temporary local PostgreSQL database, destroyed after run',backendBase:process.env.PADBOL_RELEASE_COMMIT||'current checkout',realCustomerSends:0,provider:'fake HTTP transport through real CRM email sender',results,pass:results.filter(x=>x.ok).length,fail:results.filter(x=>!x.ok).length};
await writeFile(process.env.CRM_CASE_EMAIL_TEST_REPORT||'/tmp/crm-case-email-e2e-result.json',JSON.stringify(receipt,null,2)+'\n');console.log(JSON.stringify(receipt,null,2));process.exitCode=receipt.fail?1:0;
