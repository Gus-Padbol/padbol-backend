// Isolated QA only: real national RPC, reverse-sync trigger and bracket services.
import pg from 'pg';
import {loadRecoveryStackFixture} from './nations_games_recovery_stack_fixture.mjs';
const combined=process.env.OWN_GAMES_FULL_STACK==='1';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {recoverOneGamesFinalization,applyNationsFinalization} from '../../lib/torneos/nationsGamesFinalizationRecovery.js';
import {finalizarPartidoTorneo} from '../../lib/torneos/finalizarPartidoTorneoService.js';
const url=new URL(process.env.OWN_GAMES_PG_URL);
if(url.hostname!=='127.0.0.1'||url.pathname!=='/marker_recovery_real_test'||url.port!==process.env.OWN_GAMES_PG_PORT)throw Error('REFUSE_TARGET');
const pool=new pg.Pool({connectionString:url.href});
try {
await pool.query('CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;');
const files=(await readFile('scripts/verify-nations-registry-local.py','utf8')).match(/files=(\[[^\n]+\])/)[1].replaceAll("'",'"');
for(const file of JSON.parse(files)){
 let sql=await readFile(file,'utf8');
 if(file.endsWith('selection_integrated_bootstrap.sql'))sql=sql.replace('scoreboard_partidos(id bigserial PRIMARY KEY','scoreboard_partidos(id uuid PRIMARY KEY DEFAULT gen_random_uuid()');
 await pool.query(sql);
}
// Existing registry fixture proves persisted Nations participation. Commit only in
// this newly created disposable DB; never changes remote or production records.
const registry=await readFile('sql/tests/20261016_nations_registry_assertions.sql','utf8');
const bracketStart=registry.indexOf(' FOR m IN SELECT * FROM partidos WHERE torneo_id=90016 AND bracket_round');
const beforeFinalize=registry.indexOf('  PERFORM finalizar_partido_seleccion',bracketStart);
await pool.query(registry.slice(0,beforeFinalize)+'  EXIT; END LOOP; END $qa$; COMMIT;');
await pool.query(`ALTER TABLE scoreboard_partidos ADD COLUMN sede_id bigint DEFAULT 8,ADD COLUMN games_a int DEFAULT 0,ADD COLUMN games_b int DEFAULT 0,ADD COLUMN score_a int DEFAULT 0,ADD COLUMN score_b int DEFAULT 0;
CREATE SCHEMA nations_marker_private;CREATE TABLE nations_marker_private.nations_marker_match(match_id text PRIMARY KEY,games_epoch int DEFAULT 0);`);
const commands=await readFile('sql/candidates/nations_games_commands.sql','utf8');
if(!combined)await pool.query(commands.slice(commands.indexOf('CREATE TABLE nations_marker_private.games_finalization_intents'),commands.indexOf('CREATE FUNCTION nations_marker_private.commit_games_command_candidate')));
const source=(await pool.query("SELECT * FROM partidos WHERE torneo_id=90016 AND bracket_round=1 ORDER BY id LIMIT 1")).rows[0];
const dest=(await pool.query('SELECT * FROM partidos WHERE id=$1',[source.partido_siguiente_id])).rows[0];
let sb=(await pool.query('SELECT * FROM scoreboard_partidos WHERE partido_torneo_id=$1',[source.id])).rows[0];
// Destination awaits the real winner advancement and real lineup declaration.
await pool.query("UPDATE partidos SET equipo_b_id=$2 WHERE id=$1",[dest.id,source.equipo_b_id]);
await pool.query("UPDATE scoreboard_partidos SET sync_torneo_status=NULL,synced_to_torneo_at=NULL WHERE id=$1",[sb.id]);
await pool.query("UPDATE scoreboard_partidos SET estado='terminado',sets_a=2,sets_b=0,historial_sets='[{\"a\":6,\"b\":0},{\"a\":6,\"b\":0}]'::jsonb WHERE id=$1",[sb.id]);
sb=(await pool.query('SELECT * FROM scoreboard_partidos WHERE id=$1',[sb.id])).rows[0];
if(combined)await loadRecoveryStackFixture(pool);
await pool.query('INSERT INTO nations_marker_private.nations_marker_match(match_id) VALUES($1)',[sb.id]);
if(combined)await pool.query("UPDATE nations_marker_private.nations_marker_match SET games_ledger=jsonb_build_object('version',1,'total',12,'events','[]'::jsonb,'active',to_jsonb(ARRAY(SELECT 'fixture-'||n FROM generate_series(1,12)n))) WHERE match_id=$1",[sb.id]);
const snap=Object.fromEntries(['partido_torneo_id','torneo_id','sede_id','estado','sets_a','sets_b','games_a','games_b','score_a','score_b','historial_sets'].map(k=>[k,sb[k]]));
const occurred='2026-10-31T23:59:59.000Z';
await pool.query('INSERT INTO nations_marker_private.games_finalization_intents(scoreboard_id,epoch,request_id,partido_torneo_id,final_snapshot,occurred_at) VALUES($1,0,$2,$3,$4,$5)',[sb.id,randomUUID(),source.id,JSON.stringify(snap),occurred]);
let rpcCalls=0,failNextInsert=false,onRpc=null;
const ident=k=>{if(!/^[a-z_][a-z0-9_]*$/.test(k))throw Error('IDENTIFIER');return '"'+k+'"';};
const db={async rpc(name,args){assert.equal(name,'finalizar_partido_seleccion');rpcCalls++;onRpc?.();try{return {data:(await pool.query('SELECT finalizar_partido_seleccion($1,$2::jsonb,$3::uuid,$4) result',[args.p_partido_id,JSON.stringify(args.p_resultado),args.p_actor_id,args.p_fuente])).rows[0].result,error:null};}catch(error){return {data:null,error};}},from(table){
 let filters=[],patch=null,insertion=null,selection='*';
 const q={select(s){selection=s;return q;},update(v){patch=v;return q;},insert(v){insertion=v;return q;},limit(){return q;},eq(k,v){filters.push([k,v,'=']);return q;},in(k,v){filters.push([k,v,'ANY']);return q;},is(k,v){assert.equal(v,null);filters.push([k,v,'IS']);return q;},async maybeSingle(){const r=await run();return {...r,data:r.data?.[0]??null};},then(a,b){return run().then(a,b);}};
 async function run(){try{const values=[];if(insertion){if(failNextInsert){failNextInsert=false;throw Object.assign(Error('QA disconnected before insert'),{code:'08006'});}const entries=Object.entries(insertion);const rows=(await pool.query('INSERT INTO '+ident(table)+'('+entries.map(([k])=>ident(k)).join(',')+') VALUES('+entries.map((_,i)=>'$'+(i+1)).join(',')+') RETURNING *',entries.map(([,v])=>typeof v==='object'&&v!==null?JSON.stringify(v):v))).rows;return {data:rows,error:null};}let sql=patch?'UPDATE '+ident(table)+' SET '+Object.entries(patch).map(([k,v])=>{values.push(v);return ident(k)+'=$'+values.length;}).join(','):'SELECT * FROM '+ident(table);
 if(filters.length)sql+=' WHERE '+filters.map(([k,v,op])=>{if(op==='IS')return ident(k)+' IS NULL';values.push(v);return op==='ANY'?ident(k)+'=ANY($'+values.length+')':ident(k)+'=$'+values.length;}).join(' AND ');
 if(patch)sql+=' RETURNING *';const rows=(await pool.query(sql,values)).rows;
 if(selection.includes('torneo:torneos'))for(const row of rows)row.torneo=(await pool.query('SELECT * FROM torneos WHERE id=$1',[row.torneo_id])).rows[0];
 return {data:rows,error:null};}catch(error){return {data:null,error};}}return q;}};
const requeue=async()=>pool.query("UPDATE nations_marker_private.games_finalization_intents SET status='pending',next_attempt_at=NULL,lease_until=NULL,lease_token=NULL WHERE scoreboard_id=$1",[sb.id]);
// Crash after actual committed RPC, before sync and bracket. Persisted intent retries.
const first=await recoverOneGamesFinalization({pool,db,apply:args=>applyNationsFinalization({...args,finalize:async(...a)=>{await finalizarPartidoTorneo(...a);throw Object.assign(Error('synthetic post-commit crash'),{code:'QA_CRASH'});}})});
assert.equal(first.status,'pending');assert.equal((await pool.query('SELECT estado FROM partidos WHERE id=$1',[source.id])).rows[0].estado,'finalizado');assert.equal((await pool.query('SELECT count(*)::int n FROM torneo_partido_participacion WHERE partido_id=$1',[source.id])).rows[0].n,1);assert.equal((await pool.query('SELECT equipo_a_id FROM partidos WHERE id=$1',[dest.id])).rows[0].equipo_a_id,null);
await requeue();const recovered=await recoverOneGamesFinalization({pool,db});assert.equal(recovered.status,'pending',JSON.stringify(recovered));assert.equal(recovered.reason,'NEXT_LINEUPS_REQUIRED');
assert.equal(Number((await pool.query('SELECT equipo_a_id FROM partidos WHERE id=$1',[dest.id])).rows[0].equipo_a_id),Number(source.equipo_a_id));
assert.equal((await pool.query('SELECT synced_to_torneo_at FROM scoreboard_partidos WHERE id=$1',[sb.id])).rows[0].synced_to_torneo_at.toISOString(),occurred);
console.log('PASS actual Nations RPC + trigger + bracket services recover post-commit crash, preserve event date');
// Old worker resumes after a committed real RPC and expired lease and a new worker finishes.
await requeue();let releaseOld,signalStarted;const started=new Promise(r=>signalStarted=r);const held=new Promise(r=>releaseOld=r);
const old=recoverOneGamesFinalization({pool,db,apply:args=>applyNationsFinalization({...args,finalize:async(...a)=>{const out=await finalizarPartidoTorneo(...a);signalStarted();await held;return out;}})});
await started;await pool.query("UPDATE nations_marker_private.games_finalization_intents SET lease_until=clock_timestamp()-interval '1 second' WHERE scoreboard_id=$1",[sb.id]);
const newer=await recoverOneGamesFinalization({pool,db});assert.equal(newer.status,'pending',JSON.stringify(newer));assert.equal(newer.reason,'NEXT_LINEUPS_REQUIRED');releaseOld();assert.equal((await old).status,'lease_lost');
assert.equal((await pool.query('SELECT count(*)::int n FROM scoreboard_partidos WHERE partido_torneo_id=$1',[dest.id])).rows[0].n,0);
assert.equal((await pool.query('SELECT count(*)::int n FROM torneo_partido_participacion WHERE partido_id=$1',[source.id])).rows[0].n,1);
assert.equal((await pool.query('SELECT synced_to_torneo_at FROM scoreboard_partidos WHERE id=$1',[sb.id])).rows[0].synced_to_torneo_at.toISOString(),occurred);
assert.ok(rpcCalls>=4);console.log('PASS expired lease after committed actual RPC, replacement worker preserves pending lineups; stale worker fenced; no premature destination and one participation record');

// Declare real destination lineups only after winner has reached the real slot.
for(const team of [source.equipo_a_id,source.equipo_b_id]){
 const players=(await pool.query('SELECT jugadores FROM equipos WHERE id=$1',[team])).rows[0].jugadores.map(x=>x.participante_id);
 await pool.query('SELECT guardar_alineacion_participantes(90016,$1,$2,$3::uuid,true,$4::uuid[],$5::uuid[],0)',[dest.id,team,'11111111-1111-4111-8111-111111111111',players.slice(0,2),players.slice(2,4)]);
}
const predecessors=(await pool.query("SELECT id FROM partidos WHERE partido_siguiente_id=$1 AND estado IN ('pendiente','programado') ORDER BY id",[dest.id])).rows;
const schedule=predecessors.map((m,i)=>({partido_id:Number(m.id),court_id:13,fecha_hora:'2026-11-21T09:'+String(i*5).padStart(2,'0')+':00Z',duration_minutes:1}));
schedule.push({partido_id:Number(dest.id),court_id:13,fecha_hora:'2026-11-21T10:00:00Z',duration_minutes:1});
const plan=(await pool.query('SELECT plan_nations FROM torneos WHERE id=90016')).rows[0].plan_nations;
await pool.query("SELECT guardar_plan_nations(90016,$1::uuid,'programacion',$2,$3::uuid,$4,$5::jsonb)",['11111111-1111-4111-8111-111111111111',plan.revision,randomUUID(),'b'.repeat(64),JSON.stringify({schedule})]);
for(const [name,type] of Object.entries({torneo_nombre:'text',equipo_a_nombre:'text',equipo_b_nombre:'text',saque_actual:'text',color_a:'text',color_b:'text',control_token_hash:'text',control_token_created_at:'timestamptz',control_token_revoked_at:'timestamptz',updated_at:'timestamptz',...Object.fromEntries(['a','b'].flatMap(side=>[1,2,3,4].map(n=>['jersey_'+side+n,'int'])))}))await pool.query('ALTER TABLE scoreboard_partidos ADD COLUMN IF NOT EXISTS '+ident(name)+' '+type);
await pool.query("CREATE UNIQUE INDEX qa_one_active_marker ON scoreboard_partidos(partido_torneo_id) WHERE partido_torneo_id IS NOT NULL AND lower(trim(coalesce(estado,''))) NOT IN ('terminado','finalizado')");
await requeue();failNextInsert=true;const failedInsert=await recoverOneGamesFinalization({pool,db});assert.equal(failedInsert.status,'pending');assert.equal((await pool.query('SELECT count(*)::int n FROM scoreboard_partidos WHERE partido_torneo_id=$1',[dest.id])).rows[0].n,0);
await requeue();const completed=await recoverOneGamesFinalization({pool,db});assert.equal(completed.status,'completed',JSON.stringify(completed));
await requeue();assert.equal((await recoverOneGamesFinalization({pool,db})).status,'completed');
assert.equal((await pool.query('SELECT count(*)::int n FROM scoreboard_partidos WHERE partido_torneo_id=$1',[dest.id])).rows[0].n,1);
// Expire the lease while the actual SQL RPC is blocked on a real tournament row.
// Both workers execute the unchanged RPC after that lock is released.
await requeue();const blocker=await pool.connect();let entered=0,signalTwo;
const twoEntered=new Promise(r=>signalTwo=r);onRpc=()=>{entered++;if(entered===2)signalTwo();};
await blocker.query('BEGIN');await blocker.query('SELECT id FROM torneos WHERE id=90016 FOR UPDATE');
let workerOld,workerNew;
try{
 workerOld=recoverOneGamesFinalization({pool,db});
 let waiting=false;
 for(let n=0;n<100;n++){
  waiting=(await pool.query("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND query LIKE 'SELECT finalizar_partido_seleccion(%' AND wait_event_type='Lock') yes")).rows[0].yes;
  if(waiting)break;await new Promise(r=>setTimeout(r,10));
 }
 assert.equal(waiting,true,'real RPC must be in-flight and lock-blocked');
 await pool.query("UPDATE nations_marker_private.games_finalization_intents SET lease_until=clock_timestamp()-interval '1 second' WHERE scoreboard_id=$1",[sb.id]);
 workerNew=recoverOneGamesFinalization({pool,db});
 await Promise.race([twoEntered,new Promise((_,reject)=>setTimeout(()=>reject(Error('second RPC did not enter')),3000))]);
 await blocker.query('COMMIT');
 const [a,b]=await Promise.all([workerOld,workerNew]);assert.equal(a.status,'lease_lost');assert.equal(b.status,'completed',JSON.stringify(b));
 assert.equal((await pool.query('SELECT count(*)::int n FROM torneo_partido_participacion WHERE partido_id=$1',[source.id])).rows[0].n,1);
 assert.equal((await pool.query('SELECT count(*)::int n FROM scoreboard_partidos WHERE partido_torneo_id=$1',[dest.id])).rows[0].n,1);
 console.log('PASS lease expiry DURING lock-blocked real SQL RPC: concurrent retries serialize, stale outcome fenced, one result and destination');
}finally{onRpc=null;await blocker.query('ROLLBACK');blocker.release();await Promise.allSettled([workerOld,workerNew].filter(Boolean));}
if(combined){
 await assert.rejects(pool.query('UPDATE scoreboard_partidos SET score_a=15 WHERE id=$1',[sb.id]),/GAME_COMMAND_REQUIRED/);
 await assert.rejects(pool.query('UPDATE scoreboard_partidos SET torneo_id=555 WHERE id=$1',[sb.id]),/GAME_TRACKING_SCOPE_FROZEN/);
 console.log('PASS combined games guards, ledger invariant, occupancy triggers and finalization lock wrapper remain enforced');
}
console.log('PASS real lineup RPC + schedule RPC release pending recovery after failed insertion, create one destination scoreboard, and replay without duplicate');
}finally{await pool.end();}
