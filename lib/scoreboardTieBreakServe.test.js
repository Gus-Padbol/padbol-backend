import test from 'node:test';
import assert from 'node:assert/strict';
import {registrarPunto} from '../utils/scoreboardLogic.js';
function marker(){return {estado:'en_curso',saque_actual:'A',score_a:0,score_b:0,games_a:6,games_b:6,sets_a:0,sets_b:0,historial_sets:[],historial_puntos:[],es_tiebreak:true}}
test('tie-break: primer saque uno, luego turnos de dos y siguiente set contrario al primero',()=>{
 const m=marker(); const expected=['B','B','A','A','B','B'];
 for(const next of expected){registrarPunto(m,'A');assert.equal(m.saque_actual,next)}
 registrarPunto(m,'A'); assert.equal(m.es_tiebreak,false);assert.equal(m.saque_actual,'B');assert.deepEqual(m.historial_sets,[{set:1,a:7,b:6}]);
});
test('tie-break largo mantiene secuencia y saque de siguiente set',()=>{
 const m=marker();for(let i=0;i<6;i++){registrarPunto(m,'A');registrarPunto(m,'B')};registrarPunto(m,'A');registrarPunto(m,'A');assert.equal(m.saque_actual,'B');assert.equal(m.sets_a,1)
});
