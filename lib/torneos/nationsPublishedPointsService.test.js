import test from 'node:test';
import assert from 'node:assert/strict';
import {buildPublishedNationalPoints,loadPublishedNationalPoints} from './nationsPublishedPointsService.js';
const uid=n=>`aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12,'0')}`;
const event={id:1,nombre:'QA Cup',estado:'finalizado',deporte:'padbol',modalidad_plantel:'selecciones',plan_nations:{enabled:true},fecha_inicio:'2026-11-22',fecha_fin:'2026-11-22',nivel_torneo:'internacional'};
const team={id:10,torneo_id:1,nombre:'QA Team',modalidad_plantel:'selecciones',jugadores:Array.from({length:8},(_,i)=>({id:uid(i+1),nombre:`QA ${i+1}`,apellido:'Synthetic',email:`private${i}@reserved.invalid`,token:'DO_NOT_PUBLISH',pais:'IT'})),participantes_ranking:[uid(1),uid(2),uid(3),uid(4)]};
const point={torneo_id:1,equipo_id:10,posicion:1,puntos:300};
const options={isRevealed:()=>true};
const data=()=>({torneos:[structuredClone(event)],equipos:[structuredClone(team)],puntos:[{...point}]});
test('publish exactly four declared UUIDs from an eight-player roster, without private contact fields',()=>{
 const items=buildPublishedNationalPoints(data(),options);assert.equal(items.length,4);
 assert.deepEqual(items.map(r=>r.user_id),team.participantes_ranking);
 assert(items.every(r=>r.puntos===300&&r.ranking_oficial===false&&r.ranking_origen==='padbol_match_interno'));
 assert(!JSON.stringify(items).includes('private'));assert(!JSON.stringify(items).includes('token'));assert(!JSON.stringify(items).includes('DO_NOT_PUBLISH'));
});
test('public embargo is checked even for finalized events and ranking filters',()=>{
 assert.deepEqual(buildPublishedNationalPoints(data(),{isRevealed:()=>false,userId:uid(1)}),[]);
 assert.equal(buildPublishedNationalPoints(data(),{...options,userId:uid(4)}).length,1);
 assert.deepEqual(buildPublishedNationalPoints(data(),{...options,userId:uid(8)}),[]);
 assert.throws(()=>buildPublishedNationalPoints(data()),e=>e.code==='NATIONAL_POINTS_DATA_INVALID');
 assert.throws(()=>buildPublishedNationalPoints(data(),{...options,userId:'someone@example.com'}),e=>e.status===400);
});
test('never infer declaration from email/name and do not change source objects',()=>{
 const fixture=data();const before=JSON.stringify(fixture);fixture.equipos[0].jugadores[7].email=fixture.equipos[0].jugadores[0].email;
 const supplied=JSON.stringify(fixture);assert.equal(buildPublishedNationalPoints(fixture,options).length,4);assert.equal(JSON.stringify(fixture),supplied);
 assert.notEqual(supplied,before);
});
test('non-national and unfinished tournaments never enter this projection',()=>{
 for(const change of [{modalidad_plantel:'dobles'},{estado:'abierto'},{deporte:'padel'}]) {
  const fixture=data();Object.assign(fixture.torneos[0],change);assert.deepEqual(buildPublishedNationalPoints(fixture,options),[]);
 }
});
test('existing selections keep recorded participation without applying a new Nations embargo or inferring all eight',()=>{
 const fixture=data();fixture.torneos[0].plan_nations=null;
 assert.equal(buildPublishedNationalPoints(fixture,{isRevealed:()=>false}).length,4);
 fixture.equipos[0].participantes_ranking=null;assert.deepEqual(buildPublishedNationalPoints(fixture,options),[]);
 fixture.equipos[0].participantes_ranking=[];assert.deepEqual(buildPublishedNationalPoints(fixture,options),[]);
});
test('reject duplicate point rows, duplicate players and ledger identities outside the roster',()=>{
 for(const mutate of [f=>f.puntos.push({...point}),f=>f.equipos[0].jugadores.push({...f.equipos[0].jugadores[0]}),f=>f.equipos[0].participantes_ranking.push(uid(90)),f=>f.puntos[0].puntos=-1,f=>f.puntos[0].posicion=0,f=>f.equipos[0].torneo_id=2]) {
  const fixture=data();mutate(fixture);assert.throws(()=>buildPublishedNationalPoints(fixture,options));
 }
});
test('reject the same player receiving two team awards in a single event',()=>{
 const fixture=data();fixture.equipos.push({...structuredClone(team),id:11});fixture.puntos.push({...point,equipo_id:11,posicion:2,puntos:180});assert.throws(()=>buildPublishedNationalPoints(fixture,options));
});
test('zero points remain real zero and UUID case is normalized without name fallback',()=>{
 const fixture=data();fixture.puntos[0].puntos=0;fixture.equipos[0].participantes_ranking=team.participantes_ranking.map(x=>x.toUpperCase());
 const items=buildPublishedNationalPoints(fixture,{...options,userId:uid(1).toUpperCase()});assert.equal(items.length,1);assert.equal(items[0].user_id,uid(1));assert.equal(items[0].puntos,0);
});
function fakeDb(responses) {
 const calls=[];
 return {calls,from(table){const result=responses[table];const q={select(fields){calls.push({table,fields});return q;},eq(){return q;},in(){return q;},then(resolve,reject){return Promise.resolve(result).then(resolve,reject);}};return q;}};
}
test('service loader emits a safe projection, never raw service-role rows',async()=>{
 const database=fakeDb({torneos:{data:[event]},equipos:{data:[team]},tabla_puntos:{data:[point]}});
 const items=await loadPublishedNationalPoints(database,options);assert.equal(items.length,4);assert(!JSON.stringify(items).includes('reserved.invalid'));
 assert.equal(database.calls.length,3);assert(database.calls.every(c=>!c.fields.includes('email')));
});
test('storage errors fail honestly and an embargoed event prevents downstream roster reads',async()=>{
 await assert.rejects(()=>loadPublishedNationalPoints(fakeDb({torneos:{error:{code:'DB_ERROR'},data:null}}),options),e=>e.status===503);
 const database=fakeDb({torneos:{data:[event]}});assert.deepEqual(await loadPublishedNationalPoints(database,{isRevealed:()=>false}),[]);assert.equal(database.calls.length,1);
 await assert.rejects(()=>loadPublishedNationalPoints(fakeDb({torneos:{data:[event]},equipos:{data:null,error:{}},tabla_puntos:{data:[point]}}),options));
});

test('finalized and revealed QA retains private 300-point ledger but publishes no player awards', async()=>{
 const fixture=data(); fixture.torneos[0].es_prueba=true;
 const before=JSON.stringify(fixture);
 assert.deepEqual(buildPublishedNationalPoints(fixture,options),[]);
 assert.deepEqual(buildPublishedNationalPoints(fixture,{...options,userId:uid(1)}),[]);
 assert.equal(fixture.puntos[0].puntos,300);assert.equal(JSON.stringify(fixture),before);
 const database=fakeDb({torneos:{data:fixture.torneos}});
 assert.deepEqual(await loadPublishedNationalPoints(database,options),[]);
 assert.equal(database.calls.length,1);assert(database.calls[0].fields.includes('es_prueba'));
});

test('real and legacy events remain visible while higher QA scores never reorder mixed ranking',()=>{
 const fixture=data();fixture.torneos[0].es_prueba=false;
 const real=buildPublishedNationalPoints(fixture,options);
 assert.equal(real.length,4);assert.equal(real[0].puntos,300);
 const qaEvent={...event,id:2,es_prueba:true};
 const qaTeam={...structuredClone(team),id:20,torneo_id:2};
 const qaPoint={...point,torneo_id:2,equipo_id:20,puntos:10000};
 fixture.torneos.push(qaEvent);fixture.equipos.push(qaTeam);fixture.puntos.push(qaPoint);
 assert.deepEqual(buildPublishedNationalPoints(fixture,options),real);
 for(const flag of [null,undefined,false]) {
  fixture.torneos[0].es_prueba=flag;
  assert.deepEqual(buildPublishedNationalPoints(fixture,options),real);
 }
});
