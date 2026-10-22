import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
const db = new PGlite();
await db.exec(`create role anon; create role authenticated; create role service_role;
create table whatsapp_tenant_channels(id uuid primary key,tenant_id uuid,meta_phone_number_id text);
create table whatsapp_inbound_messages(id uuid primary key,tenant_id uuid,channel_id uuid,provider_message_id text,from_wa_id text,received_at timestamptz,created_at timestamptz default now());
create table crm_conversations(id uuid primary key,source_channel text,updated_at timestamptz,funnel_state text,selected_path text,qualification_data jsonb,qualification_question_count int,qualification_status text,next_prompt text,prompt_options jsonb,next_step text,handoff_ready boolean, constraint crm_conversations_handoff_ready_check check (not handoff_ready or qualification_status = 'qualified'));
create table crm_inbound_events(id uuid primary key default gen_random_uuid(),conversation_id uuid,source_channel text,source_ref text,origin text);
create table crm_replies(id uuid primary key default gen_random_uuid(),conversation_id uuid,body text,operador text,status text);
create table whatsapp_outbox(id uuid primary key default gen_random_uuid(),tenant_id uuid,channel_id uuid,inbound_message_id uuid,idempotency_key text unique,to_wa_id text,reply_to_provider_message_id text,message_type text,text_body text,status text,customer_service_window_expires_at timestamptz,provider_message_id text,sent_at timestamptz,last_error text,updated_at timestamptz);
`);
await db.exec(await readFile('sql/20261022100000_whatsapp_menu_atomic_candidate.sql','utf8'));
const id = ['11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222','33333333-3333-4333-8333-333333333333','44444444-4444-4444-8444-444444444444','55555555-5555-4555-8555-555555555555'];
const [tenant,channel,inbound,conv,inbound2] = id;
await db.query('insert into whatsapp_tenant_channels values($1,$2,$3)',[channel,tenant,'1376102838911694']);
await db.query('insert into whatsapp_inbound_messages(id,tenant_id,channel_id,provider_message_id,from_wa_id,received_at) values($1,$2,$3,$4,$5,now()),($6,$2,$3,$7,$5,now())',[inbound,tenant,channel,'wamid.first','15551234567',inbound2,'wamid.second']);
await db.query("insert into crm_conversations(id,source_channel,updated_at) values($1,'whatsapp','2026-10-21T12:00:00Z')",[conv]);
await db.query("insert into crm_inbound_events(conversation_id,source_channel,source_ref,origin) values($1,'whatsapp','wamid.first','whatsapp:1376102838911694'),($1,'whatsapp','wamid.second','whatsapp:1376102838911694')",[conv]);
const state={funnel_state:'whatsapp_menu_topic',qualification_data:{whatsapp_menu:{stage:'topic'}},qualification_status:'pending',prompt_options:[],next_prompt:'Elige una opción'};
const q='select crm_commit_whatsapp_menu_transition($1,$2,$3,$4,$5,$6) as result';
const args=[inbound,conv,'2026-10-21T12:00:00Z',JSON.stringify(state),'Bienvenido', 'a'.repeat(64)];
const concurrent = await Promise.all([db.query(q,args), db.query(q,args)]);
const first=concurrent.map(r=>r.rows[0].result).find(r=>r.created);
const replay=concurrent.map(r=>r.rows[0].result).find(r=>!r.created);
assert.ok(first);assert.ok(replay);assert.equal(replay.outbox_id,first.outbox_id);
for(const table of ['crm_replies','whatsapp_outbox','crm_whatsapp_menu_events']) assert.equal((await db.query(`select count(*)::int as n from ${table}`)).rows[0].n,1);
const revision=(await db.query('select updated_at from crm_conversations where id=$1',[conv])).rows[0].updated_at;
await assert.rejects(db.query(q,[inbound2,conv,revision,JSON.stringify({...state, funnel_state:'different'}),'Otro','a'.repeat(64)]));
assert.equal((await db.query('select funnel_state from crm_conversations where id=$1',[conv])).rows[0].funnel_state,'whatsapp_menu_topic');
assert.equal((await db.query('select count(*)::int as n from crm_replies')).rows[0].n,1);
await assert.rejects(db.query(q,[inbound2,conv,'2026-10-21T12:00:00Z',JSON.stringify(state),'Otro','b'.repeat(64)]));
// The deployed CRM requires a qualified status for handoff_ready. Human
// requests stay needs_review, routed via next_step, without violating it.
const handoff = {...state, funnel_state:'whatsapp_menu_selected', qualification_status:'needs_review',
  next_step:'advisor_handoff', handoff_ready:true};
await assert.rejects(db.query(q,[inbound2,conv,revision,JSON.stringify(handoff),'Advisor', 'c'.repeat(64)]));
assert.equal((await db.query('select count(*)::int as n from crm_whatsapp_menu_events')).rows[0].n,1);
handoff.handoff_ready = false;
const routed = (await db.query(q,[inbound2,conv,revision,JSON.stringify(handoff),'Advisor', 'c'.repeat(64)])).rows[0].result;
assert.equal(routed.created,true);
assert.deepEqual((await db.query('select qualification_status,next_step,handoff_ready from crm_conversations where id=$1',[conv])).rows[0],
  {qualification_status:'needs_review',next_step:'advisor_handoff',handoff_ready:false});
await db.query("update whatsapp_outbox set status='sending' where id=$1",[first.outbox_id]);
await db.query('select crm_confirm_whatsapp_menu_sent($1,$2,$3,now())',[first.outbox_id,tenant,'wamid.sent']);
assert.equal((await db.query('select status from crm_replies where id=$1',[first.reply_id])).rows[0].status,'sent');
assert.equal((await db.query('select provider_message_id from whatsapp_outbox where id=$1',[first.outbox_id])).rows[0].provider_message_id,'wamid.sent');
console.log('Atomic transition: replay, stale revision and rollback verified in PGlite.');
await db.close();
