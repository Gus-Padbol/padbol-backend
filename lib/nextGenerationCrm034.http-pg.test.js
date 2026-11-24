import test from 'node:test';
import assert from 'node:assert/strict';
import {start,SID,SIDB,R2,R3} from './nextGenerationUuid026.fixture.mjs';
const conversation='03400000-0000-4000-8000-000000000001';
const foreignConversation='03400000-0000-4000-8000-000000000002';
const registration={conversation_id:conversation,sede_id:1,sesion_id:SID,categoria:'Sub-14',participants:[{nombre:'Synthetic applicant',categoria:'Sub-14'}]};
const venue={conversation_id:conversation,sede_club:'Synthetic venue',ciudad:'City',pais:'AR'};
const regPath='/api/admin/next-generation/registrations/from-crm';
const venuePath='/api/admin/next-generation/venue-applications/from-crm';
const snapshot=async f=>(await f.pool.query("SELECT * FROM (SELECT 'registrations' kind,to_jsonb(i) row FROM ng_inscripciones i UNION ALL SELECT 'participants',to_jsonb(p) FROM ng_inscripcion_participantes p UNION ALL SELECT 'events',to_jsonb(e) FROM ng_inscripcion_eventos e UNION ALL SELECT 'requests',to_jsonb(v) FROM ng_solicitudes_sede v) snapshot_rows ORDER BY kind,row::text")).rows;
const noWrites=f=>assert.deepEqual(f.state.trace.filter(q=>q.action!=='read'),[]);

test('034 preserves auth, PP permission and payload checks before queries', {timeout:20000},async()=>{
 let f;try{f=await start();const before=await snapshot(f);
 assert.equal((await f.call(null,'POST',regPath,registration)).status,401);
 assert.equal((await f.call('b','POST',regPath,registration)).status,403);
 assert.equal((await f.call('a','POST',venuePath,venue)).status,403);
 assert.equal((await f.call('a','POST',regPath,{})).status,400);
 assert.equal((await f.call('super','POST',venuePath,{})).status,400);
 assert.equal(f.state.trace.length,0);assert.deepEqual(await snapshot(f),before);
 }finally{await f?.stop();}
});

test('034 new CRM requests return actionable409 without changing any NG rows', {timeout:20000},async()=>{
 let f;try{f=await start();const before=await snapshot(f);
 const r=await f.call('a','POST',regPath,registration);assert.equal(r.status,409);assert.equal(r.body.code,'NG_CRM_REGISTRATION_REQUIRES_FORM');assert.match(r.body.error,/familia.*formulario/i);assert.match(r.body.error,/no crea.*ni reserva/i);
 const v=await f.call('super','POST',venuePath,venue);assert.equal(v.status,409);assert.equal(v.body.code,'NG_CRM_VENUE_REQUIRES_FORM');assert.match(v.body.error,/formulario de adhesión/);
 assert.deepEqual(f.state.trace.map(q=>[q.table,q.action]),[['ng_inscripciones','read']]);noWrites(f);assert.deepEqual(await snapshot(f),before);
 console.log('REAL_HTTP_034',JSON.stringify({registration:r.status,venue:v.status,queries:f.state.trace.length,writes:0}));
 }finally{await f?.stop();}
});

test('034 legitimate replay survives and foreign PP replay returns403 with no contact data', {timeout:20000},async()=>{
 let f;try{f=await start();await f.pool.query('INSERT INTO crm_conversations(id) VALUES($1),($2)',[conversation,foreignConversation]);
 await f.pool.query('UPDATE ng_inscripciones SET crm_conversation_id=$1 WHERE id=$2',[conversation,R2]);await f.registration(R3,SIDB,2);
 await f.pool.query('UPDATE ng_inscripciones SET crm_conversation_id=$1 WHERE id=$2',[foreignConversation,R3]);const before=await snapshot(f);
 const own=await f.call('a','POST',regPath,registration);assert.equal(own.status,200);assert.equal(own.body.created,false);assert.equal(own.body.registration.id,R2);
 const other=await f.call('a','POST',regPath,{...registration,conversation_id:foreignConversation});assert.equal(other.status,403);assert.equal(other.body.code,'NG_ADMIN_FORBIDDEN');assert.equal(other.body.registration,undefined);assert.ok(!JSON.stringify(other.body).includes('fixture@example.invalid'));
 const root=await f.call('super','POST',regPath,{...registration,conversation_id:foreignConversation});assert.equal(root.status,200);assert.equal(root.body.created,false);assert.equal(root.body.registration.id,R3);
 noWrites(f);assert.deepEqual(await snapshot(f),before);
 }finally{await f?.stop();}
});
