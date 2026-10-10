import test from 'node:test';
import assert from 'node:assert/strict';
import { listPadcoinsSedeConfig } from '../src/padcoins/padcoinsSedeConfigService.js';
function client({venues=[],configs=[],errorTable}={}) {
 const calls=[];
 return {calls,from(table){calls.push(table);const q={select(){return q},order(){return Promise.resolve({data:table==='sedes'?venues:configs,error:table===errorTable?{code:'failure'}:null})}};return q}};
}
test('all four real venues listed while only one opts in; no writes or inferred activation',async()=>{
 const db=client({venues:[1,2,3,4].map(id=>({id,nombre:`Sede ${id}`})),configs:[{id:10,sede_id:1,activo:true}]});
 const rows=await listPadcoinsSedeConfig(db);
 assert.equal(rows.length,4);assert.equal(rows.filter(r=>r.participa).length,1);
 assert.deepEqual(rows.map(r=>r.sede_nombre),['Sede 1','Sede 2','Sede 3','Sede 4']);
 assert.deepEqual(rows.slice(1).map(r=>[r.id,r.activo,r.participa]),[[null,false,false],[null,false,false],[null,false,false]]);
 assert.deepEqual(db.calls,['sedes','padcoins_sede_config']);
});
test('canonical names and date windows preserved, orphan configuration does not invent a venue',async()=>{
 const rows=await listPadcoinsSedeConfig(client({venues:[{id:1,nombre:'Canonical'}],configs:[{sede_id:1,activo:true,fecha_inicio:'2099-01-01'}, {sede_id:99,activo:true}]}),{now:new Date('2026-10-10')});
 assert.equal(rows.length,1);assert.equal(rows[0].sede_nombre,'Canonical');assert.equal(rows[0].activo,true);assert.equal(rows[0].participa,false);
});
test('failed venue/config reads reject instead of reporting a false empty or inactive list',async()=>{
 for(const errorTable of ['sedes','padcoins_sede_config']) await assert.rejects(listPadcoinsSedeConfig(client({errorTable})));
 assert.deepEqual(await listPadcoinsSedeConfig(client()),[]);
});
