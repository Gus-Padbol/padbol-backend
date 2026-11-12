import test from 'node:test';import assert from 'node:assert/strict';import {PGlite} from '@electric-sql/pglite';import {readFile} from 'node:fs/promises';
import {registrarPunto,buildHistorialPuntoSnapshot,applyHistorialPuntoSnapshot} from '../utils/scoreboardLogic.js';
import {NAPOLI_GROUPS_POLICY as policy} from '../src/scoreboard/napoliScoringPolicy.js';
import {projectNationsMatch} from './torneos/nationsPublicAccess.js';
import {applyNationsFinalization} from './torneos/nationsGamesFinalizationRecovery.js';
test('actual atomic RPC and games trigger preserve typed 10–9, reject duplicate, reverse and replay one game, worker preserves result',async()=>{
 const db=new PGlite();const id='00000000-0000-4000-8000-000000000001';try{
 const fixture=await readFile('sql/tests/nations_games_atomic_history_candidate.mjs','utf8');
 await db.exec(fixture.match(/await d.exec\(`([\s\S]*?)`\);/)[1].replaceAll('${id}',id));
 await db.query('INSERT INTO nations_marker_private.nations_marker_match VALUES($1,0,$2,\'{}\',now())',[id,JSON.stringify({A:{status:'open',active:['a','b'],lineup:{iniciales:['a','b'],suplentes:['c','d']}},B:{status:'open',active:['e','f'],lineup:{iniciales:['e','f'],suplentes:['g','h']}}})]);
 await db.query('UPDATE scoreboard_partidos SET score_a=0');
 for(const p of ['sql/20261021120000_scoreboard_atomic_mutation.sql','sql/candidates/nations_games_atomic_history.sql'])await db.exec(await readFile(p,'utf8'));

 const row=async()=>(await db.query('SELECT *,updated_at::text version FROM scoreboard_partidos')).rows[0];
 const livePoint=async team=>{const before=await row(),next=registrarPunto(structuredClone(before),team,policy);await db.query("SELECT scoreboard_commit_mutation($1,$2,$3,'point',$4,NULL)",[id,before.version,JSON.stringify(next),JSON.stringify(buildHistorialPuntoSnapshot(before,team))]);};
 for(const team of [...Array(4).fill('A'),...Array(2).fill('B'),...Array(2).fill('A'),...Array(4).fill('B'),...Array(3).fill('A'),...Array(2).fill('B')])for(let point=0;point<4;point++)await livePoint(team);
 for(let point=0;point<9;point++){await livePoint('A');await livePoint('B');}
 const before=await row(),point=buildHistorialPuntoSnapshot(before,'A'),next=registrarPunto(structuredClone(before),'A',policy);
 const call=async(ver,n,kind='point',history=point,hid=null)=>(await db.query('SELECT scoreboard_commit_mutation($1,$2,$3,$4,$5,$6) result',[id,ver,JSON.stringify(n),kind,history?JSON.stringify(history):null,hid])).rows[0].result;
 const result=await call(before.version,next);assert.equal(result.historial_sets[2].points_a,10);assert.equal(result.historial_sets[2].points_b,9);
 assert.equal(await call(before.version,next),null);
 let ledger=(await db.query('SELECT games_ledger l FROM nations_marker_private.nations_marker_match')).rows[0].l;assert.equal(ledger.events.length,18);assert.equal(ledger.events.at(-1).number,1);assert.deepEqual(ledger.events.at(-1).teams.A,['a','b']);
 const current=await row(),undo=applyHistorialPuntoSnapshot(structuredClone(current),point);await call(current.version,undo,'undo',null,ledger.active.at(-1));assert.equal((await row()).score_a,9);
 const replay=await row();await call(replay.version,registrarPunto(structuredClone(replay),'A',policy));ledger=(await db.query('SELECT games_ledger l FROM nations_marker_private.nations_marker_match')).rows[0].l;assert.equal(ledger.events.filter(x=>x.type==='reversal').length,1);assert.equal(ledger.active.length,18);
 const final=await row();let finalized;
 const adapter={from(){let updating=false;const q={select(){return q},update(){updating=true;return q},eq(){return q},async maybeSingle(){return{data:updating?{id}:{synced_to_torneo_at:null},error:null}},then(resolve){resolve({error:null})}};return q}};
 const snapshot={...final,scoreboard_id:id,partido_torneo_id:77,torneo_id:57,sede_id:3};
 await applyNationsFinalization({db:adapter,intent:{scoreboard_id:id,epoch:0,partido_torneo_id:77,occurred_at:'2026-11-12T00:00:00Z',final_snapshot:snapshot},finalize:async(_db,p)=>{finalized=p.resultado;return {ok:true,status:'finalized'}},effects:async()=>({ok:true,advance:{status:'skipped',reason:'no_destino'}})});
 assert.deepEqual(finalized.historial_sets,final.historial_sets);
 const publicMatch=projectNationsMatch({resultado:finalized});assert.equal(publicMatch.resultado.historial_sets[2].points_a,10);assert.equal(publicMatch.resultado.historial_sets[2].a,1);
 }finally{await db.close()}
});
test('deployed national finalization RPC freezes exact STB result and participation; retry idempotent',async()=>{
 const db=new PGlite();try{
 await db.exec('CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role;');
 const files=JSON.parse((await readFile('scripts/verify-nations-registry-local.py','utf8')).match(/files=(\[[^\n]+\])/)[1].replaceAll("'",'"'));
 for(const path of files)await db.exec(await readFile(path,'utf8'));
 const registry=await readFile('sql/tests/20261016_nations_registry_assertions.sql','utf8');const stop=registry.indexOf('  PERFORM finalizar_partido_seleccion');
 await db.exec(registry.slice(0,stop)+'  EXIT; END LOOP; END $qa$; COMMIT;');
 const match=(await db.query("SELECT * FROM partidos WHERE torneo_id=90016 AND grupo='A' ORDER BY id LIMIT 1")).rows[0];
 const result={goles_a:2,goles_b:1,historial_sets:[{set:1,a:6,b:2},{set:2,a:3,b:6},{set:3,a:1,b:0,type:'super_tiebreak',points_a:10,points_b:9,target:10,win_by:1}]};
 const finalize=async()=>(await db.query("SELECT finalizar_partido_seleccion($1,$2,'11111111-1111-4111-8111-111111111111','scoreboard') result",[match.id,JSON.stringify(result)])).rows[0].result;
 assert.equal((await finalize()).status,'finalized');assert.equal((await finalize()).status,'idempotent');
 assert.deepEqual((await db.query('SELECT resultado FROM partidos WHERE id=$1',[match.id])).rows[0].resultado,result);
 const participation=(await db.query('SELECT resultado_snapshot FROM torneo_partido_participacion WHERE partido_id=$1',[match.id])).rows;assert.equal(participation.length,1);assert.deepEqual(participation[0].resultado_snapshot,result);
 }finally{await db.close()}
});
