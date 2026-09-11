import test from 'node:test';
import assert from 'node:assert/strict';
import { cargarResultadoManualPartidoTorneo } from './torneos/cargarResultadoManualPartidoTorneoService.js';
import { onPartidoTorneoFinalizado } from './torneos/partidoTorneoFinalizadoEffectsService.js';
import { MANUAL_PLAYED_DATE_CAPABILITY } from './torneos/manualPlayedDateCapability.js';
const actor='10000000-0000-4000-8000-000000000001';
const params={torneoId:1,partidoId:1,actorId:actor,body:{goles_a:2,goles_b:0,fecha_juego:'2026-09-04'}};
const committed={partido_id:1,torneo_id:1,status:'finalized',resultado:{goles_a:2,goles_b:0},ganador_equipo_id:10,fecha_declarada:{fecha_juego:'2026-09-04',revision:1}};
const finished={ok:true,advance:{status:'skipped',reason:'no_destino'},scoreboard:null};
test('both server-owned capabilities default OFF',()=>{assert.deepEqual(MANUAL_PLAYED_DATE_CAPABILITY,{readEnabled:false,writeEnabled:false});assert(Object.isFrozen(MANUAL_PLAYED_DATE_CAPABILITY));});
test('explicit date rejected while OFF, never silently falls back to old sporting writer',async()=>{
 let called=0;const result=await cargarResultadoManualPartidoTorneo({},params,{finalizarPartidoTorneo:async()=>{called++;},saveManualResultAndPlayedDate:async()=>{called++;}});
 assert.equal(result.statusCode,409);assert.equal(result.body.code,'MANUAL_PLAYED_DATE_DISABLED');assert.equal(called,0);
});
test('body cannot turn on capability or replace authenticated actor',async()=>{
 const result=await cargarResultadoManualPartidoTorneo({}, {...params,body:{...params.body,manualDatesEnabled:true,actor_id:actor}});
 assert.equal(result.statusCode,409);
});
test('enabled new path commits exactly once with no legacy write or extra tournament read',async()=>{
 let calls=0,effects=0;const db={from(){assert.fail('No split write/read before the atomic contract');}};
 const response=await cargarResultadoManualPartidoTorneo(db,{...params,body:{...params.body,actor_id:'spoofed'}},{manualDatesEnabled:true,
 finalizarPartidoTorneo:async()=>assert.fail('legacy writer used'),
 saveManualResultAndPlayedDate:async(client,arg)=>{calls++;assert.equal(client,db);assert.equal(arg.actorId,actor);assert.equal(arg.body.fecha_juego,'2026-09-04');assert.equal(arg.resultado.fuente_resultado,'manual_admin');return committed;},
 onPartidoTorneoFinalizado:async(client,arg)=>{effects++;assert.equal(arg.partidoId,1);assert.deepEqual(arg.resultado,committed.resultado);return finished;}});
 assert.equal(calls,1);assert.equal(effects,1);assert.equal(response.statusCode,200);assert.equal(response.body.effects_pending,false);assert.deepEqual(response.body.fecha_declarada,committed.fecha_declarada);
});
test('atomic errors propagate and never trigger sporting effects',async()=>{
 for(const status of [400,403,404,409,503]){let effects=0;const response=await cargarResultadoManualPartidoTorneo({},params,{manualDatesEnabled:true,
 saveManualResultAndPlayedDate:async()=>{throw Object.assign(new Error('safe contract error'),{status,code:'CONTRACT_ERROR'});},onPartidoTorneoFinalizado:async()=>{effects++;}});assert.equal(response.statusCode,status);assert.equal(effects,0);}
});
test('post-commit failures are reported as saved with pending effects and no private error/token',async()=>{
 for(const effects of [
 {ok:false,advance:{status:'failed',reason:'exception',error:'private db'},scoreboard:null},
 {ok:true,advance:{status:'conflict',reason:'slot_ocupado'},scoreboard:null},
 {ok:true,advance:{status:'advanced'},scoreboard:{status:'failed',error:'secret'}},
 ]){
 const response=await cargarResultadoManualPartidoTorneo({},params,{manualDatesEnabled:true,saveManualResultAndPlayedDate:async()=>committed,onPartidoTorneoFinalizado:async()=>effects});
 assert.equal(response.statusCode,200);assert.equal(response.body.ok,true);assert.equal(response.body.effects_pending,true);assert.equal(response.body.code,'MANUAL_RESULT_SAVED_EFFECTS_PENDING');assert(!JSON.stringify(response.body).includes('private db'));assert(!JSON.stringify(response.body).includes('secret'));
 }
});
test('retry after commit repairs pending effects and keeps idempotent result status',async()=>{
 let effectsCalls=0;const opts={manualDatesEnabled:true,saveManualResultAndPlayedDate:async()=>({...committed,status:'idempotent'}),onPartidoTorneoFinalizado:async()=>{effectsCalls++;return finished;}};
 const response=await cargarResultadoManualPartidoTorneo({},params,opts);assert.equal(response.body.status,'idempotent');assert.equal(response.body.effects_pending,false);assert.equal(effectsCalls,1);
});
test('already-advanced bracket retries ensure-scoreboard rather than losing the effect',async()=>{
 let ensured=0;const result=await onPartidoTorneoFinalizado({}, {partidoId:1,fuente:'manual_admin'}, {
 advanceWinnerIfNeeded:async()=>({status:'skipped',reason:'ya_avanzado',destino_partido_id:3}),
 ensureScoreboardForCompletedBracketPartido:async()=>{ensured++;return {status:'created',scoreboard_id:'synthetic'};},});
 assert.equal(ensured,1);assert.equal(result.ok,true);assert.equal(result.scoreboard.status,'created');
});
test('nonthrowing effect failures and conflicts do not claim completion',async()=>{
 for(const status of ['failed','conflict'])assert.equal((await onPartidoTorneoFinalizado({}, {partidoId:1}, {advanceWinnerIfNeeded:async()=>({status})})).ok,false);
 const result=await onPartidoTorneoFinalizado({}, {partidoId:1}, {advanceWinnerIfNeeded:async()=>({status:'advanced',destino_partido_id:3}),ensureScoreboardForCompletedBracketPartido:async()=>({status:'failed'})});assert.equal(result.ok,false);
});
test('manual new response omits control token from existing effect',async()=>{
 const response=await cargarResultadoManualPartidoTorneo({},params,{manualDatesEnabled:true,saveManualResultAndPlayedDate:async()=>committed,onPartidoTorneoFinalizado:async()=>({ok:true,advance:{status:'advanced'},scoreboard:{status:'created',scoreboard_id:'sb',control_token:'secret-token'}})});
 assert.equal(response.body.effects.scoreboard.scoreboard_id,'sb');assert(!JSON.stringify(response).includes('secret-token'));
});

test('unconfirmed or stale effect summaries remain pending after the sporting commit',async()=>{
 for(const effects of [{ok:true,advance:null},{ok:true,advance:{status:'skipped',reason:'not_finalizado'}},{ok:true,advance:{status:'advanced'},scoreboard:null}]){
 const response=await cargarResultadoManualPartidoTorneo({},params,{manualDatesEnabled:true,saveManualResultAndPlayedDate:async()=>committed,onPartidoTorneoFinalizado:async()=>effects});
 assert.equal(response.body.effects_pending,true);assert.equal(response.body.ok,true);
 }
});
