import test from 'node:test'; import assert from 'node:assert/strict';
import {isHandleTaken, normalizeHandle, escapeLikeLiteral} from './publicAliasNamespace.js';

// Fake que interpreta ILIKE quoted con escapes y aplica igualdad literal normalizada.
function fakeDb(rows) {
  const queries=[];
  function builder(field, pattern) {
    queries.push({field, pattern});
    const lit = pattern.replace(/\\([\\%_"])/g, '$1').toLowerCase();
    const data = rows.filter((r) => {
      const v = String(r[field] ?? '').replace(/^@+/, '').trim().toLowerCase();
      return v === lit;
    });
    return {select(){return this}, ilike(f, p){return builder(f,p)}, limit: async()=>({data, error:null})};
  }
  return {queries, from(){return {select(){return this}, ilike(f,p){return builder(f,p)}}}};
}
const own={user_id:'OWN',alias:'nico',username:'nico_web',apodo:'Nico'};

test('normaliza @ inicial, trim y case; minimo 2', () => {
  assert.equal(normalizeHandle('  @NiCo '),'nico');
  assert.equal(normalizeHandle('a'),null);
  assert.equal(normalizeHandle('a@b'),null);
  assert.equal(normalizeHandle('a b'),null);
  assert.equal(normalizeHandle('a'.repeat(81)),null);
});
test('escape literal de % _ \\ y "', () => {
  assert.equal(escapeLikeLiteral('a%b_c\\d"e'), 'a\\%b\\_c\\\\d\\"e');
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
  const sb={from:()=>({select:function(){return this},ilike:function(){return this},limit:async()=>({data:[],error:{message:'x'}})})};
  const r=await isHandleTaken({supabaseAdmin:sb,handle:'nico'}); assert.equal(r.error,true); assert.equal(r.taken,true);
});
