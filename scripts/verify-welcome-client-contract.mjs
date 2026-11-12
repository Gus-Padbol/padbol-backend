// Offline contract gate: actual frozen c82 API client -> loopback HTTP -> PGlite.
// No env files, external network, provider, SMTP, real contacts or messages.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL, fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import express from 'express';
import {PGlite} from '@electric-sql/pglite';
import {registerCrmInboundRoutes} from '../lib/crmInboundRoutes.js';

const root = process.env.WELCOME_CLIENT_ROOT;
if (!root) throw Error('WELCOME_CLIENT_ROOT must name the frozen actual c82 checkout');
const expected = 'b24464aade68ce91b61b7f30fc86b1e7f561f00f';
assert.equal(execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),expected);
for (const file of ['api/leads.ts','lib/lead-welcome-email.js','lib/welcome-ledger-client.js','lib/lead-delivery.js']) {
 const frozen=execFileSync('git',['show',`${expected}:${file}`],{cwd:root});
 assert.ok(frozen.equals(await fs.readFile(path.join(root,file))),`FROZEN_CLIENT_SOURCE_REQUIRED:${file}`);
}
let importCounter = 0;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONTACT='11111111-1111-4111-8111-111111111111';
const SECRET='offline-contract-only';
const nativeFetch=globalThis.fetch;
const payload={id:'fixture-a',Nombre:'Offline Fixture',Email:'fixture@example.test',WhatsApp:'test-only',consentPrivacy:true,consentTerms:true,consentMarketing:true,consentDocumentVersion:'test',consentAcceptedAt:'2026-11-11T00:00:00Z',consentLanguage:'es',consentFormType:'contact:general'};

async function boot(dir,{bootstrap=true,failReceipt=false}={}) {
 const db=new PGlite(dir);
 if(bootstrap){await db.exec(`create role anon;create role authenticated;create role service_role;create table public.crm_contacts(id uuid primary key);insert into public.crm_contacts values('${CONTACT}');`);await db.exec(await fs.readFile(path.join(HERE,'../sql/migrations/20261111200000_crm_welcome_ledger.sql'),'utf8'));}
 let receiptFailure=failReceipt;
 const pool={query:async(sql,args)=>{if(receiptFailure&&sql.includes('set status=$2')&&args[1]==='accepted'){receiptFailure=false;throw Error('synthetic receipt persistence failure');}return db.query(sql,args);}};
 const app=express();app.use(express.json({limit:'1mb'}));
 let calls=0;
 registerCrmInboundRoutes(app,{pool,crmService:{ingestInbound:async()=>({status:++calls===1?'accepted':'idempotent',contact:{id:CONTACT},conversation:{id:`22222222-2222-4222-8222-${String(calls).padStart(12,'0')}`}})},formInboundSecret:SECRET,emailInboundSecret:SECRET,experienceRepository:{},logger:{warn(){},error(){}}});
 const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
 const base=`http://127.0.0.1:${server.address().port}`;
 return {db,base,close:async()=>{await new Promise(r=>server.close(r));await db.close();}};
}
async function scenario(fn,options={}) {
 const saved={...process.env};const dir=await fs.mkdtemp(path.join(os.tmpdir(),'padbol-welcome-offline-'));let current=await boot(dir,options),providerCalls=0;
 function configure(){Object.assign(process.env,{CRM_WELCOME_LEDGER_ENABLED:'true',CRM_WELCOME_LEDGER_SECRET:SECRET,CRM_INBOUND_FORM_URL:current.base+'/api/inbound/crm/form',CRM_INBOUND_FORM_SECRET:SECRET,WELCOME_LEDGER_URL:current.base+'/api/internal/crm/welcome',WELCOME_LEDGER_SECRET:SECRET,LEADS_EXPERIENCE_WELCOME_ENABLED:'true',LEADS_ACK_FROM_EMAIL:'Padbol <fixture@example.test>',RESEND_API_KEY:'offline-not-real',LEADS_EMAIL_NOTIFICATION_ENABLED:'false'});}
 configure();
 globalThis.fetch=async(url,opts)=>{
  if(String(url)==='https://api.resend.com/emails'){providerCalls++;if(options.uncertain)throw Error('synthetic accepted response lost');return Response.json({id:'offline-provider-receipt'});}
  if(new URL(url).origin!==current.base)throw Error('EXTERNAL_NETWORK_FORBIDDEN');
  return nativeFetch(url,opts);
 };
 async function run(data=payload){const {default:handler}=await import(pathToFileURL(path.join(root,'api/leads.ts')).href+'?offlineContract='+importCounter++);const r={status(n){this.code=n;return this;},json(v){this.body=v;return this;},setHeader(){}};await handler({method:'POST',headers:{},body:data},r);return r;}
 try{await fn({run,get db(){return current.db;},get providerCalls(){return providerCalls;},restart:async()=>{await current.close();current=await boot(dir,{bootstrap:false});configure();}});}
 finally{globalThis.fetch=nativeFetch;for(const k of Object.keys(process.env))if(!(k in saved))delete process.env[k];Object.assign(process.env,saved);await current.close();await fs.rm(dir,{recursive:true,force:true});}
}

test('actual c82 API sends once across different sourceIds/conversations and returns persisted accepted receipt',async()=>scenario(async s=>{
 const a=await s.run(),b=await s.run({...payload,id:'fixture-b'});assert.equal(a.code,200);assert.equal(b.code,200);assert.equal(a.body.registeredInCrm,true);assert.equal(a.body.welcomeReceipt.status,'accepted');assert.equal(b.body.welcomeReceipt.id,a.body.welcomeReceipt.id);assert.equal(b.body.welcomeReceipt.key,a.body.welcomeReceipt.key);assert.equal(s.providerCalls,1);assert.equal('contact' in a.body,false);
 const rows=(await s.db.query('select status,provider_message_id from crm_welcome_ledger')).rows;assert.deepEqual(rows,[{status:'accepted',provider_message_id:'offline-provider-receipt'}]);
}));
test('concurrent actual c82 requests yield one provider attempt and one SQL claim',async()=>scenario(async s=>{
 const rows=await Promise.all([1,2,3].map(i=>s.run({...payload,id:`concurrent-${i}`})));assert.ok(rows.every(r=>r.code===200));assert.equal(s.providerCalls,1);assert.equal((await s.db.query('select count(*)::int n from crm_welcome_ledger')).rows[0].n,1);
}));
test('real database close/reopen and 25-hour elapsed timestamp retain accepted suppression',async()=>scenario(async s=>{
 await s.run();await s.db.query("update crm_welcome_ledger set claimed_at=claimed_at-interval '25 hours',accepted_at=accepted_at-interval '25 hours'");await s.restart();const replay=await s.run({...payload,id:'after-cold-restart'});assert.equal(replay.body.welcomeReceipt.id,'offline-provider-receipt');assert.equal(s.providerCalls,1);
}));
test('uncertain provider ack remains suppressed after database reopen and 25 hours',async()=>scenario(async s=>{
 const a=await s.run();assert.equal(a.body.welcomeReceipt.status,'uncertain');await s.db.query("update crm_welcome_ledger set claimed_at=claimed_at-interval '25 hours',uncertain_at=uncertain_at-interval '25 hours'");await s.restart();const b=await s.run({...payload,id:'uncertain-replay'});assert.equal(b.body.welcomeReceipt.status,'uncertain');assert.equal(s.providerCalls,1);assert.equal((await s.db.query('select status from crm_welcome_ledger')).rows[0].status,'uncertain');
},{uncertain:true}));
test('accepted provider with receipt write failure leaves durable claim and never retries provider',async()=>scenario(async s=>{
 const a=await s.run();assert.equal(a.body.welcomeReceipt.status,'accepted');assert.equal((await s.db.query('select status from crm_welcome_ledger')).rows[0].status,'claimed');await s.restart();await s.run({...payload,id:'after-receipt-failure'});assert.equal(s.providerCalls,1);
},{failReceipt:true}));
test('client OFF and absent marketing consent perform no SQL claim or provider attempt',async()=>scenario(async s=>{
 process.env.LEADS_EXPERIENCE_WELCOME_ENABLED='false';await s.run();process.env.LEADS_EXPERIENCE_WELCOME_ENABLED='true';await s.run({...payload,id:'no-marketing',consentMarketing:false});assert.equal(s.providerCalls,0);assert.equal((await s.db.query('select count(*)::int n from crm_welcome_ledger')).rows[0].n,0);
}));
