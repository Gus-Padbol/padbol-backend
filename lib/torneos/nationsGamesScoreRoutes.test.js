import test from 'node:test';import assert from 'node:assert/strict';
import {fixture,memoryDb,handlers} from '../scoreboardSportGuard.test.js';
import {mountScoreboardRoutes} from '../../routes/scoreboard.js';
const requestId='10000000-0000-4000-8000-000000000001';
function setup(options={}){
 const tables=fixture({sport:'padbol',overrides:{updated_at:'2026-11-10T00:00:00Z'}}),db=memoryDb(tables),receipts=new Map(),queries=[];
 const client={async query(sql,args){queries.push(sql);
  if(sql.startsWith('SELECT match_id'))return {rows:[{match_id:tables.scoreboard_partidos[0].id}]};
  if(sql.startsWith('SELECT * FROM public.scoreboard'))return {rows:[structuredClone(tables.scoreboard_partidos[0])]};
  if(sql.startsWith('SELECT games_epoch'))return {rows:[{games_epoch:0,tracking_status:'active'}]};
  if(sql.startsWith('SELECT command'))return {rows:receipts.has(args[1])?[receipts.get(args[1])]:[]};
  if(sql.includes('commit_games_command_candidate')){const command=JSON.parse(args[2]),next=JSON.parse(args[4]);const {data}=await db.rpc('scoreboard_commit_mutation',{p_id:args[0],p_expected_updated_at:args[3],p_kind:command.kind==='reset'?'update':command.kind,p_next:next,p_history:args[5]?JSON.parse(args[5]):null,p_history_id:args[6]});receipts.set(args[1],{command,result:data});return {rows:[{result:{...data,gamesEpoch:0,trackingStatus:'active'}}]};}
  return {rows:[]};},release(){}};
 const pool={query:client.query,connect:async()=>client};
 const invoke=handlers(db,(app,deps)=>mountScoreboardRoutes(app,{...deps,nationsGamesEnabled:true,nationsGamesPool:pool}),options);
 return {tables,db,receipts,queries,invoke};
}
test('actual authenticated point route uses stable receipt and strips private columns',async()=>{const f=setup();const path='/api/scoreboard/partidos/:id/punto/:equipo';const first=await f.invoke(path,{equipo:'A'},'post',{requestId,epoch:0});assert.equal(first.status,200);assert.equal(first.body.score_a,15);assert.equal(first.body.control_token_hash,undefined);const count=f.db.writes.length;const retry=await f.invoke(path,{equipo:'A'},'post',{requestId,epoch:0});assert.equal(retry.status,200);assert.equal(retry.body.score_a,15);assert.equal(f.db.writes.length,count);});
test('actual undo retry bypasses empty history only for matching stored command',async()=>{const f=setup();f.receipts.set(requestId,{command:{kind:'undo',actorId:'synthetic-user',epoch:0,historyId:requestId},result:{score_a:999}});f.tables.scoreboard_partidos[0].estado='terminado';const r=await f.invoke('/api/scoreboard/partidos/:id/undo',{},'post',{requestId,epoch:0});assert.equal(r.status,200);assert.equal(r.body.score_a,0);assert.equal(f.db.writes.length,0);});
test('route authorization rejects before transaction or receipt lookup',async()=>{for(const options of [{authenticated:false},{role:'admin_sede'}]){const f=setup(options);const r=await f.invoke('/api/scoreboard/partidos/:id/undo',{},'post',{requestId,epoch:0});assert.ok([401,403].includes(r.status));assert.equal(f.queries.length,0);}});
test('tracked route rejects missing request id, no legacy mutation',async()=>{const f=setup();const r=await f.invoke('/api/scoreboard/partidos/:id/punto/:equipo',{equipo:'A'});assert.equal(r.status,400);assert.equal(f.db.writes.length,0);});
