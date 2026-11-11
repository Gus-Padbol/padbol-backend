import test from 'node:test';import assert from 'node:assert/strict';
import {applyNationsFinalization,matchesFinalizationSnapshot,recoverOneGamesFinalization,startGamesFinalizationRecovery} from './nationsGamesFinalizationRecovery.js';
const snap={scoreboard_id:'sb',partido_torneo_id:77,torneo_id:9,sede_id:3,estado:'terminado',sets_a:2,sets_b:0,games_a:0,games_b:0,score_a:0,score_b:0,historial_sets:[{a:6,b:2},{a:6,b:3}]};
const intent=()=>({scoreboard_id:'sb',epoch:0,partido_torneo_id:77,occurred_at:'2026-10-31T23:00:00Z',final_snapshot:structuredClone(snap)});
function dbFixture(existing=null){const writes=[];const db={from(){return {select(){return this;},update(value){writes.push(value);return this;},eq(){return this;},maybeSingle:async()=>({data:{synced_to_torneo_at:existing},error:null}),then(resolve){resolve({error:null});}};}};return {db,writes};}
const success=async()=>({ok:true,status:'idempotent'});
const group=async()=>({ok:true,advance:{status:'skipped',reason:'fase_grupos'}});
test('recovery retries finalization despite already finalized state and preserves event month',async()=>{const f=dbFixture();let calls=0;const args={...f,intent:intent(),finalize:async(_db,p)=>{calls++;assert.equal(p.context.allowOverwrite,undefined);return success();},effects:group};assert.equal((await applyNationsFinalization(args)).status,'completed');assert.equal((await applyNationsFinalization(args)).status,'completed');assert.equal(calls,2);assert.ok(f.writes.every(w=>w.synced_to_torneo_at==='2026-10-31T23:00:00.000Z'));});
test('legacy retry timestamp is replaced by durable event timestamp',async()=>{const f=dbFixture('2026-11-10T22:00:00Z');await applyNationsFinalization({...f,intent:intent(),finalize:success,effects:group});assert.equal(f.writes[0].synced_to_torneo_at,'2026-10-31T23:00:00.000Z');});
test('pending lineup and incomplete next match remain pending',async()=>{for(const scoreboard of [{status:'pending_lineups'},{status:'skipped',reason:'partido_incompleto'}]){const f=dbFixture();const out=await applyNationsFinalization({...f,intent:intent(),finalize:success,effects:async()=>({ok:true,advance:{status:'skipped',reason:'ya_avanzado'},scoreboard})});assert.equal(out.status,'pending');}});
test('final Nations closure requires existing explicit closure, never invents ranking',async()=>{const f=dbFixture();const out=await applyNationsFinalization({...f,intent:intent(),finalize:success,effects:async()=>({ok:true,advance:{status:'skipped',reason:'no_destino'}}),close:async()=>({status:'skipped',reason:'national_explicit_atomic_closure_required'})});assert.equal(out.status,'blocked');assert.equal(out.reason,'NATIONAL_EXPLICIT_CLOSURE_REQUIRED');});
test('changed epoch or result does not match pinned finalization',()=>{const i=intent(),row={...snap,id:'sb'};assert.equal(matchesFinalizationSnapshot(i,row,0),true);assert.equal(matchesFinalizationSnapshot(i,row,1),false);assert.equal(matchesFinalizationSnapshot(i,{...row,sets_a:0},0),false);});
test('postclaim failure leaves durable intent pending for retry',async()=>{const calls=[];const pool={query:async(sql,args)=>{calls.push({sql,args});if(sql.startsWith('WITH'))return {rows:[intent()]};if(sql.startsWith('SELECT'))return {rows:[{...snap,id:'sb',games_epoch:0}]};return {rows:[{status:args[3]}]};}};const out=await recoverOneGamesFinalization({pool,db:{},apply:async()=>{throw Error('lost connection');}});assert.equal(out.status,'pending');assert.equal(calls.at(-1).args[4],'RECOVERY_UNKNOWN');});
test('new epoch blocks stale intent without executing effects',async()=>{let executed=0;const pool={query:async(sql,args)=>sql.startsWith('WITH')?{rows:[intent()]}:sql.startsWith('SELECT')?{rows:[{...snap,id:'sb',games_epoch:1}]}:{rows:[{status:args[3]}]}};const out=await recoverOneGamesFinalization({pool,db:{},apply:async()=>{executed++;}});assert.equal(out.status,'blocked');assert.equal(executed,0);});
test('disabled recovery does not touch storage or schedule work',()=>{let called=0;const stop=startGamesFinalizationRecovery({enabled:false,recover:()=>called++});stop();assert.equal(called,0);});
test('lost lease stops before finalization or before sync/effects',async()=>{for(const stopAt of [1,2]){let checked=0,finalized=0,effected=0;const f=dbFixture();const out=await applyNationsFinalization({...f,intent:intent(),verify:async()=>++checked!==stopAt,finalize:async()=>{finalized++;return success();},effects:async()=>{effected++;return group();}});assert.equal(out.status,'pending');assert.equal(finalized,stopAt===1?0:1);assert.equal(effected,0);assert.equal(f.writes.length,0);}});
test('conditional sync refusal prevents bracket effects',async()=>{let updating=false,effected=0;const filters=[];const db={from(){return {select(){return this;},update(){updating=true;return this;},eq(k,v){filters.push([k,v]);return this;},maybeSingle:async()=>({data:updating?null:{synced_to_torneo_at:null},error:null})};}};const out=await applyNationsFinalization({db,intent:intent(),finalize:success,effects:async()=>{effected++;return group();}});assert.equal(out.status,'blocked');assert.equal(effected,0);assert.ok(filters.some(([k,v])=>k==='torneo_id'&&v===9));assert.ok(filters.some(([k])=>k==='historial_sets'));});

test('recovery reutiliza el actor autorizado del receipt, no null',async()=>{
 let seen=null;
 const pool={query:async(sql,args)=>{
  if(sql.startsWith('WITH'))return {rows:[{...intent(),request_id:'req-1'}]};
  if(sql.includes('games_command_receipts'))return {rows:[{actor_id:'staff-actor'}]};
  if(sql.startsWith('SELECT'))return {rows:[{...snap,id:'sb',games_epoch:0}]};
  return {rows:[{status:args[3]}]};
 }};
 const out=await recoverOneGamesFinalization({pool,db:{},apply:async({intent})=>{seen=intent.actor_id;return {status:'completed'};}});
 assert.equal(out.status,'completed');
 assert.equal(seen,'staff-actor');
});

test('applyNationsFinalization pasa el actor del receipt al RPC nacional',async()=>{
 const f=dbFixture();let context=null;
 await applyNationsFinalization({...f,intent:{...intent(),actor_id:'staff-actor'},finalize:async(_db,p)=>{context=p.context;return success();},effects:group});
 assert.equal(context.actor_id,'staff-actor');
 assert.equal(context.fuente,'scoreboard');
});
