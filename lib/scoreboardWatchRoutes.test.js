import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,handlers,memoryDb,SYNTHETIC_TOKEN} from './scoreboardSportGuard.test.js';
import {hashControlToken} from '../src/scoreboard/scoreboardControlToken.js';
import {mountScoreboardRoutes} from '../routes/scoreboard.js';
const path='/api/scoreboard/watch/v1/control/:token/commands';
function setup({sport='padbol',state={},session={},io=null,rpcError=null}={}){
 const t=fixture({sport,overrides:{revision:0,updated_at:'2026-10-28T18:00:00Z',...state}});
 t.scoreboard_control_sessions=[{id:'watch-session',scoreboard_id:'11111111-1111-4111-8111-111111111111',device_id:'watch-one',token_hash:hashControlToken(SYNTHETIC_TOKEN),expires_at:'2099-01-01T00:00:00Z',...session}];t.scoreboard_control_actions=[];
 const db=memoryDb(t);let calls=[];db.rpc=async(name,args)=>{calls.push({name,args});if(rpcError)return {data:null,error:rpcError};return {data:{status:'applied',revision:1,scoreboard:{...t.scoreboard_partidos[0],...args.p_next,revision:1,internal_future_secret:'must-not-leak'}},error:null}};
 return {t,db,calls,invoke:handlers(db,mountScoreboardRoutes,{io})};
}
const action={action_id:'action-0001',device_id:'watch-one',expected_revision:0,command:'punto',payload:{equipo:'A'}};
test('watch cannot bypass paused/sport guards or control a different device',async()=>{
 for(const options of [{state:{cronometro_pausado:true}},{sport:'pickleball'},{session:{device_id:'other-watch'}},{session:{revoked_at:'2026-10-28T00:00:00Z'}}]){
 const s=setup(options);const r=await s.invoke(path,{},'post',action);assert.ok([401,403,409].includes(r.status));assert.equal(s.calls.length,0);
 }
});
test('watch uses production atomic history and rejects stale revisions',async()=>{
 const s=setup();const r=await s.invoke(path,{},'post',action);assert.equal(r.status,200);assert.equal(s.calls[0].name,'scoreboard_apply_watch_action');assert.equal(s.calls[0].args.p_kind,'point');assert.equal(s.calls[0].args.p_history.equipo,'A');assert.equal(s.calls[0].args.p_next.score_a,15);assert.equal(r.body.scoreboard.control_token_hash,undefined);assert.equal(r.body.scoreboard.internal_future_secret,undefined);
 const stale=setup({state:{revision:3}});assert.equal((await stale.invoke(path,{},'post',action)).status,409);assert.equal(stale.calls.length,0);
});
test('retry returns original response after game finished without applying twice',async()=>{
 const s=setup({state:{estado:'terminado'}});s.t.scoreboard_control_actions.push({session_id:'watch-session',action_id:action.action_id,response:{status:'applied',revision:9,scoreboard:{id:'11111111-1111-4111-8111-111111111111',revision:9}}});
 const r=await s.invoke(path,{},'post',action);assert.equal(r.status,200);assert.equal(r.body.duplicate,true);assert.equal(s.calls.length,0);
});
test('watch creation requires authenticated authorized venue staff',async()=>{
 for(const options of [{authenticated:false},{role:'admin_sede'}]){
 const s=setup();const r=await handlers(s.db,mountScoreboardRoutes,options)('/api/scoreboard/partidos/:id/watch-sessions',{},'post',{});assert.ok([401,403].includes(r.status));assert.equal(s.db.writes.length,0);
 }
});

// Real Watch route + Supabase-shaped RPC receipt fixture; no PostgreSQL here.
// This proves notification error isolation, not new database durability.
test('watch003 accepted action survives throwing realtime emit without a second RPC', async () => {
 let emissions = 0;
 const io = { to: () => ({ emit() { emissions++; throw new Error('fixture transport down'); } }) };
 const s = setup({ io });
 const r = await s.invoke(path, {}, 'post', action);
 assert.equal(s.calls.length, 1);
 assert.equal(s.calls[0].name, 'scoreboard_apply_watch_action');
 assert.equal(emissions, 1, 'failure occurs in actual emit, after RPC receipt');
 assert.equal(r.status, 200);
 assert.equal(r.body.accepted, true);
 assert.equal(r.body.revision, 1);
 assert.equal(r.body.scoreboard.score_a, 15);
});
test('watch003 RPC failure and denied device never become successful responses', async () => {
 let emissions = 0;
 const io = { to: () => ({ emit() { emissions++; throw new Error('fixture transport down'); } }) };
 const failed = setup({ io, rpcError: new Error('fixture persistence rejected') });
 assert.equal((await failed.invoke(path, {}, 'post', action)).status, 500);
 assert.equal(failed.calls.length, 1);
 const denied = setup({ io, session: { device_id: 'different-device' } });
 const r = await denied.invoke(path, {}, 'post', action);
 assert.ok([401,403].includes(r.status));
 assert.equal(denied.calls.length, 0);
 assert.equal(emissions, 0);
});
