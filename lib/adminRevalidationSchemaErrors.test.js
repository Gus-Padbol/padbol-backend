import test from 'node:test';
import assert from 'node:assert/strict';
import { registerModuloClasesRoutes } from './moduloClases.js';
import { registerSedeIncentiveRoutes } from './sedeIncentivesV4.js';

function response() { return { statusCode:200,status(code){this.statusCode=code;return this;},json(value){this.body=value;return this;} }; }
function routes() { const handlers=new Map(); const app=Object.fromEntries(['get','post','patch','delete','put'].map(method=>[method,(path,handler)=>handlers.set(`${method} ${path}`,handler)])); return {handlers,app}; }
test('admin profesores preserves authorization and hides database metadata on schema failure',async()=>{
 const {app,handlers}=routes();let reads=0;
 const db={from(){reads++;const q={select(){return q;},eq(){return q;},order(){return Promise.resolve({error:{code:'42703',message:'column profesores.especialidad does not exist'}});}};return q;}};
 registerModuloClasesRoutes(app,{supabaseAdmin:db,adminListScopeFromRequest:async()=>({superA:true}),assertUsuarioPuedeAdministrarSede:async()=>{}});
 const res=response();await handlers.get('get /api/admin/profesores')({query:{sede_id:'7'}},res);
 assert.equal(reads,1);assert.equal(res.statusCode,500);assert.doesNotMatch(res.body.error,/column|profesores|especialidad/i);
});
test('missing incentives schema returns retryable503 instead of false empty list or database internals',async()=>{
 const {app,handlers}=routes();
 const db={from(){const q={select(){return q;},in(){return q;},eq(){return Promise.resolve({error:{code:'PGRST205',message:"Could not find table public.sede_programas_beneficios"}});}};return q;}};
 registerSedeIncentiveRoutes(app,{supabase:db,adminListScopeFromRequest:async()=>({}),assertUsuarioPuedeAdministrarSede:async()=>{}});
 const res=response();await handlers.get('get /api/admin/incentivos')({query:{sede_id:'7'}},res);
 assert.equal(res.statusCode,503);assert.equal(res.body.code,'INCENTIVES_SCHEMA_UNAVAILABLE');assert.doesNotMatch(res.body.error,/public|table|beneficios/i);assert.equal(res.body.programs,undefined);
});
