import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {createCrmWelcomeStatusReader} from './crmWelcomeStatus.js';
import {createCrmAdminService} from './crmAdmin.js';

const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const origin='web_form:Consulta Padbol · Quiero una cancha Padbol';
const row=n=>({id:id(n),contact_id:id(n+1000),source_channel:'email',origin,estado:'nuevo'});
async function fixture() {
  const db=new PGlite();let queries=0,lastScope;
  await db.exec(`create table crm_conversations(id uuid primary key,contact_id uuid,source_channel text,origin text,test_hidden_at timestamptz,email_return_linked_to uuid);
    create table crm_welcome_ledger(contact_id uuid,purpose text,status text,accepted_at timestamptz,provider_key text,provider_message_id text);
    create table crm_inbound_events(conversation_id uuid,source_channel text,origin text,source_ref text,received_at timestamptz);`);
  const pool={query(sql,args){queries++;lastScope=JSON.parse(args[0]);return db.query(sql,args);}};
  const reader=createCrmWelcomeStatusReader({pool});
  const insert=async(r,status=null)=>{
    await db.query('insert into crm_conversations(id,contact_id,source_channel,origin,test_hidden_at,email_return_linked_to) values($1,$2,$3,$4,$5,$6)',[r.id,r.contact_id,r.source_channel,r.origin,r.test_hidden_at || null,r.email_return_linked_to || null]);
    if(status) await db.query("insert into crm_welcome_ledger values($1,'welcome',$2,$3,'private-key','private-provider-id')",[r.contact_id,status,status==='accepted'?'2026-11-12T10:00:00Z':null]);
  };
  const inbound=(r,at,{eventOrigin=origin,ref='form:replay',channel='email'}={})=>db.query('insert into crm_inbound_events values($1,$2,$3,$4,$5)',[r.id,channel,eventOrigin,ref,at]);
  return {db,reader,insert,inbound,count:()=>queries,scope:()=>lastScope,close:()=>db.close()};
}

test('private projection distinguishes missing, claimed, accepted and incidents without exposing provider identities',async()=>{
  const f=await fixture();try {
    const rows=[1,2,3,4,5,6].map(row);
    for(const [i,status] of [null,'claimed','accepted','uncertain','rejected','future-status'].entries()) await f.insert(rows[i],status);
    const statuses=await f.reader(rows);
    assert.deepEqual(rows.map(r=>statuses.get(r.id).status),['not_recorded','processing','sent','needs_review','needs_review','needs_review']);
    assert.deepEqual(statuses.get(rows[2].id),{status:'sent',sent_at:'2026-11-12T10:00:00.000Z',response_state:'no_reply_registered',response_at:null});
    for(const value of statuses.values()) assert.deepEqual(Object.keys(value).sort(),['response_at','response_state','sent_at','status']);
    assert.equal(JSON.stringify([...statuses.values()]).includes('private'),false);assert.equal(f.count(),1);
  } finally {await f.close();}
});

test('only actual mail after acceptance in the authorized conversation counts as a reply',async()=>{
  const f=await fixture();try {
    const current=row(1),privateSameContact={...row(2),contact_id:current.contact_id,origin:'support_email'};
    await f.insert(current,'accepted');await f.insert(privateSameContact);
    await f.inbound(current,'2026-11-12T11:00:00Z'); // new form replay, not a mail reply
    await f.inbound(privateSameContact,'2026-11-12T12:00:00Z',{eventOrigin:'institutional_email',ref:'private-message'});
    await f.inbound(current,'2026-11-12T09:59:59Z',{ref:'email-message:before'});
    await f.inbound(current,'2026-11-12T10:00:00Z',{ref:'email-message:equal'});
    assert.equal((await f.reader([current])).get(current.id).response_state,'no_reply_registered');
    await f.inbound(current,'2026-11-12T10:01:00Z',{ref:'email-message:actual-correlated-reply'});
    let state=(await f.reader([current])).get(current.id);
    assert.equal(state.response_state,'reply_received');assert.equal(state.response_at,'2026-11-12T10:01:00.000Z');
    await f.inbound(current,'2026-11-12T10:02:00Z',{eventOrigin:'institutional_email',ref:'actual-rfc-message-id'});
    state=(await f.reader([current])).get(current.id);assert.equal(state.response_at,'2026-11-12T10:02:00.000Z');
    assert.deepEqual(f.scope().map(x=>x.id),[current.id]);
  } finally {await f.close();}
});

test('support, WhatsApp, hidden and linked records perform no welcome query; changed scope fails closed',async()=>{
  const f=await fixture();try {
    const excluded=[{...row(1),origin:'support_email'},{...row(2),source_channel:'whatsapp'},{...row(3),test_hidden_at:'2026-11-12T10:00:00Z'},{...row(4),email_return_linked_to:id(99)}];
    assert.equal((await f.reader(excluded)).size,0);assert.equal(f.count(),0);
    const approved=row(5);await f.insert({...approved,origin:'support_email'},'accepted');
    assert.equal((await f.reader([approved])).get(approved.id).status,'unavailable','do not project a conversation that moved out of authorized origin');
  } finally {await f.close();}
});

test('projection is bounded to 200 approved IDs in one query and errors never fabricate a send',async()=>{
  let calls=0,size;
  const reader=createCrmWelcomeStatusReader({pool:{async query(sql,args){calls++;size=JSON.parse(args[0]).length;throw Error('private connection error');}}});
  const statuses=await reader(Array.from({length:240},(_,i)=>row(i+1)));
  assert.equal(calls,1);assert.equal(size,200);assert.equal(statuses.size,200);assert.ok([...statuses.values()].every(x=>x.status==='unavailable'));
});

const allowed={email:'advisor@example.test',role:'operator',userId:id(900)};
function admin({rows=[row(1)],conversation=rows[0],canRead=true,commercialOnly=false,reader=async()=>new Map()}={}) {
  let repoCalls=0,projectionCalls=0,projected;
  const service=createCrmAdminService({repository:{async listConversations(){repoCalls++;return rows;},async getConversation(){repoCalls++;return conversation;}},
    resolvePermissions:()=>({canOperate:canRead,canAudit:canRead,commercialOnly}),
    readCommercialWelcomeStatuses:async selected=>{projectionCalls++;projected=selected;return reader(selected);}});
  return {service,repoCalls:()=>repoCalls,projectionCalls:()=>projectionCalls,projected:()=>projected};
}

test('private admin checks role and conversation scope before projection; support and wrong-scope cannot query ledger',async()=>{
  const denied=admin({canRead:false});await assert.rejects(denied.service.listInbox(allowed),{status:403});assert.equal(denied.repoCalls(),0);assert.equal(denied.projectionCalls(),0);
  const wrong=admin({commercialOnly:true,conversation:{...row(2),origin:'support_email'}});
  await assert.rejects(wrong.service.getInbox({...allowed,id:id(2)}),{status:404});assert.equal(wrong.projectionCalls(),0);
  const support=admin({rows:[{...row(1),origin:'support_email'}]});const list=await support.service.listInbox(allowed);assert.equal(support.projectionCalls(),0);assert.equal('commercial_welcome' in list[0],false);
});

test('authorized list/detail add the same minimal DTO without changing assignment/state and degrade safely',async()=>{
  const commercial={...row(1),operador:'assigned-advisor'},support={...row(2),origin:'support_email'};
  const dto={status:'sent',sent_at:'2026-11-12T10:00:00.000Z',response_state:'no_reply_registered',response_at:null};
  const f=admin({rows:[commercial,support],reader:async selected=>new Map(selected.map(x=>[x.id,dto]))});
  const listed=await f.service.listInbox(allowed);assert.deepEqual(f.projected().map(x=>x.id),[commercial.id]);
  assert.deepEqual(listed[0].commercial_welcome,dto);assert.equal(listed[0].estado,'nuevo');assert.equal(listed[0].operador,'assigned-advisor');assert.equal('commercial_welcome' in listed[1],false);
  const detail=await f.service.getInbox({...allowed,id:commercial.id});assert.deepEqual(detail.commercial_welcome,dto);
  const failed=admin({reader:async()=>{throw Error('read failure');}});
  assert.equal((await failed.service.listInbox(allowed))[0].commercial_welcome.status,'unavailable');
  assert.equal((await failed.service.getInbox({...allowed,id:id(1)})).commercial_welcome.status,'unavailable');
});
