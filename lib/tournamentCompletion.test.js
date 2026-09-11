import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';
import { getTournamentCompletionEvidence, completeTournamentFromFinalScoreboard, prepareTournamentUpdate } from './torneos/tournamentCompletionService.js';
import { buildFinalRankingForTorneo } from './torneos/clasificacionService.js';
import { isTerminalScoreboardPoint } from './torneos/terminalScoreboardPoint.js';
import { buildHistorialPuntoSnapshot, registrarPunto } from '../utils/scoreboardLogic.js';
import { assertScoreboardMutable } from '../src/scoreboard/scoreboardControlAuth.js';

const time = '2026-09-10T18:00:00.000Z';
function fixture(size = 8) {
  const torneo = { id: 100, sede_id: 9, deporte: 'padbol', tipo_torneo: 'knockout', estado: 'en_curso', fecha_fin: '2026-10-30', updated_at: '2026-09-01T00:00:00Z' };
  const equipos = Array.from({length: size}, (_,i) => ({ id: i+1, torneo_id: 100 }));
  let teams = equipos.map(e=>e.id), id=1, round=1;
  const partidos=[];
  while(teams.length>1) {
    const winners=[];
    const start=id;
    for(let i=0;i<teams.length;i+=2) {
      // B wins the final, proving champion isn't the first entered team.
      const final=teams.length===2, winner=final?teams[i+1]:teams[i];
      partidos.push({id:id++,torneo_id:100,estado:'finalizado',equipo_a_id:teams[i],equipo_b_id:teams[i+1],ganador_equipo_id:winner,
        grupo:null,bracket_round:round,bracket_position:i/2+1,ronda:round,partido_siguiente_id:final?null:start+teams.length/2+Math.floor(i/4),partido_siguiente_slot:final?null:(i%4===0?'A':'B'),resultado:{goles_a:final?0:2,goles_b:final?2:0}});
      winners.push(winner);
    }
    teams=winners;round++;
  }
  const final=partidos.at(-1);
  const before={id:'sb-final',partido_torneo_id:final.id,torneo_id:100,sede_id:9,estado:'en_curso',sets_a:0,sets_b:1,games_a:4,games_b:5,score_a:0,score_b:40,es_tiebreak:false,saque_actual:'B',historial_sets:[{set:1,a:3,b:6}]};
  const point={id:1,partido_id:before.id,timestamp:time,...buildHistorialPuntoSnapshot(before,'B')};
  const scoreboard=structuredClone(before);registrarPunto(scoreboard,'B');
  scoreboard.sync_torneo_status='synced';scoreboard.synced_to_torneo_at=time;
  return {torneos:[torneo],partidos,equipos,scoreboard_partidos:[scoreboard],scoreboard_historial_puntos:[point]};
}
function db(tables, beforeWrite) {
 const writes=[];
 return {writes,from(table){
  let filters=[],limitCount=Infinity,patch=null,single=false,descending=null;
  const q={select(){return q},eq(k,v){filters.push(r=>String(r[k])===String(v));return q},in(k,values){filters.push(r=>values.map(String).includes(String(r[k])));return q},is(k,v){filters.push(r=>r[k]===v);return q},order(k){descending=k;return q},limit(v){limitCount=v;return q},update(v){patch=v;return q},single(){single=true;return q},maybeSingle(){single=true;return q},then(resolve,reject){
   try {
    if(patch)beforeWrite?.(tables,table,patch);
    let chosen=(tables[table]??[]).filter(r=>filters.every(f=>f(r)));
    if(descending) chosen.sort((a,b)=>String(b[descending]).localeCompare(String(a[descending])));
    chosen=chosen.slice(0,limitCount);
    if(patch){chosen.forEach(r=>Object.assign(r,patch));writes.push({table,patch,count:chosen.length});}
    resolve({data:structuredClone(single?(chosen[0]??null):chosen),error:null});
   } catch(e){reject(e)}
  }};return q;
 }};
}
const evidence=t=>getTournamentCompletionEvidence(t.torneos[0],t.partidos,t.equipos);
const close=(client,t)=>completeTournamentFromFinalScoreboard(client,{scoreboardId:'sb-final',partidoId:t.partidos.at(-1).id},{now:new Date(time)});

test('linked brackets 4/8/16 select actual champion with numeric rounds',()=>{
 for(const n of [4,8,16]){const t=fixture(n);const e=evidence(t);assert.equal(e.verified,true);assert.equal(e.ganador_equipo_id,t.partidos.at(-1).equipo_b_id);const r=buildFinalRankingForTorneo({equipos:t.equipos,partidos:t.partidos,tipoTorneo:'knockout'});assert.equal(r.rankingRows[0].equipo_id,e.ganador_equipo_id);}
});
test('last recorded winning point is replayed using actual scorer',()=>{const t=fixture();assert.equal(isTerminalScoreboardPoint(t.scoreboard_partidos[0],t.scoreboard_historial_puntos[0]),true)});
for(const [name,mutate] of [
 ['arbitrary earlier point',p=>p.score_b_antes=0],['wrong scoreboard',p=>p.partido_id='other'],['point after sync',p=>p.timestamp='2026-10-01'],['already finished',p=>p.estado_antes='terminado'],['missing history',p=>delete p.historial_sets_antes],['wrong side',p=>p.equipo='A']
])test(`rejects ${name}`,()=>{const t=fixture();mutate(t.scoreboard_historial_puntos[0]);assert.equal(isTerminalScoreboardPoint(t.scoreboard_partidos[0],t.scoreboard_historial_puntos[0]),false)});
test('last point closes only tournament with server date, no ranking/XP/credit writes',async()=>{const t=fixture(),c=db(t);assert.equal((await close(c,t)).status,'completed');assert.equal(t.torneos[0].fecha_fin,'2026-09-10');assert.deepEqual(c.writes.map(w=>w.table),['torneos']);assert.equal(c.writes[0].patch.estado,'finalizado')});
test('retry is idempotent and cannot move closure into another month',async()=>{const t=fixture(),c=db(t);await close(c,t);const first=t.torneos[0].updated_at;assert.equal((await completeTournamentFromFinalScoreboard(c,{scoreboardId:'sb-final',partidoId:7},{now:new Date('2026-10-05')})).status,'idempotent');assert.equal(t.torneos[0].fecha_fin,'2026-09-10');assert.equal(t.torneos[0].updated_at,first);assert.equal(c.writes.length,1)});
test('CAS detects concurrent tournament modification without closing',async()=>{const t=fixture(),c=db(t,(tables)=>tables.torneos[0].updated_at='2026-09-10T19:00:00Z');assert.equal((await close(c,t)).status,'conflict');assert.equal(t.torneos[0].estado,'en_curso');assert.equal(c.writes[0].count,0)});
for(const [name,mutate] of [
 ['unfinished final',t=>t.partidos.at(-1).estado='en_curso'],['contradictory champion',t=>t.partidos.at(-1).ganador_equipo_id=1],['missing semifinal',t=>t.partidos.splice(4,1)],['broken advancement',t=>t.partidos[0].partido_siguiente_id=7],['cancelled match',t=>t.partidos[0].estado='cancelado'],['failed sync',t=>t.scoreboard_partidos[0].sync_torneo_status='failed'],['different venue',t=>t.scoreboard_partidos[0].sede_id=777],['missing deciding point',t=>t.scoreboard_historial_puntos=[]],['manual final with no scoreboard',t=>t.scoreboard_partidos=[]],['other sport',t=>t.torneos[0].deporte='tenis'],['cancelled tournament',t=>t.torneos[0].estado='cancelado']
])test(`no auto close: ${name}`,async()=>{const t=fixture();mutate(t);const c=db(t);assert.equal((await close(c,t)).status,'skipped');assert.equal(c.writes.length,0)});
test('manual final remains allowed, while missing final is rejected',async()=>{const t=fixture(),c=db(t);t.scoreboard_partidos=[];const {patch}=await prepareTournamentUpdate(c,100,{estado:'finalizado',fecha_fin:'2026-01-01'},new Date(time));assert.equal(patch.fecha_fin,'2026-09-10');t.partidos.at(-1).estado='en_curso';await assert.rejects(prepareTournamentUpdate(c,100,{estado:'finalizado'}),e=>e.code==='TORNEO_CLOSURE_UNVERIFIED')});
test('closed date immutable; explicit reopen loses closed state and active final cannot reclose',async()=>{const t=fixture(),c=db(t);await close(c,t);const {patch}=await prepareTournamentUpdate(c,100,{fecha_fin:'2026-10-01'});assert.equal(patch.fecha_fin,'2026-09-10');const reopening=await prepareTournamentUpdate(c,100,{estado:'en_curso'});Object.assign(t.torneos[0],reopening.patch);assert.equal(t.torneos[0].estado,'en_curso');t.partidos.at(-1).estado='en_curso';await assert.rejects(prepareTournamentUpdate(c,100,{estado:'finalizado'}),/Completa/)});
test('finished scoreboard rejects reset/undo mutation through existing guard',()=>{assert.throws(()=>assertScoreboardMutable(fixture().scoreboard_partidos[0]))});
test('legacy two-team final manually closes without invented bracket',async()=>{const t=fixture(4);t.partidos=[{...t.partidos.at(-1),id:1,bracket_round:null,bracket_position:null,partido_siguiente_id:null,ronda:'final'}];t.equipos=t.equipos.filter(e=>[t.partidos[0].equipo_a_id,t.partidos[0].equipo_b_id].includes(e.id));assert.equal(evidence(t).verified,true);assert.equal((await prepareTournamentUpdate(db(t),100,{estado:'finalizado'},new Date(time))).patch.estado,'finalizado')});
test('legacy empty tournament cannot close based on first team registration',()=>{const t=fixture();t.partidos=[];assert.equal(evidence(t).verified,false)});
test('general standings keep manual league closure and do not auto close',async()=>{const t=fixture(4);t.torneos[0].tipo_torneo='liga';t.partidos=t.partidos.map(p=>({...p,grupo:'A',bracket_round:null,partido_siguiente_id:null}));assert.equal(evidence(t).verified,true);assert.equal((await close(db(t),t)).status,'skipped')});

// Execute the actual server PUT handler with synthetic auth/storage; no server startup/env.
function putHandler(client,authorized=true){const text=fs.readFileSync(new URL('../server.js',import.meta.url),'utf8');const start=text.indexOf("app.put('/api/torneos/:id',");const end=text.indexOf("app.delete('/api/torneos/:id'",start);let handler;vm.runInNewContext(text.slice(start,end),{app:{put(_p,fn){handler=fn}},supabase:client,supabaseAdmin:client,requireTorneoAdminByTorneoId:async()=>authorized?{}:null,prepareTournamentUpdate,sendHttpError(res,e){res.status(e.status??500).json({code:e.code})},Date});return handler}
function response(){return {statusCode:200,body:null,status(c){this.statusCode=c;return this},json(x){this.body=x;return this}}}
test('actual PUT rejects state-only closure without sporting result and writes nothing',async()=>{const t=fixture();t.partidos.at(-1).estado='pendiente';const c=db(t),r=response();await putHandler(c)({params:{id:100},body:{estado:'finalizado'}},r);assert.equal(r.statusCode,409);assert.equal(c.writes.length,0)});
test('actual PUT preserves venue auth before reading or writing',async()=>{const r=response();await putHandler({from(){throw Error('must not read')}},false)({params:{id:100},body:{estado:'finalizado'}},r);assert.equal(r.body,null)});
test('actual PUT completes manual result and chooses server day',async()=>{const t=fixture(),c=db(t),r=response();await putHandler(c)({params:{id:100},body:{estado:'finalizado',fecha_fin:'2020-01-01'}},r);assert.equal(r.statusCode,200);assert.equal(t.torneos[0].estado,'finalizado');assert.notEqual(t.torneos[0].fecha_fin,'2020-01-01')});

test('two groups of four + semifinal/final close after 15 results, 14 may be manual',async()=>{
 const t=fixture(4);t.torneos[0].tipo_torneo='grupos_knockout';t.equipos=Array.from({length:8},(_,i)=>({id:i+1,torneo_id:100}));
 let next=4;const groups=[];
 for(const [name,teams] of [['A',[1,2,5,6]],['B',[3,4,7,8]]])for(let a=0;a<teams.length;a++)for(let b=a+1;b<teams.length;b++)groups.push({id:next++,torneo_id:100,grupo:name,estado:'finalizado',equipo_a_id:teams[a],equipo_b_id:teams[b],ganador_equipo_id:teams[a],resultado:{goles_a:2,goles_b:0,fuente_resultado:'manual_admin'}});
 t.partidos=[...groups,...t.partidos];assert.equal(t.partidos.length,15);const e=evidence(t);assert.equal(e.verified,true);const c=db(t);assert.equal((await close(c,t)).status,'completed');assert.equal(c.writes.length,1);
});
test('missing group result cannot close a bracket whose final already finished',()=>{const t=fixture();t.torneos[0].tipo_torneo='grupos_knockout';assert.equal(evidence(t).verified,false)});
test('draw in a knockout cannot invent B as champion',()=>{const t=fixture();t.partidos.at(-1).resultado={goles_a:2,goles_b:2};t.partidos.at(-1).ganador_equipo_id=null;assert.equal(evidence(t).verified,false)});
test('final champion field must have actually been persisted by the sync',async()=>{const t=fixture();t.partidos.at(-1).ganador_equipo_id=null;const c=db(t);assert.equal((await close(c,t)).status,'skipped');assert.equal(c.writes.length,0)});
test('actual point completion hook invokes verified closure after sync and bracket effects',async()=>{
 const { maybeSyncTorneoAfterScoreboardTerminated }=await import('../routes/scoreboard.js');
 const t=fixture(),c=db(t),order=[];
 await maybeSyncTorneoAfterScoreboardTerminated(c,t.scoreboard_partidos[0],'en_curso',{
  syncScoreboardToTorneoPartido:async()=>{order.push('sync');return {status:'synced'}},
  onPartidoTorneoFinalizado:async()=>{order.push('bracket');return {advance:{status:'skipped',reason:'no_destino'}}},
  completeTournamentFromFinalScoreboard:async(...args)=>{order.push('close');return completeTournamentFromFinalScoreboard(...args,{now:new Date(time)})},
 });
 assert.deepEqual(order,['sync','bracket','close']);assert.equal(t.torneos[0].estado,'finalizado');
});
test('PUT concurrent edit returns 409 and cannot revive stale closure',async()=>{const t=fixture(),c=db(t,tables=>tables.torneos[0].updated_at='2026-12-01'),r=response();await putHandler(c)({params:{id:100},body:{estado:'finalizado'}},r);assert.equal(r.statusCode,409);assert.equal(t.torneos[0].estado,'en_curso')});

// The existing explicit finalization route is also gated before ranking writes.
test('actual POST finalizar rejects empty results before touching ranking/XP',async()=>{
 const t=fixture();t.partidos=[];const c=db(t),r=response();const text=fs.readFileSync(new URL('../server.js',import.meta.url),'utf8');
 const start=text.indexOf("app.post('/api/torneos/:id/finalizar',"),end=text.indexOf("app.get('/api/torneos/:id/tabla'",start);let handler;
 vm.runInNewContext(text.slice(start,end),{app:{post(_p,fn){handler=fn}},supabase:c,supabaseAdmin:c,requireTorneoAdminByTorneoId:async()=>({}),getTournamentCompletionEvidence,sendHttpError(res,e){res.status(e.status??500).json({code:e.code})},Date,console});
 await handler({params:{id:100},body:{}},r);assert.equal(r.statusCode,409);assert.equal(r.body.code,'TORNEO_CLOSURE_UNVERIFIED');assert.equal(c.writes.length,0);
});

test('delayed first closure uses original server sync month, not retry month',async()=>{const t=fixture(),c=db(t);const result=await completeTournamentFromFinalScoreboard(c,{scoreboardId:'sb-final',partidoId:7},{now:new Date('2026-10-01')});assert.equal(result.status,'completed');assert.equal(t.torneos[0].fecha_fin,'2026-09-10')});

async function summary(t) { const { getTorneosResumenStats }=await import('./torneos/torneosResumenStatsService.js');const c=db(t);const result=await getTorneosResumenStats(c,{role:{rol:'admin_club',sede_id:9},query:{torneo_ids:'100'}});assert.equal(c.writes.length,0);return result; }
test('summary shows champion from closed digital final with no ranking points',async()=>{const t=fixture(),c=db(t);t.equipos.at(-4).nombre='Pareja campeona';await close(c,t);const result=await summary(t);assert.equal(result.items[0].winner_equipo_id,'5');assert.equal(result.items[0].winner_nombre,'Pareja campeona');assert.equal(result.items[0].partidos_jugados,7);assert.equal(result.meta.query_count,4);assert.equal(t.tabla_puntos,undefined)});
test('summary keeps existing ranking podium for legacy compatibility',async()=>{const t=fixture();t.torneos[0].estado='finalizado';t.tabla_puntos=[{torneo_id:100,equipo_id:1,posicion:1}];assert.equal((await summary(t)).items[0].winner_equipo_id,'1')});
test('summary never infers champion for reopened or contradictory final',async()=>{const t=fixture();assert.equal((await summary(t)).items[0].winner_equipo_id,null);t.torneos[0].estado='finalizado';t.partidos.at(-1).ganador_equipo_id=1;assert.equal((await summary(t)).items[0].winner_equipo_id,null)});
