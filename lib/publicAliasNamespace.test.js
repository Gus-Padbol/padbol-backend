import test from 'node:test'; import assert from 'node:assert/strict';
import {isHandleTaken, normalizeHandle, escapeRegexLiteral} from './publicAliasNamespace.js';

// Stub for ownership/control flow only. SQL pattern semantics covered by real PG tests.
function fakeDb(rows) {
  const queries=[];
  return {queries, from(){return {select(){return this}, filter(field,operator,pattern){queries.push({field,operator,pattern}); return this},limit:async()=>({data:rows,error:null})}}};
}
const own={user_id:'OWN',alias:'nico',username:'nico_web',apodo:'Nico'};

test('normaliza @ inicial, trim y case; minimo 2', () => {
  assert.equal(normalizeHandle('  @NiCo '),'nico');
  assert.equal(normalizeHandle('a'),null);
  assert.equal(normalizeHandle('a@b'),null);
  assert.equal(normalizeHandle('a b'),null);
  assert.equal(normalizeHandle('a'.repeat(81)),null);
});
test('escape de metacaracteres regex', () => {
  assert.equal(escapeRegexLiteral('a.b[0]'), 'a\\.b\\[0\\]');
});
test('propio UUID disponible aunque alias coincida', async()=>{
  assert.equal((await isHandleTaken({supabaseAdmin:fakeDb([own]),handle:'@NiCo',userId:'OWN'})).taken,false);
});
test('otro UUID tomado', async()=>{
  assert.equal((await isHandleTaken({supabaseAdmin:fakeDb([own]),handle:'nico',userId:'OTHER'})).taken,true);
});
test('coincide por username/apodo', async()=>{
  assert.equal((await isHandleTaken({supabaseAdmin:fakeDb([own]),handle:'nico_web',userId:null})).taken,true);
  assert.equal((await isHandleTaken({supabaseAdmin:fakeDb([own]),handle:'NICO',userId:null})).taken,true);
});
test('queries separadas por campo (no OR string)', async()=>{
  const db=fakeDb([]); await isHandleTaken({supabaseAdmin:db,handle:'nico'});
  assert.deepEqual(db.queries.map(q=>q.field),['alias','username','apodo']);
});
test('error DB fail-closed', async()=>{
  const sb={from:()=>({select:function(){return this},filter:function(){return this},limit:async()=>({data:[],error:{message:'x'}})})};
  const r=await isHandleTaken({supabaseAdmin:sb,handle:'nico'}); assert.equal(r.error,true); assert.equal(r.taken,true);
});
