import test from 'node:test'; import assert from 'node:assert/strict';
import {isHandleTaken} from './publicAliasNamespace.js';
const rows=[{user_id:'OWN',alias:'nico',username:'nico_web',apodo:'Nico'}];
function fake(data=rows,error=null){return {from(){return {select(){return this},or(){return this},limit:async()=>({data,error})}}};}
test('mismo UUID: disponible aunque alias coincida',async()=>{const r=await isHandleTaken({supabaseAdmin:fake(),handle:'nico',userId:'OWN'});assert.equal(r.taken,false);});
test('otro UUID: tomado',async()=>{assert.equal((await isHandleTaken({supabaseAdmin:fake(),handle:'nico',userId:'OTRO'})).taken,true);});
test('coincide por apodo/username aunque alias distinto',async()=>{assert.equal((await isHandleTaken({supabaseAdmin:fake([{user_id:'X',alias:'a',username:'nico_web',apodo:'z'}]),handle:'nico_web',userId:null})).taken,true);});
test('escape literal de % y _ no comodin',async()=>{let captured='';const sb={from(){return {select(){return this},or(q){captured=q;return this},limit:async()=>({data:[],error:null})}}};await isHandleTaken({supabaseAdmin:sb,handle:'a%b_c'});assert.match(captured, /a\\%b\\_c/);});
test('error de DB => taken (fail closed)',async()=>{const r=await isHandleTaken({supabaseAdmin:fake([],{message:'x'}),handle:'nico'});assert.equal(r.error,true);assert.equal(r.taken,true);});
test('handle con @ o >80 invalido',async()=>{assert.equal((await isHandleTaken({supabaseAdmin:fake(),handle:'a@b'})).invalid,true);});
