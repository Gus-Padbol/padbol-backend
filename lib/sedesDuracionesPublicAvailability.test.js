import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mountSedesDuracionesRoutes} from '../routes/sedesDuraciones.js';
function setup(rows){
 const handlers=new Map();const app=Object.fromEntries(['get','post','patch','delete'].map(m=>[m,(path,handler)=>handlers.set(`${m} ${path}`,handler)]));
 const db={from(){const q={select(){return q},eq(){return q},order(){return q},or(){return q},then(resolve){return Promise.resolve({data:rows,error:null}).then(resolve)}};return q}};
 mountSedesDuracionesRoutes(app,{supabaseAdmin:db});return handlers.get('get /api/sedes/:id/duraciones-disponibles');
}
async function request(rows){const res={json(body){this.body=body;return this},status(code){this.code=code;return this}};await setup(rows)({params:{id:'1'},query:{deporte:'padbol'}},res);return res.body;}
test('distingue sede legacy sin filas de duración explícitamente inactiva',async()=>{
 assert.deepEqual((await request([])).configurada,false);
 const result=await request([{id:1,duracion_minutos:120,precio:30000,deporte:null,activo:false}]);
 assert.equal(result.configurada,true);assert.deepEqual(result.duraciones,[]);
});
test('solo expone ofertas activas y conserva las específicas y base',async()=>{
 const result=await request([{id:1,duracion_minutos:60,precio:20000,deporte:null,activo:true},{id:2,duracion_minutos:60,precio:26000,deporte:'padbol',activo:true},{id:3,duracion_minutos:120,precio:30000,deporte:null,activo:false}]);
 assert.equal(result.configurada,true);assert.equal(result.duraciones.length,2);assert.equal(result.duraciones.some(r=>r.duracion_minutos===120),false);
});
