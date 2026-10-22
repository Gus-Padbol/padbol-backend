import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,handlers,memoryDb} from './scoreboardSportGuard.test.js';
import {mountScoreboardRoutes} from '../routes/scoreboard.js';
const input={updated_at:'2026-10-22T12:00:00Z',confirm:true,reason:'Recuperación',completed_sets:[{a:6,b:2},{a:4,b:6}],games_a:5,games_b:4,score_a:30,score_b:15,saque_actual:'A',es_tiebreak:false};
test('corrección de parcial exige autorización y confirmación', async()=>{
 const db=memoryDb(fixture({sport:'padbol'})); let called=0;
 db.rpc=async(_name,args)=>{called++;return {data:{id:'synthetic-scoreboard',sede_id:1,...args.p_score},error:null}};
 const call=(options,body)=>handlers(db,mountScoreboardRoutes,options)('/api/scoreboard/partidos/:id/correccion-parcial',{},'post',body);
 assert.equal((await call({authenticated:false},input)).status,401);
 assert.equal((await call({role:'admin_sede'},input)).status,403);
 assert.equal((await call({role:'super_admin'},{...input,confirm:false})).status,400);
 assert.equal(called,0);
 assert.equal((await call({role:'super_admin'},input)).status,200);
 assert.equal(called,1);
});
