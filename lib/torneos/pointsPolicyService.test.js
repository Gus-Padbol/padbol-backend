import test from 'node:test';
import assert from 'node:assert/strict';
import {pointsPolicyFromConfig,loadPointsPolicy,buildPointsRows,validatePointsConfigInput} from './pointsPolicyService.js';
const rows=Array.from({length:15},(_,i)=>({equipo_id:i+1,posicion:i+1,tiebreak:{detalle:'ensayo'}}));
const db=result=>({from(table){assert.equal(table,'config_puntos');return {select(fields){assert.equal(fields,'clave,valor');return Promise.resolve(result);}};}});
test('legacy persisted percentages keep 300/180/120 and tail; no 30-percent migration or pool redistribution',async()=>{
 const policy=await loadPointsPolicy(db({data:[{clave:'posiciones',valor:{1:100,2:60,3:40,4:25,5:15,6:10,7:5,8:5,9:5,10:5}}]}));
 assert.equal(policy.source,'persisted');assert.equal(policy.config.posiciones[1],100);
 assert.deepEqual(buildPointsRows(policy,{torneoId:71,nivel:'internacional',rankingRows:rows}).map(r=>r.puntos),[300,180,120,75,45,30,15,15,15,15,15,15,15,15,15]);
});
test('a genuinely empty catalog uses existing defaults while storage errors never fabricate defaults',async()=>{
 assert.equal((await loadPointsPolicy(db({data:[]}))).source,'defaults');
 await assert.rejects(()=>loadPointsPolicy(db({data:null,error:{code:'42P01'}})),e=>e.status===503&&e.code==='POINTS_CONFIG_UNAVAILABLE');
 await assert.rejects(()=>loadPointsPolicy(db({data:null})),e=>e.code==='POINTS_CONFIG_UNAVAILABLE');
});
test('saved 37 percent, zero points and custom levels are preserved, not reset to default',()=>{
 const p=pointsPolicyFromConfig({niveles:{internacional:0},posiciones:{1:37,2:0,15:2},tipos_custom:[{id:'cup_qa',nombre:' QA Cup ',puntos:500}]});
 assert.equal(p.config.posiciones[1],37);assert.equal(p.config.tipos_custom[0].nombre,'QA Cup');
 assert.equal(buildPointsRows(p,{torneoId:1,nivel:'internacional',rankingRows:rows})[0].puntos,0);
 const custom=buildPointsRows(p,{torneoId:1,nivel:'cup_qa',rankingRows:rows});assert.equal(custom[0].puntos,185);assert.equal(custom[1].puntos,0);assert.equal(custom[14].puntos,10);
});
test('configuration changes cannot mutate a captured tournament snapshot',()=>{
 const supplied={niveles:{internacional:300},posiciones:{1:100}};
 const snapshot=pointsPolicyFromConfig(supplied);supplied.niveles.internacional=999;supplied.posiciones[1]=30;
 assert.equal(buildPointsRows(snapshot,{torneoId:1,nivel:'internacional',rankingRows:rows})[0].puntos,300);
 assert.notEqual(snapshot.digest,pointsPolicyFromConfig(supplied).digest);
});
test('digest ignores object key order and labels/hidden values survive validation',()=>{
 const a={niveles:{nacional:100,internacional:300},posiciones:{2:60,1:100},niveles_labels:{nacional:' Nacional '},niveles_hidden:['mundial']};
 const b={niveles_hidden:['mundial'],niveles_labels:{nacional:'Nacional'},posiciones:{1:100,2:60},niveles:{internacional:300,nacional:100}};
 assert.equal(pointsPolicyFromConfig(a).digest,pointsPolicyFromConfig(b).digest);
 assert.deepEqual(validatePointsConfigInput(a).niveles_hidden,['mundial']);assert.equal(validatePointsConfigInput(a).niveles_labels.nacional,'Nacional');
});
test('reject invalid numeric input, malicious keys and duplicate custom IDs',()=>{
 for(const input of [{niveles:{nacional:-1}},{niveles:{nacional:'100'}},{niveles:{nacional:Infinity}},{posiciones:{1:101}},{posiciones:{0:50}},{posiciones:{1:null}},{posiciones:[]},{niveles_hidden:['mundial','mundial']},{niveles_labels:{nacional:''}},JSON.parse('{"niveles":{"__proto__":100}}'),{tipos_custom:[{id:'nacional',nombre:'x',puntos:5}]},{tipos_custom:[{id:'x',nombre:'x',puntos:5},{id:'x',nombre:'y',puntos:7}]},{unrecognized:true}]) assert.throws(()=>validatePointsConfigInput(input),e=>e.code==='POINTS_CONFIG_INVALID');
});
test('duplicate stored keys and unknown levels fail explicitly',async()=>{
 await assert.rejects(()=>loadPointsPolicy(db({data:[{clave:'niveles',valor:{nacional:100}},{clave:'niveles',valor:{nacional:200}}]})),e=>e.code==='POINTS_CONFIG_INVALID');
 assert.throws(()=>buildPointsRows(pointsPolicyFromConfig(),{torneoId:1,nivel:'made_up',rankingRows:rows}),e=>e.code==='POINTS_LEVEL_UNCONFIGURED');
});
test('rank rows retain sporting provenance but reject duplicate or invalid teams/positions',()=>{
 const p=pointsPolicyFromConfig();const result=buildPointsRows(p,{torneoId:9,nivel:'nacional',rankingRows:rows});assert.deepEqual(result[0].tiebreak,{detalle:'ensayo'});assert.equal(result[0].torneo_id,9);
 for(const input of [[rows[0],rows[0]],[{equipo_id:0,posicion:1}],[{equipo_id:1,posicion:0}],[{equipo_id:1,posicion:1.5}]]) assert.throws(()=>buildPointsRows(p,{torneoId:9,nivel:'nacional',rankingRows:input}));
});
test('numeric string positions normalize before lookup so leading zeros cannot select tail points',()=>{
 const p=pointsPolicyFromConfig();
 for(const position of [1,'1','01',' 1 ']) {
  const [row]=buildPointsRows(p,{torneoId:'9',nivel:'internacional',rankingRows:[{equipo_id:'7',posicion:position}]});
  assert.equal(row.puntos,300);assert.equal(row.posicion,1);assert.equal(row.equipo_id,7);assert.equal(row.torneo_id,9);
 }
 assert.throws(()=>buildPointsRows(p,{torneoId:0,nivel:'nacional',rankingRows:rows}));
 assert.throws(()=>buildPointsRows(p,{torneoId:9,nivel:'nacional',rankingRows:[null]}));
});
test('reject values outside real PostgreSQL int4 points range before saving or closing',()=>{
 assert.throws(()=>validatePointsConfigInput({niveles:{internacional:3000000000}}));
 assert.throws(()=>validatePointsConfigInput({tipos_custom:[{id:'qa',nombre:'QA',puntos:2147483648}]}));
 const p=pointsPolicyFromConfig({niveles:{internacional:2147483647}});
 assert.equal(buildPointsRows(p,{torneoId:9,nivel:'internacional',rankingRows:[rows[0]]})[0].puntos,2147483647);
});
