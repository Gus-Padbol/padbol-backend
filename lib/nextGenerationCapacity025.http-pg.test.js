import test from 'node:test';import assert from 'node:assert/strict';
import {start,SID,R1,R2,bounded} from './nextGenerationCapacity025.fixture.mjs';
const before=process.env.NG025_BEFORE==='1';const url='/api/admin/next-generation/sessions/'+SID;
test('025 confirmation committing before capacity edit cannot leave overbooked session',{timeout:20000},async()=>{
 let f,confirmClient;try{f=await start({install:!before});
 if(before){f.state.holdOldRead=true;const patch=f.call('a','PATCH',url,{cupo:1});const snapshot=await bounded(f.state.oldRead.promise);assert.equal(snapshot.confirmed,1);
 const confirmed=await f.call('a','POST','/api/admin/next-generation/registrations/'+R2+'/confirm',{});assert.equal(confirmed.status,200);
 f.state.releaseOld.resolve();const result=await patch;const state=await f.snapshot();console.log('BEFORE_REAL_INTERLEAVE',JSON.stringify({readPid:snapshot.pid,patch:result.status,confirm:confirmed.status,...state}));assert.equal(result.status,409);assert.ok(state.used<=state.cupo);
 }else{
 confirmClient=await f.pool.connect();await confirmClient.query('BEGIN');await confirmClient.query('SELECT ng_confirm_registration($1,$2)',[R2,'synthetic confirm']);
 const patch=f.call('a','PATCH',url,{cupo:1});const patchPid=await bounded(f.state.patchStarted.promise);assert.notEqual(patchPid,confirmClient.processID);await f.waitLocked(patchPid);await confirmClient.query('COMMIT');
 const result=await patch;assert.equal(result.status,409);assert.equal(result.body.code,'NG_SESSION_CAPACITY_BELOW_CONFIRMED');assert.deepEqual(await f.snapshot(),{cupo:2,used:2,nombre_publico:'Synthetic session'});console.log('AFTER_CONFIRM_FIRST_LOCK_WAIT_409_NO_MUTATION');
 }
 }finally{if(confirmClient){await confirmClient.query('ROLLBACK');confirmClient.release();}f?.state.releaseOld.resolve();await f?.stop();}
});
test('025 capacity edit first holds real session lock and existing HTTP confirm returns full',{timeout:20000},async()=>{
 let f;try{f=await start();f.state.holdPatchCommit=true;const patch=f.call('a','PATCH',url,{cupo:1});const editPid=await bounded(f.state.patchUpdated.promise);
 const confirm=f.call('a','POST','/api/admin/next-generation/registrations/'+R2+'/confirm',{});const confirmPid=await bounded(f.state.confirmStarted.promise);assert.notEqual(editPid,confirmPid);await f.waitLocked(confirmPid);f.state.releasePatch.resolve();
 assert.equal((await patch).status,200);const result=await confirm;assert.equal(result.status,409);assert.equal(result.body.code,'NG_SESSION_FULL');assert.deepEqual(await f.snapshot(),{cupo:1,used:1,nombre_publico:'Synthetic session'});console.log('AFTER_PATCH_FIRST_LOCK_WAIT_CONFIRM_FULL');
 }finally{f?.state.releasePatch.resolve();await f?.stop();}
});
test('025 partial fields, registrations capacity unit, cancel and promotion remain supported',{timeout:20000},async()=>{
 let f;try{f=await start();await f.pool.query("INSERT INTO ng_inscripcion_participantes(inscripcion_id,nombre,categoria) VALUES($1,'Child A','Sub-18'),($1,'Child B','Sub-18')",[R1]);
 const patch=await f.call('a','PATCH',url,{cupo:1,nombre_publico:'Updated'});assert.equal(patch.status,200);assert.equal(patch.body.session.cupo,1);assert.equal(patch.body.session.nombre_publico,'Updated');assert.equal(patch.body.session.categoria,'Sub-18');
 assert.equal((await f.call('a','POST','/api/admin/next-generation/registrations/'+R2+'/waitlist',{})).status,200);
 assert.equal((await f.call('a','POST','/api/admin/next-generation/registrations/'+R1+'/cancel',{reason:'synthetic'})).status,200);
 const row=(await f.pool.query('SELECT estado FROM ng_inscripciones WHERE id=$1',[R2])).rows[0];assert.equal(row.estado,'confirmada');assert.equal((await f.snapshot()).used,1);
 }finally{await f?.stop();}
});
test('025 foreign PP and unauthenticated patch do not write; movement and RPC failure fail closed',{timeout:20000},async()=>{
 let f;try{f=await start();const initial=await f.snapshot();assert.equal((await f.call('b','PATCH',url,{cupo:1})).status,403);assert.equal((await f.call(null,'PATCH',url,{cupo:1})).status,401);assert.equal(f.state.rpcWrites,0);assert.deepEqual(await f.snapshot(),initial);
 const move=await f.call('super','PATCH',url,{sede_id:2});assert.equal(move.status,409);assert.equal(move.body.code,'NG_SESSION_HAS_REGISTRATIONS');
 await f.pool.query('DROP FUNCTION ng_update_session(uuid,jsonb,bigint)');const failed=await f.call('a','PATCH',url,{cupo:1});assert.equal(failed.status,503);assert.deepEqual(await f.snapshot(),initial);
 }finally{await f?.stop();}
});
test('025 new RPC keeps existing service-only execution boundary',{timeout:20000},async()=>{
 let f;try{f=await start();const result=(await f.pool.query("SELECT has_function_privilege('service_role','ng_update_session(uuid,jsonb,bigint)','EXECUTE') service,has_function_privilege('anon','ng_update_session(uuid,jsonb,bigint)','EXECUTE') anon,has_function_privilege('authenticated','ng_update_session(uuid,jsonb,bigint)','EXECUTE') authenticated")).rows[0];assert.deepEqual(result,{service:true,anon:false,authenticated:false});
 }finally{await f?.stop();}
});
