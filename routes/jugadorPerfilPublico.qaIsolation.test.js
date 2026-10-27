import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchTorneosStatsPg } from './jugadorPerfilPublico.js';

test('QA winner never contributes public tournaments, wins or history',async()=>{
 const calls=[];const pg={async query(sql,values){calls.push({sql,values});return {rows:[{torneo_id:39,equipo_id:399,nombre:'QA',estado:'finalizado',es_prueba:true,posicion:1}]};}};
 const stats=await fetchTorneosStatsPg(pg,[399]);
 assert.deepEqual(stats,{torneos_jugados:0,torneos_ganados:0,partidos_jugados:0,partidos_ganados:0,historial_torneos:[],torneos_recientes:[]});
 assert.equal(calls.length,1);assert.match(calls[0].sql,/COALESCE\(t.es_prueba, false\) = false/);
});

test('mixed public history retains real/legacy tournament and never reads QA matches',async()=>{
 const calls=[];const pg={async query(sql,values){calls.push({sql,values});if(sql.includes('FROM partidos'))return {rows:[]};return {rows:[{torneo_id:39,equipo_id:399,estado:'finalizado',es_prueba:true,posicion:1},{torneo_id:2,equipo_id:20,estado:'finalizado',es_prueba:false,posicion:1},{torneo_id:3,equipo_id:30,estado:'finalizado',posicion:2}]};}};
 const stats=await fetchTorneosStatsPg(pg,[399,20,30]);
 assert.equal(stats.torneos_jugados,2);assert.equal(stats.torneos_ganados,1);
 assert.deepEqual(stats.historial_torneos.map(t=>t.torneo_id).sort(),[2,3]);
 assert.deepEqual(calls[1].values,[[2,3]]);
});
