import {readFile} from 'node:fs/promises';import {pathToFileURL} from 'node:url';import assert from 'node:assert/strict';
const {PGlite}=await import(pathToFileURL(process.env.PADBOL_PGLITE_MODULE).href);const db=new PGlite();const read=p=>readFile(p,'utf8');
try{
 await db.exec('create role anon;create role authenticated;create role service_role;create table public.sedes(id bigint primary key);');
 for(const p of ['sql/20260915000000_crm_unified_inbox.sql','sql/20260916000000_crm_inbound_content.sql','sql/20260917000000_crm_operational_history_and_inbound_events.sql','docs/sql/support_tickets_migration.sql','sql/migrations/20261022200000_crm_short_ticket_number.sql','sql/candidates/crm_support_preparation.sql'])await db.exec(await read(p));
 await db.exec(await read('sql/candidates/crm_support_preparation.sql'));
 const contact='10000000-0000-4000-8000-000000000001',c='20000000-0000-4000-8000-000000000001',other='20000000-0000-4000-8000-000000000002',e='30000000-0000-4000-8000-000000000001',actor='40000000-0000-4000-8000-000000000001',requester='50000000-0000-4000-8000-000000000001';
 await db.query("insert into crm_contacts(id,email_normalized)values($1,'qa@example.invalid')",[contact]);
 for(const id of [c,other])await db.query("insert into crm_conversations(id,contact_id,source_channel,source_ref,attempt_id,origin,received_at,qualification_data)values($1,$2,'email',$3,$3,'support_email',now(),'{\"mailbox\":{\"address\":\"support@padbol.com\"}}')",[id,contact,id]);
 await db.query("insert into crm_inbound_events(id,conversation_id,source_channel,source_ref,origin,body,received_at)values($1,$2,'email','qa-event','support_email','consulta ficticia',now())",[e,c]);
 const run=(ticket=null,uid=null,sede=null,conv=c)=>db.query('select crm_prepare_support_event($1,$2,$3,$4,$5,$6) as v',[conv,e,actor,ticket,uid,sede]);
 const first=(await run()).rows[0].v;assert.equal(first.preparationState,'identity_required');assert.equal(first.ticketId,null);assert.equal(first.sendEnabled,false);
 await Promise.all([run(),run()]);assert.equal((await db.query('select count(*)::int n from crm_support_preparation_jobs')).rows[0].n,1);assert.equal((await db.query('select count(*)::int n from support_tickets')).rows[0].n,0);
 await assert.rejects(()=>run(null,null,null,other),/SUPPORT_EVENT_MISMATCH/);
 // Defensa ante esquema legado/relajado: la base exacta es NOT NULL; se relaja solo en esta prueba.
 await assert.rejects(()=>db.query('update crm_inbound_events set conversation_id=null where id=$1',[e]),/not-null/);await db.exec('alter table crm_inbound_events alter column conversation_id drop not null');await db.query('update crm_inbound_events set conversation_id=null where id=$1',[e]);await assert.rejects(()=>run(),/SUPPORT_EVENT_MISMATCH/);await db.query('update crm_inbound_events set conversation_id=$1 where id=$2',[c,e]);await db.exec('alter table crm_inbound_events alter column conversation_id set not null');
 await db.exec("insert into sedes(id)values(1),(2)");
 const tid=(await db.query("insert into support_tickets(requester_user_id,sede_id,categoria,asunto)values($1,1,'tecnico','Prueba QA')returning id",[requester])).rows[0].id;
 await assert.rejects(()=>run(tid,actor,1),/SUPPORT_TICKET_SCOPE_MISMATCH/);await assert.rejects(()=>run(tid,requester,2),/SUPPORT_TICKET_SCOPE_MISMATCH/);await assert.rejects(()=>run(tid,null,1),/SUPPORT_VERIFIED_IDENTITY_REQUIRED/);
 assert.equal((await run()).rows[0].v.ticketId,null);
 const linked=(await run(tid,requester,1)).rows[0].v;assert.equal(linked.preparationState,'prepared');assert.equal(linked.assignedArea,'tecnica');await run(tid,requester,1);assert.equal((await db.query('select count(*)::int n from support_tickets')).rows[0].n,1);assert.equal((await db.query('select count(*)::int n from support_ticket_messages')).rows[0].n,0);
 const grants=(await db.query("select has_function_privilege('authenticated','crm_prepare_support_event(uuid,uuid,uuid,bigint,uuid,bigint)','EXECUTE') as client,has_function_privilege('service_role','crm_prepare_support_event(uuid,uuid,uuid,bigint,uuid,bigint)','EXECUTE') as service,has_table_privilege('service_role','crm_support_links','INSERT') as direct_write")).rows[0];assert.deepEqual(grants,{client:false,service:true,direct_write:false});
 console.log('PASS: SQL base real, migración repetible, replay/concurrencia serializada, sin dueño falso, aislamiento requester/sede, recuperación posterior, sin mensajes y permisos mínimos');
}finally{await db.close()}
