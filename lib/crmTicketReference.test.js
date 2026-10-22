import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createCrmAdminService, ticketReferenceFromId, conversationIdFromTicketReference } from './crmAdmin.js';
import { createSupabaseCrmRepository } from './crmService.js';
import { CRM_COMMERCIAL_OPERATORS, CRM_COMMERCIAL_FORM_ORIGINS } from './crmCommercialScope.js';

test('reference bijectively preserves UUID uniqueness and canonicalizes case', () => {
  const ids = Array.from({length: 10000}, () => randomUUID());
  const refs = ids.map(ticketReferenceFromId);
  assert.equal(new Set(refs).size, ids.length);
  ids.forEach((id, i) => assert.equal(conversationIdFromTicketReference(refs[i].toLowerCase()), id));
  assert.throws(() => conversationIdFromTicketReference('PB-123'), e => e.status === 400);
});

test('exact lookup applies UUID server-side, including scope and other filters', async () => {
  const calls=[];
  const builder={ select(){return this},order(){return this},limit(){return this},eq(k,v){calls.push([k,v]);return this},in(k,v){calls.push([k,v]);return this},then(resolve){resolve({data:[],error:null})} };
  const repo=createSupabaseCrmRepository({from:()=>builder});
  await repo.listConversations({conversationId:'00000000-0000-4000-8000-000000000001',sourceChannel:'email',estado:'nuevo',origins:['web_form:contacto']});
  assert.deepEqual(calls,[['id','00000000-0000-4000-8000-000000000001'],['source_channel','email'],['origin',['web_form:contacto']],['estado','nuevo']]);
});

test('lookup requires reader, scopes commercial user and never returns other conversations', async () => {
  const actor={email:CRM_COMMERCIAL_OPERATORS[0].email,userId:CRM_COMMERCIAL_OPERATORS[0].userId,role:'admin_nacional'};
  const id='00000000-0000-4000-8000-000000000001';const ref=ticketReferenceFromId(id);let filters;
  const lead={id,source_channel:'email',origin:CRM_COMMERCIAL_FORM_ORIGINS[0],qualification_data:{routing:{workflow:'commercial_lead'}}};
  const other={...lead,id:'00000000-0000-4000-8000-000000000002',source_channel:'whatsapp'};
  const repo={listConversations:async f=>{filters=f;return [lead,other]},getConversation:async()=>lead};
  const svc=createCrmAdminService({repository:repo,commercialOperators:CRM_COMMERCIAL_OPERATORS});
  await assert.rejects(()=>svc.listInbox({email:'outsider@example.test',role:'none',filters:{ticketReference:ref}}),e=>e.status===403);
  const result=await svc.listInbox({...actor,filters:{ticketReference:ref,estado:'nuevo'}});
  assert.equal(filters.conversationId,id);assert.equal(filters.sourceChannel,'email');assert.equal(filters.estado,'nuevo');assert.equal(result.length,1);assert.equal(result[0].ticket_reference,ref);
  assert.equal((await svc.getInbox({...actor,id})).ticket_reference,ref);
  await assert.rejects(()=>svc.listInbox({...actor,filters:{ticketReference:'invalid'}}),e=>e.status===400);
});

test('short reference is searchable with server-side role and scope, while legacy remains valid', async () => {
  const actor={email:CRM_COMMERCIAL_OPERATORS[0].email,userId:CRM_COMMERCIAL_OPERATORS[0].userId,role:'admin_nacional'};
  let filters;const row={id:'00000000-0000-4000-8000-000000000001',ticket_number:100000,source_channel:'email',origin:CRM_COMMERCIAL_FORM_ORIGINS[0],qualification_data:{routing:{workflow:'commercial_lead'}}};
  const repo={listConversations:async f=>(filters=f,[row])};const svc=createCrmAdminService({repository:repo,commercialOperators:CRM_COMMERCIAL_OPERATORS});
  const result=await svc.listInbox({...actor,filters:{ticketReference:'pb-100000'}});
  assert.equal(filters.ticketNumber,'100000');assert.equal(filters.sourceChannel,'email');
  assert.equal(result[0].short_ticket_reference,'PB-100000');assert.equal(result[0].ticket_reference,ticketReferenceFromId(row.id));
  await assert.rejects(()=>svc.listInbox({...actor,filters:{ticketReference:'PB-000001'}}),e=>e.status===400);
});

test('database assigns durable unique short numbers to old and new rows', async () => {
  const { PGlite }=await import('@electric-sql/pglite');const {readFile}=await import('node:fs/promises');const db=new PGlite();
  try {
    await db.exec('create table public.crm_conversations (id uuid primary key default gen_random_uuid()); insert into public.crm_conversations default values; insert into public.crm_conversations default values;');
    await db.exec(await readFile('sql/migrations/20261022200000_crm_short_ticket_number.sql','utf8'));
    await db.exec('insert into public.crm_conversations default values;');
    const values=(await db.query('select ticket_number from public.crm_conversations order by ticket_number')).rows.map(r=>Number(r.ticket_number));
    assert.deepEqual(values,[100000,100001,100002]);
    await assert.rejects(db.exec('insert into public.crm_conversations(ticket_number) values (100000)'));
    await db.exec('delete from public.crm_conversations where ticket_number=100002; insert into public.crm_conversations default values;');
    assert.equal(Number((await db.query('select max(ticket_number) as max from public.crm_conversations')).rows[0].max),100003);
  } finally {await db.close();}
});
