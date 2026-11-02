import test from 'node:test';
import assert from 'node:assert/strict';
import {rejectPendingSede} from './sedePendingRejection.js';
const fixture=result=>{const clauses=[];const q={update(value){clauses.push(['update',value]);return q;},eq(k,v){clauses.push([k,v]);return q;},select(v){clauses.push(['select',v]);return q;},async maybeSingle(){return result;}};return {clauses,db:{from(t){assert.equal(t,'sedes_pendientes');return q;}}};};
test('rejection requires pending compare-and-set and acknowledged returned ID',async()=>{
 const f=fixture({data:{id:7},error:null});assert.equal((await rejectPendingSede({db:f.db,requestId:7,reason:' Synthetic reason '})).ok,true);
 assert.deepEqual(f.clauses,[['update',{estado:'rechazada',motivo_rechazo:'Synthetic reason'}],['id',7],['estado','pendiente'],['select','id']]);
 for(const result of [{data:null,error:null},{data:{id:8},error:null},{data:null,error:{message:'secret'}}]){
  await assert.rejects(rejectPendingSede({db:fixture(result).db,requestId:7,reason:'Synthetic'}),e=>e.status===(result.error?503:409)&&!e.message.includes('secret'));
 }
});
test('invalid rejection does not contact the database',async()=>{
 const db={from(){throw Error('must not query');}};
 for(const [requestId,reason] of [[0,'test'],[1.5,'test'],[7,''],[7,'x'.repeat(2001)]])await assert.rejects(rejectPendingSede({db,requestId,reason}),e=>e.status===400);
});
