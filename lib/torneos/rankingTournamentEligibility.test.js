import test from 'node:test';
import assert from 'node:assert/strict';
import { rankingTournamentEligible } from './rankingTournamentEligibility.js';

test('ranking excludes only explicit QA marker across national and legacy tournament inputs',()=>{
 const events=[{id:1,es_prueba:true,nombre:'Real-looking name'},{id:2,es_prueba:false,nombre:'QA name does not imply test'},{id:3},{id:4,es_prueba:null}];
 assert.deepEqual(events.filter(rankingTournamentEligible).map(t=>t.id),[2,3,4]);
});

test('ordinary tournament creation cannot set or clear the service marker',async()=>{
 const {buildCrearTorneoPayload}=await import('./crearTorneoPayload.js');
 for(const value of [true,false]) {
  const payload=buildCrearTorneoPayload({nombre:'Prueba de permisos',sede_id:7,deporte:'padbol',es_prueba:value},'actor');
  assert.equal(Object.hasOwn(payload,'es_prueba'),false);
 }
});
