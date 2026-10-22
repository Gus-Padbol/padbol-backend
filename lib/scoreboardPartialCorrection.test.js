import test from 'node:test';
import assert from 'node:assert/strict';
import {validatePartialCorrection} from '../src/scoreboard/scoreboardPartialCorrection.js';
const good={updated_at:'2026-10-22T12:00:00Z',confirm:true,reason:'Recuperación',completed_sets:[{a:6,b:2},{a:4,b:6}],games_a:5,games_b:4,score_a:30,score_b:15,saque_actual:'A',es_tiebreak:false};
test('acepta parcial de tres sets sin finalizar',()=>{let r=validatePartialCorrection(good);assert.equal(r.state.sets_a,1);assert.equal(r.state.sets_b,1);assert.equal(r.state.games_a,5);assert.equal(r.state.score_a,30)});
test('rechaza resultado final, marcador incoherente y falta de confirmación',()=>{for(const v of [{completed_sets:[{a:6,b:2},{a:6,b:4}]},{games_a:6,games_b:3},{score_a:45,score_b:15},{confirm:false},{reason:''},{es_tiebreak:true}])assert.throws(()=>validatePartialCorrection({...good,...v}),{status:400})});
