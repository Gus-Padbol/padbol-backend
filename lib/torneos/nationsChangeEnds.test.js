import test from 'node:test';import assert from 'node:assert/strict';
import {assertChangeEndsWindow,substitutionSwaps} from './nationsChangeEnds.js';
const row={estado:'en_curso',cronometro_pausado:false,es_tiebreak:false,score_a:0,score_b:0,games_a:1,games_b:0,historial_sets:[]};
test('odd games use current set, not cumulative completed-set parity',()=>{
 for(const n of [1,3,5,7])assert.doesNotThrow(()=>assertChangeEndsWindow({...row,games_a:n}));
 assert.doesNotThrow(()=>assertChangeEndsWindow({...row,historial_sets:[{a:7,b:6}]}));
 assert.doesNotThrow(()=>assertChangeEndsWindow({...row,games_a:0,historial_sets:[{a:7,b:6}]}));
 for(const r of [{games_a:0},{games_a:2},{games_a:0,historial_sets:[{a:6,b:0}]},{score_a:15},{score_b:15},{es_tiebreak:true},{cronometro_pausado:true},{estado:'terminado'},{games_a:null},{historial_sets:null}])assert.throws(()=>assertChangeEndsWindow({...row,...r}),{code:'CHANGE_ENDS_REQUIRED'});
});
test('one or both replacements validate against initial pair; never chain active entries',()=>{
 const st={active:['a','b'],roster:['a','b','c','d']};
 assert.deepEqual(substitutionSwaps({outId:'a',inId:'c'},st),[{outId:'a',inId:'c'}]);
 assert.equal(substitutionSwaps({swaps:[{outId:'a',inId:'c'},{outId:'b',inId:'d'}]},st).length,2);
 for(const swaps of [[],[{outId:'a',inId:'c'},{outId:'b',inId:'c'}],[{outId:'a',inId:'c'},{outId:'a',inId:'d'}]])assert.throws(()=>substitutionSwaps({swaps},st),{code:'SUBSTITUTION_BATCH_INVALID'});
 assert.throws(()=>substitutionSwaps({swaps:[{outId:'a',inId:'c'},{outId:'c',inId:'d'}]},st),{code:'OUT_NOT_ACTIVE'});
 assert.throws(()=>substitutionSwaps({swaps:[{outId:'a',inId:'c'},{outId:'b',inId:'x'}]},st),{code:'IN_NOT_IN_LINEUP'});
});
