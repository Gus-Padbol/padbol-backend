import test from 'node:test';
import assert from 'node:assert/strict';
import { registrarPunto } from '../../utils/scoreboardLogic.js';
import { prepareCompletedGame as prepare } from './nationsGamesScoreboardBridge.js';
const base=()=>({id:'match1',estado:'en_curso',score_a:0,score_b:0,games_a:0,games_b:0,sets_a:0,sets_b:0,historial_sets:[],historial_puntos:[],es_tiebreak:false,saque_actual:'A',cronometro_inicio:'2026-11-10T00:00:00Z',cronometro_segundos:17,cronometro_pausado:false});
const step=(before,side='A')=>{const after=structuredClone(before);registrarPunto(after,side);return {after,event:prepare({before,after,activePlayers:['p1','p2'],eventId:'point-1'})};};
test('actual score engine counts one game only on winning point and preserves duration clock',()=>{
 let row=base();for(let i=0;i<3;i++){const r=step(row);assert.equal(r.event,null);row=r.after;}
 const r=step(row);assert.equal(r.event.number,1);assert.equal(r.event.set,1);
 for(const key of ['cronometro_inicio','cronometro_segundos','cronometro_pausado']) assert.equal(r.after[key],row[key]);
});
test('actual set rollover keeps sixth game instead of losing it when counters reset',()=>{
 const row={...base(),games_a:5,score_a:40};const r=step(row);assert.equal(r.after.games_a,0);assert.equal(r.event.number,6);assert.equal(r.event.set,1);assert.equal(r.after.historial_sets.length,1);
});
test('actual tie-break finish counts one game, not seven points as games',()=>{
 const row={...base(),games_a:6,games_b:6,es_tiebreak:true,score_a:6,score_b:4};const r=step(row);assert.equal(r.event.number,13);assert.equal(r.event.set,1);assert.equal(r.after.historial_sets[0].a,7);
});
test('late timeline, score reset/undo and changed earlier sets fail closed',()=>{
 const before=base();assert.throws(()=>prepare({before,after:{...before,games_a:2},activePlayers:['a','b'],eventId:'x'}),{code:'GAME_LEDGER_GAP'});
 assert.throws(()=>prepare({before:{...before,games_a:1},after:before,activePlayers:['a','b'],eventId:'x'}),{code:'GAME_UNDO_REQUIRES_LEDGER_REVERSAL'});
 const old={...before,historial_sets:[{set:1,a:6,b:3}]};assert.throws(()=>prepare({before:old,after:{...old,historial_sets:[{set:1,a:5,b:4}]},activePlayers:['a','b'],eventId:'x'}),{code:'SET_HISTORY_CHANGED'});
});
test('winning game needs exact pair and stable match identity',()=>{
 const before={...base(),score_a:40},after=structuredClone(before);registrarPunto(after,'A');
 assert.throws(()=>prepare({before,after,activePlayers:['a','a'],eventId:'x'}));assert.throws(()=>prepare({before,after:{...after,id:'other'},activePlayers:['a','b'],eventId:'x'}));
});
