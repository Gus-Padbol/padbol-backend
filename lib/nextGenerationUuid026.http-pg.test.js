import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
import {start,catalog,SID,SID2,SIDB,SIDNULL,VA,VB,VN,R1,R2,R3,bounded} from './nextGenerationUuid026.fixture.mjs';
const before=process.env.NG026_BEFORE==='1';const patchUrl='/api/admin/next-generation/sessions/'+SID;
test('026 before/after actual QA confirmation no longer compares UUID venue to canonical bigint',{timeout:20000},async()=>{
 let f;try{f=await start({install:!before});const r=await f.call('a','POST','/api/admin/next-generation/registrations/'+R2+'/confirm',{});console.log('REAL_QA_CONFIRM',JSON.stringify({status:r.status,sqlErrors:f.state.rpcErrors}));assert.equal(r.status,200);assert.equal(r.body.registration.estado,'confirmada');}finally{await f?.stop();}
});
test('026 before/after actual event CHECK accepts existing emitter labels without rewriting old rows',{timeout:20000},async()=>{
 let f;try{f=await start({install:!before});try{await f.pool.query("INSERT INTO ng_inscripcion_eventos(inscripcion_id,sesion_id,tipo,actor) VALUES($1,$2,'confirmada','fixture')",[R1,SID]);}catch(e){console.log('REAL_QA_EVENT_CODE',e.code);throw e;}
 assert.deepEqual((await f.pool.query('SELECT row_to_json(e) row FROM ng_inscripcion_eventos e WHERE id=$1',[f.preservedEvent.id])).rows[0].row,f.preservedEvent);
 await assert.rejects(f.pool.query("INSERT INTO ng_inscripcion_eventos(inscripcion_id,sesion_id,tipo,actor) VALUES($1,$2,'invented-label','fixture')",[R1,SID]),e=>e.code==='23514');}finally{await f?.stop();}
});
test('026 fixture matches every catalog column/default/null/identity and initial constraint/index footprint',{timeout:20000},async()=>{
 let f;try{f=await start({install:false});const rows=(await f.pool.query("SELECT c.relname table,a.attname column,format_type(a.atttypid,a.atttypmod) type,a.attnotnull not_null,a.attidentity identity,pg_get_expr(d.adbin,d.adrelid) default FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE n.nspname='public' AND c.relname=ANY($1::text[]) AND a.attnum>0 AND NOT a.attisdropped",[catalog.tables.map(t=>t.name)])).rows;
 assert.equal(rows.length,catalog.columns.length);for(const expected of catalog.columns){const row=rows.find(r=>r.table===expected.table&&r.column===expected.column);for(const key of ['type','not_null','identity','default'])assert.equal(row[key],expected[key],expected.table+'.'+expected.column+':'+key);}
 const constraints=(await f.pool.query("SELECT c.relname table,k.conname name,pg_get_constraintdef(k.oid) definition FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid WHERE c.relname=ANY($1::text[])",[catalog.tables.map(t=>t.name)])).rows;assert.equal(constraints.length,catalog.constraints.length);for(const expected of catalog.constraints)assert.equal(constraints.find(c=>c.table===expected.table&&c.name===expected.name)?.definition,expected.definition);
 const indexes=(await f.pool.query("SELECT tablename table,indexname name,indexdef definition FROM pg_indexes WHERE schemaname='public' AND tablename=ANY($1::text[])",[catalog.tables.map(t=>t.name)])).rows;assert.equal(indexes.length,catalog.indexes.length);for(const expected of catalog.indexes)assert.equal(indexes.find(i=>i.name===expected.name)?.definition,expected.definition);
 console.log('EXACT_CATALOG',JSON.stringify({tables:catalog.tables.length,columns:rows.length,constraints:constraints.length,indexes:indexes.length}));}finally{await f?.stop();}
});
test('026 scoped overview derives request UUIDs before session LIMIT and returns canonical DTO',{timeout:20000},async()=>{
 let f;try{f=await start();const r=await f.call('a','GET','/api/admin/next-generation/overview');assert.equal(r.status,200,JSON.stringify(r.body));assert.ok(r.body.jornadas.length>=2);assert.ok(r.body.jornadas.every(s=>s.sede_id===1&&s.venue_request_id===VA));assert.ok(!r.body.jornadas.some(s=>s.id===SIDB||s.id===SIDNULL));
 const sessionRead=f.state.trace.find(t=>t.table==='ng_sesiones');assert.deepEqual(sessionRead.filters.find(([key])=>key==='sede_id'),['sede_id','in',[VA]]);const mappingRead=f.state.trace.find(t=>t.table==='ng_solicitudes_sede');assert.deepEqual(mappingRead.filters,[['canonical_sede_id','eq',1]]);
 const root=await f.call('super','GET','/api/admin/next-generation/overview');assert.equal(root.status,200);assert.equal(root.body.jornadas.find(s=>s.id===SIDNULL).mapping_error,'NG_VENUE_UNLINKED');}finally{await f?.stop();}
});
test('026 assign, confirm, waitlist, cancellation and FIFO promotion use existing mapped PP and event names',{timeout:20000},async()=>{
 let f;try{f=await start();const assigned=await f.call('a','PATCH','/api/admin/next-generation/registrations/'+R2+'/assignment',{sede_id:1,sesion_id:SID2,categoria:'Sub-14'});assert.equal(assigned.status,200,JSON.stringify(assigned.body));assert.equal(assigned.body.registration.sesion_id,SID2);
 const confirmed=await f.call('a','POST','/api/admin/next-generation/registrations/'+R2+'/confirm',{});assert.equal(confirmed.status,200);
 await f.registration(R3,SID2,1,'borrador');assert.equal((await f.call('a','POST','/api/admin/next-generation/registrations/'+R3+'/waitlist',{})).status,200);
 assert.equal((await f.call('a','POST','/api/admin/next-generation/registrations/'+R2+'/cancel',{reason:'fixture'})).status,200);assert.equal((await f.pool.query('SELECT estado FROM ng_inscripciones WHERE id=$1',[R3])).rows[0].estado,'confirmada');
 const types=(await f.pool.query('SELECT tipo FROM ng_inscripcion_eventos ORDER BY id')).rows.map(r=>r.tipo);assert.ok(types.includes('asignacion_actualizada'));assert.ok(types.includes('confirmada'));assert.ok(types.includes('lista_espera'));assert.ok(types.includes('cancelada'));assert.ok(types.includes('promovida_desde_espera'));
 const wrong=await f.call('b','PATCH','/api/admin/next-generation/registrations/'+R2+'/assignment',{sede_id:2,sesion_id:SIDB,categoria:'Sub-14'});assert.equal(wrong.status,403);}finally{await f?.stop();}
});
test('026 mapping null, unique mapping and wrong PP fail explicitly; existing SuperAdmin link unblocks mapping',{timeout:20000},async()=>{
 let f;try{f=await start();const initial=await f.snapshot();assert.equal((await f.call('b','PATCH',patchUrl,{cupo:1})).status,403);assert.deepEqual(await f.snapshot(),initial);
 const missing=await f.call('super','PATCH','/api/admin/next-generation/sessions/'+SIDNULL,{cupo:1});assert.equal(missing.status,409);assert.equal(missing.body.code,'NG_VENUE_UNLINKED');
 await f.registration(R3,SIDNULL,3,'borrador');const blockedConfirmation=await f.call('c','POST','/api/admin/next-generation/registrations/'+R3+'/confirm',{});assert.equal(blockedConfirmation.status,409);assert.equal(blockedConfirmation.body.code,'NG_VENUE_UNLINKED');assert.equal((await f.pool.query('SELECT estado FROM ng_inscripciones WHERE id=$1',[R3])).rows[0].estado,'borrador');
 const extra='00000000-0000-4000-8000-000000000104';await assert.rejects(f.request(extra,1),e=>e.code==='23505');
 const payload={sede_id:3,nombre_publico:'New session',ciudad:'City',pais:'AR',categoria:'Sub-14',comienza_at:'2027-02-01T18:00:00Z',termina_at:'2027-02-01T19:00:00Z',cupo:2,estado:'publicada'};
 const unlinked=await f.call('c','POST','/api/admin/next-generation/sessions',payload);assert.equal(unlinked.status,409);assert.equal(unlinked.body.code,'NG_VENUE_UNLINKED');
 const occupied=await f.call('super','PATCH','/api/admin/next-generation/venues/'+VN+'/sede',{sede_id:2});assert.equal(occupied.status,409);assert.equal(occupied.body.code,'NG_VENUE_ALREADY_LINKED');
 assert.equal((await f.pool.query('SELECT canonical_sede_id FROM ng_solicitudes_sede WHERE id=$1',[VN])).rows[0].canonical_sede_id,null);
 const link=await f.call('super','PATCH','/api/admin/next-generation/venues/'+VN+'/sede',{sede_id:3});assert.equal(link.status,200);
 const selected=await f.call('c','POST','/api/admin/next-generation/sessions',{...payload,venue_request_id:VN});assert.equal(selected.status,201,JSON.stringify(selected.body));assert.equal(selected.body.session.sede_id,3);assert.equal(selected.body.session.venue_request_id,VN);
 const recovered=await f.call('c','PATCH','/api/admin/next-generation/sessions/'+SIDNULL,{cupo:3});assert.equal(recovered.status,200,JSON.stringify(recovered.body));assert.equal(recovered.body.session.sede_id,3);
 }finally{await f?.stop();}
});
test('026 confirm first versus capacity PATCH still waits on actual shared lock then returns 409 without mutation',{timeout:20000},async()=>{
 let f,c;try{f=await start();c=await f.pool.connect();await c.query('BEGIN');await c.query('SELECT ng_confirm_registration($1,$2)',[R2,'fixture']);const pending=f.call('a','PATCH',patchUrl,{cupo:1});const pid=await bounded(f.state.patchStarted.promise);assert.notEqual(pid,c.processID);await f.waitLocked(pid);await c.query('COMMIT');const r=await pending;assert.equal(r.status,409);assert.equal(r.body.code,'NG_SESSION_CAPACITY_BELOW_CONFIRMED');assert.deepEqual(await f.snapshot(),{cupo:2,used:2});}finally{if(c){await c.query('ROLLBACK');c.release();}await f?.stop();}
});
test('026 capacity PATCH first blocks existing confirmation and preserves unit registrations and ACL',{timeout:20000},async()=>{
 let f;try{f=await start();await f.pool.query("INSERT INTO ng_inscripcion_participantes(inscripcion_id,nombre,categoria) VALUES($1,'Synthetic child1','Sub-14'),($1,'Synthetic child2','Sub-14')",[R1]);f.state.holdPatchCommit=true;const pending=f.call('a','PATCH',patchUrl,{cupo:1});const pid=await bounded(f.state.patchUpdated.promise);const confirmation=f.call('a','POST','/api/admin/next-generation/registrations/'+R2+'/confirm',{});const cpid=await bounded(f.state.confirmStarted.promise);assert.notEqual(pid,cpid);await f.waitLocked(cpid);f.state.releasePatch.resolve();assert.equal((await pending).status,200);assert.equal((await confirmation).status,409);assert.deepEqual(await f.snapshot(),{cupo:1,used:1});
 const access=(await f.pool.query("SELECT has_function_privilege('anon','ng_update_session(uuid,jsonb,bigint)','EXECUTE') anon,has_function_privilege('authenticated','ng_update_session(uuid,jsonb,bigint)','EXECUTE') authenticated,has_function_privilege('service_role','ng_update_session(uuid,jsonb,bigint)','EXECUTE') service")).rows[0];assert.deepEqual(access,{anon:false,authenticated:false,service:true});}finally{f?.state.releasePatch.resolve();await f?.stop();}
});

test('026 late SQL failure rolls back additive CHECK and function replacements without deleting data',{timeout:20000},async()=>{
 let f,c;try{f=await start({install:false});c=await f.pool.connect();
 const snapshot=async()=>({check:(await c.query("SELECT pg_get_constraintdef(oid) d FROM pg_constraint WHERE conrelid='ng_inscripcion_eventos'::regclass AND conname='ng_inscripcion_eventos_tipo_check'")).rows[0].d,functions:(await c.query("SELECT proname,pg_get_functiondef(oid) d,proacl::text acl FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname=ANY($1::text[]) ORDER BY proname",[catalog.functions.map(fn=>fn.name)])).rows,rows:(await c.query('SELECT row_to_json(e) row FROM ng_inscripcion_eventos e ORDER BY id')).rows});
 const initial=await snapshot();const sql=fs.readFileSync(new URL('../sql/candidates/20261124_nextgen_uuid_compat026.sql',import.meta.url),'utf8').replace(/COMMIT;\s*$/,"DO $late$ BEGIN RAISE EXCEPTION 'NG026_LATE_FIXTURE_FAILURE'; END $late$; COMMIT;");
 await assert.rejects(c.query(sql),/NG026_LATE_FIXTURE_FAILURE/);await c.query('ROLLBACK');assert.deepEqual(await snapshot(),initial);assert.equal((await c.query("SELECT to_regprocedure('ng_update_session(uuid,jsonb,bigint)') IS NULL absent")).rows[0].absent,true);console.log('ROLLBACK_CHECK_DEFS_ACL_ROWS_PRESERVED');
 }finally{if(c){await c.query('ROLLBACK');c.release();}await f?.stop();}
});
