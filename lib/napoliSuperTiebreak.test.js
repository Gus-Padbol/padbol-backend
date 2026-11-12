import test from 'node:test';
import assert from 'node:assert/strict';
import { registrarPunto, deshacerPunto, enrichPartidoResponse, buildHistorialPuntoSnapshot } from '../utils/scoreboardLogic.js';
import { NAPOLI_GROUPS_POLICY as policy, resolvePersistedScoringPolicy } from '../src/scoreboard/napoliScoringPolicy.js';
import { assertScoreboardScoringSupported } from '../src/scoreboard/scoreboardSportGuard.js';
import { isTerminalScoreboardPoint } from './torneos/terminalScoreboardPoint.js';
import { prepareCompletedGame } from './torneos/nationsGamesScoreboardBridge.js';
import { buildPartidoTorneoResultadoFromScoreboard } from '../src/scoreboard/scoreboardTorneoSyncService.js';
const fixture = (a=0,b=0) => ({id:'board',estado:'en_curso',saque_actual:'A',score_a:a,score_b:b,games_a:0,games_b:0,sets_a:1,sets_b:1,historial_sets:[{set:1,a:6,b:2},{set:2,a:3,b:6}],es_tiebreak:a+b>0});
const torneo={id:57,deporte:'padbol',modalidad_plantel:'selecciones'};
const match={torneo_id:57,grupo:'A',ronda:1};
const prodEnv={SUPABASE_URL:'https://vpldffhsxhgnmitiikof.supabase.co'};
test('persisted policy restricts Napoli recognized groups; unknown and KO remain regular',()=>{
 assert.deepEqual(resolvePersistedScoringPolicy(torneo,match,prodEnv),policy);
 assert.equal(resolvePersistedScoringPolicy(torneo,match,{}),null);
 assert.equal(resolvePersistedScoringPolicy(torneo,match,{SUPABASE_URL:'https://other.supabase.co'}),null);
 assert.deepEqual(resolvePersistedScoringPolicy(torneo,match,{SUPABASE_URL:prodEnv.SUPABASE_URL+'/'}),policy);
 for(const change of [{grupo:null,bracket_round:1},{grupo:'D'},{ronda:2},{bracket_position:1},{partido_siguiente_id:5}]) assert.equal(resolvePersistedScoringPolicy(torneo,{...match,...change},prodEnv),null);
 assert.equal(resolvePersistedScoringPolicy({...torneo,id:58},{...match,torneo_id:58}),null);
 const qa={...torneo,id:28,es_prueba:true,plan_nations:{config:{scoring_policy:policy.id}}};
 assert.equal(resolvePersistedScoringPolicy(qa,{...match,torneo_id:28},{}),null);
 assert.deepEqual(resolvePersistedScoringPolicy(qa,{...match,torneo_id:28},{BACKEND_RUNTIME_MODE:'staging',SUPABASE_URL:'https://vxikhdulhuvghfqeutnp.supabase.co'},qa.plan_nations),policy);
});
for(const winner of ['A','B']) test(`9–9 ends at 10–9 for ${winner}; terminal evidence, result metadata, one ledger game and undo`,()=>{
 const row=fixture(9,9),before=structuredClone(row),point={...buildHistorialPuntoSnapshot(row,winner),partido_id:row.id,timestamp:'2026-11-12T00:00:00Z'};
 registrarPunto(row,winner,policy); assert.equal(row.estado,'terminado');assert.equal(row[`sets_${winner.toLowerCase()}`],2);
 const third=row.historial_sets[2];assert.equal(third[`points_${winner.toLowerCase()}`],10);assert.equal(third.type,'super_tiebreak');assert.equal(third.a+third.b,1);
 assert.deepEqual(buildPartidoTorneoResultadoFromScoreboard(row).historial_sets,row.historial_sets);
 assert.equal(prepareCompletedGame({before,after:row,activePlayers:['x','y'],eventId:'evt'}).number,1);
 row.synced_to_torneo_at='2026-11-12T00:00:01Z';assert.equal(isTerminalScoreboardPoint(row,point,policy),true);assert.equal(isTerminalScoreboardPoint(row,point),false);
 deshacerPunto(row);assert.equal(row.score_a,9);assert.equal(row.score_b,9);assert.equal(row.es_tiebreak,true);assert.equal(row.historial_sets.length,2);
});
test('no finish at seven, 10–0 ends, pre-point lineup state preserved and undo first point',()=>{
 const row=fixture();assert.equal(enrichPartidoResponse(row,{},policy).display.mode,'super_tiebreak');assert.equal(row.es_tiebreak,false);
 registrarPunto(row,'A',policy);assert.equal(row.es_tiebreak,true);deshacerPunto(row);assert.equal(row.es_tiebreak,false);
 for(let i=0;i<7;i++)registrarPunto(row,'A',policy);assert.equal(row.estado,'en_curso');
 for(let i=0;i<3;i++)registrarPunto(row,'A',policy);assert.equal(row.historial_sets[2].points_a,10);assert.equal(row.historial_sets[2].points_b,0);
});
test('ordinary third set and normal tie-break keep win-by-two; 2–0 never starts STB',()=>{
 const regular=fixture();registrarPunto(regular,'A');assert.equal(regular.score_a,15);assert.equal(regular.es_tiebreak,false);
 const tb={...fixture(6,6),games_a:6,games_b:6,es_tiebreak:true};registrarPunto(tb,'A',policy);assert.equal(tb.estado,'en_curso');registrarPunto(tb,'A',policy);assert.equal(tb.estado,'terminado');assert.equal(tb.historial_sets[2].a,7);assert.equal(tb.historial_sets[2].type,undefined);
 const finished={...fixture(),estado:'terminado',sets_a:2,sets_b:0};assert.notEqual(enrichPartidoResponse(finished,{},policy).display.mode,'super_tiebreak');assert.throws(()=>registrarPunto(finished,'A',policy));
 assert.throws(()=>registrarPunto(fixture(40,0),'A',policy),{status:409});
});
test('lookup failure rejects before score write, and client-injected policy cannot establish rules',async()=>{
 let written=false;const db={from(){return{select(){return this},eq(){return this},async maybeSingle(){return{error:{message:'offline'}}}}}};
 await assert.rejects(async()=>{await assertScoreboardScoringSupported(db,{torneo_id:57,partido_torneo_id:1});written=true;},{status:409});assert.equal(written,false);
 const row=fixture();row.scoring_policy=policy;registrarPunto(row,'A');assert.equal(row.score_a,15);
});
test('QA opt-in uses private persisted plan only; errors fail closed and production makes zero private queries',async()=>{
 const previousUrl=process.env.SUPABASE_URL,previousMode=process.env.BACKEND_RUNTIME_MODE;const queries=[];
 const qaEnv={BACKEND_RUNTIME_MODE:'staging',SUPABASE_URL:'https://vxikhdulhuvghfqeutnp.supabase.co'};
 const qa={id:77,deporte:'padbol',modalidad_plantel:'selecciones',es_prueba:true,plan_nations:{config:{scoring_policy:policy.id}}};
 assert.equal(resolvePersistedScoringPolicy(qa,{...match,torneo_id:77},qaEnv),null,'public summary is not authority');
 let failing=false;let tableRows={torneos:qa,partidos:{...match,id:22,torneo_id:77},torneo_nations_planes:{plan:{config:{scoring_policy:policy.id},private_note:'not public'}}};
 const db={from(table){queries.push(table);return{select(){return this},eq(){return this},async maybeSingle(){return failing&&table==='torneo_nations_planes'?{error:{message:'unavailable'}}:{data:tableRows[table]}}}}};
 try{
 Object.assign(process.env,qaEnv);assert.deepEqual(await assertScoreboardScoringSupported(db,{torneo_id:77,partido_torneo_id:22}),policy);assert.equal(queries.includes('torneo_nations_planes'),true);
 failing=true;await assert.rejects(assertScoreboardScoringSupported(db,{torneo_id:77,partido_torneo_id:22}),{status:409});
 process.env.SUPABASE_URL=prodEnv.SUPABASE_URL;process.env.BACKEND_RUNTIME_MODE='production';queries.length=0;tableRows={torneos:torneo,partidos:{...match,id:22}};
 assert.deepEqual(await assertScoreboardScoringSupported(db,{torneo_id:57,partido_torneo_id:22}),policy);assert.equal(queries.includes('torneo_nations_planes'),false);
 }finally{if(previousUrl===undefined)delete process.env.SUPABASE_URL;else process.env.SUPABASE_URL=previousUrl;if(previousMode===undefined)delete process.env.BACKEND_RUNTIME_MODE;else process.env.BACKEND_RUNTIME_MODE=previousMode;}
});

test('legacy DTO remains unchanged without trusted scoring policy',()=>{
 const row=fixture();assert.equal(Object.hasOwn(enrichPartidoResponse(row),'scoring_policy'),false);
 assert.deepEqual(enrichPartidoResponse(row,{},policy).scoring_policy,policy);
});
