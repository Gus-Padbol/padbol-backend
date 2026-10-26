import test from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';import {PGlite} from '@electric-sql/pglite';
test('durable queue only discovers accepted, consented, visible commercial forms after activation; verified inbound uniquely links',async()=>{
 const db=new PGlite();try{await db.exec(`create role anon;create role authenticated;create role service_role;
 create table crm_contacts(id uuid primary key,nombre text);
 create table crm_conversations(id uuid primary key,contact_id uuid,source_channel text,origin text,qualification_data jsonb,estado text,identity_used text,test_hidden_at timestamptz,created_at timestamptz default now());
 create function crm_commercial_form_is_allowed(p_id uuid) returns boolean language sql as $$select exists(select 1 from crm_conversations where id=p_id and origin='web_form:contact')$$;
 create table crm_inbound_events(conversation_id uuid,source_channel text,origin text,source_ref text);`);
 await db.exec(await readFile('sql/migrations/20261026190000_crm_welcome_dispatch.sql','utf8'));
 const lead='11111111-1111-4111-8111-111111111111',contact='22222222-2222-4222-8222-222222222222',wa='33333333-3333-4333-8333-333333333333';
 const consent={accepted:true,version:'contacto-whatsapp-consulta-v1',purpose:'consultation_followup',phone:'+5492213032019',language:'en',acceptedAt:'2026-10-26T00:00:00Z'};
 await db.query('insert into crm_contacts values($1,$2)',[contact,'Fixture']);await db.query("insert into crm_conversations(id,contact_id,source_channel,origin,qualification_data,created_at) values($1,$2,'email','web_form:contact',$3,'2026-10-26')",[lead,contact,{whatsapp_contact_consent:consent}]);
 assert.equal((await db.query("select * from crm_list_welcome_pending_candidate(20,'2026-10-25')")).rows.length,1);
 assert.equal((await db.query("select * from crm_list_welcome_pending_candidate(20,'2026-10-27')")).rows.length,0);
 await db.query('update crm_conversations set test_hidden_at=now() where id=$1',[lead]);assert.equal((await db.query("select * from crm_list_welcome_pending_candidate(20,'2026-10-25')")).rows.length,0);
 await db.query('update crm_conversations set test_hidden_at=null where id=$1',[lead]);await db.query("select crm_claim_welcome_candidate($1,$2,$3)",[lead,consent.phone,consent.version]);
 assert.equal((await db.query("select * from crm_list_welcome_pending_candidate(20,'2026-10-25')")).rows.length,0);
 await db.query("update crm_welcome_dispatch_candidate set status='accepted' where conversation_id=$1",[lead]);
 await db.query("insert into crm_conversations(id,source_channel,origin,identity_used) values($1,'whatsapp','whatsapp:1376102838911694','5492213032019')",[wa]);
 let r=await db.query('select crm_link_welcome_verified_inbound_candidate($1,$2,$3) value',[wa,consent.phone,'wamid.fixture']);assert.equal(r.rows[0].value.status,'unverified_event');
 await db.query("insert into crm_inbound_events values($1,'whatsapp','whatsapp:1376102838911694','wamid.fixture')",[wa]);
 r=await db.query('select crm_link_welcome_verified_inbound_candidate($1,$2,$3) value',[wa,consent.phone,'wamid.fixture']);assert.equal(r.rows[0].value.status,'linked');assert.equal(r.rows[0].value.language,'en');
 await db.query('select crm_revoke_welcome_candidate($1)',[lead]);r=await db.query('select crm_link_welcome_verified_inbound_candidate($1,$2,$3) value',[wa,consent.phone,'wamid.fixture']);assert.equal(r.rows[0].value.status,'no_match');
 }finally{await db.close()}
});
