import test from 'node:test';import assert from 'node:assert/strict';import {readFile}from'node:fs/promises';import{PGlite}from'@electric-sql/pglite';
import{extractWhatsappDeliveryReceipts,createWhatsappDeliveryHandler}from'./whatsappDeliveryReceipts.js';import{createWhatsappCloudService}from'./whatsappCloud.js';
const time=new Date('2026-10-30T12:00:00Z'),at='2026-10-30T11:59:00Z',ts=String(Date.parse(at)/1000);
const payload=(overrides={})=>({object:'whatsapp_business_account',entry:[{id:'928900479733370',changes:[{field:'messages',value:{metadata:{phone_number_id:'1376102838911694'},statuses:[{id:'wamid.test',status:'delivered',recipient_id:'15551234567',timestamp:ts,...overrides}]}}]}]});
test('receipt parser preserves only delivery evidence and validates values',()=>{
 const [r]=extractWhatsappDeliveryReceipts(payload({pricing:{secret:'not-kept'},errors:[{code:131047,message:'private'}]}),time);
 assert.equal(r.status,'delivered');assert.equal(r.errorCode,null);assert.ok(!JSON.stringify(r).includes('private'));
 for(const x of [{id:'invalid'},{status:'unknown'},{recipient_id:'bad'},{timestamp:'9999999999'}])assert.equal(extractWhatsappDeliveryReceipts(payload(x),time).length,0);
 assert.equal(extractWhatsappDeliveryReceipts(payload({status:'failed',errors:[{code:131047}]}),time)[0].errorCode,131047);
});
test('signed webhook service records status-only callbacks without any sender or inbound effects',async()=>{
 let count=0;const service=createWhatsappCloudService({repository:{},now:()=>time,onDeliveryReceipt:async r=>{assert.equal(r.providerMessageId,'wamid.test');count++},sender:{send(){throw Error('must not send')}}});
 const result=await service.handleWebhook(payload());assert.equal(result.received,0);assert.equal(count,1);
 const broken=createWhatsappCloudService({repository:{},now:()=>time,onDeliveryReceipt:async()=>{throw Error('store unavailable')}});await assert.rejects(broken.handleWebhook(payload()),/store unavailable/);
});
test('storage handler forwards exact evidence and fails on persistence errors',async()=>{
 let args;await createWhatsappDeliveryHandler({rpc:async(name,value)=>{assert.equal(name,'whatsapp_record_delivery_receipt');args=value;return{error:null}}})(extractWhatsappDeliveryReceipts(payload(),time)[0]);assert.equal(args.p_provider,'wamid.test');
 await assert.rejects(createWhatsappDeliveryHandler({rpc:async()=>({error:{message:'secret'}})})(extractWhatsappDeliveryReceipts(payload(),time)[0]),{code:'WHATSAPP_RECEIPT_STORE_FAILED'});
});
test('SQL isolates tenants/recipients, is replay-safe, retains facts in reverse order and excludes client access',async()=>{
 const db=new PGlite();const tenant='11111111-1111-4111-8111-111111111111',channel='22222222-2222-4222-8222-222222222222',contact='33333333-3333-4333-8333-333333333333',conv='44444444-4444-4444-8444-444444444444',reply='55555555-5555-4555-8555-555555555555';
 try{
 await db.exec(`create role anon;create role authenticated;create role service_role;
 create table whatsapp_tenants(id uuid primary key,status text);
 create table whatsapp_tenant_channels(id uuid primary key,tenant_id uuid,meta_phone_number_id text,meta_waba_id text,active boolean,unique(tenant_id,id));
 create table crm_contacts(id uuid primary key,phone_normalized text);
 create table crm_conversations(id uuid primary key,contact_id uuid,source_channel text,origin text);
 create table crm_replies(id uuid primary key,conversation_id uuid,provider_message_id text,status text);
 insert into whatsapp_tenants values('${tenant}','active');insert into whatsapp_tenant_channels values('${channel}','${tenant}','1376102838911694','928900479733370',true);
 insert into crm_contacts values('${contact}','+15551234567');insert into crm_conversations values('${conv}','${contact}','whatsapp','whatsapp:1376102838911694');`);
 await db.exec(await readFile('sql/migrations/20261030120000_whatsapp_delivery_receipts.sql','utf8'));
 const record=async(status,recipient='15551234567',waba='928900479733370')=>db.query('select whatsapp_record_delivery_receipt($1,$2,$3,$4,$5,now(),$6) ok',['1376102838911694',waba,'wamid.test',recipient,status,status==='failed'?131047:null]);
 assert.equal((await record('read')).rows[0].ok,true);await record('read');await record('delivered');await record('sent');await record('failed');await record('failed','19999999999');assert.equal((await record('failed','15551234567','99999999999')).rows[0].ok,false);
 await db.exec(`insert into crm_replies values('${reply}','${conv}','wamid.test','sent');`);
 let summary=(await db.query('select crm_whatsapp_delivery_summary($1) data',[conv])).rows[0].data;assert.equal(summary.length,1);assert.equal(summary[0].deliveryStatus,'read');assert.ok(!JSON.stringify(summary).includes('wamid'));
 await db.exec(`update crm_contacts set phone_normalized='+19911111111';`);assert.deepEqual((await db.query('select crm_whatsapp_delivery_summary($1) data',[conv])).rows[0].data,[]);
 await db.exec('set role authenticated');await assert.rejects(db.query('select * from whatsapp_delivery_receipts'),/permission denied/);await assert.rejects(db.query('select crm_whatsapp_delivery_summary($1)',[conv]),/permission denied/);await db.exec('reset role');
 assert.equal((await db.query('select status from crm_replies')).rows[0].status,'sent');
 }finally{await db.close()}
});
