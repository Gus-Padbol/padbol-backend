import test from 'node:test';import assert from 'node:assert/strict';
import {mountTournamentPlanningRoutes,startPlannedTournament} from './tournamentPlanning.js';
const team=id=>({id,jugadores:[{nombre:'Uno',participante_id:`${id}a`},{nombre:'Dos',participante_id:`${id}b`}],inscripcion_estado:'confirmada'});
const torneo={id:901,sede_id:8,tipo_torneo:'knockout',estado:'abierto'};
function response(){return{statusCode:200,status(s){this.statusCode=s;return this;},json(body){this.body=body;return this;}};}
function setup({authorized=true,event=torneo,teams=[1,2,3,4].map(team),match={id:5,torneo_id:901,equipo_a_id:1,equipo_b_id:2,estado:'pendiente'},rpc}={}){
 const calls=[];const routes={};const db={from(table){const q={select(){return q;},eq(){return q;},order(){return q;},single(){return q;},maybeSingle(){return q;},then(resolve){return Promise.resolve({data:table==='torneos'?event:table==='equipos'?teams:table==='partidos'?match:table==='sedes'?{timezone:'Europe/Rome'}:table==='canchas'?[]:null,error:null}).then(resolve);}};return q;},rpc:async(name,body)=>{calls.push({name,body});return rpc?rpc(name,body):{data:{ok:true,torneo_id:901,estado:'en_curso'}};}};
 const app={get:(p,f)=>routes['GET '+p]=f,post:(p,f)=>routes['POST '+p]=f,put:(p,f)=>routes['PUT '+p]=f};mountTournamentPlanningRoutes(app,{db,requireTorneoAdmin:async(_req,res)=>{if(!authorized){res.status(403).json({error:'Denied'});return null;}return{user:{id:'actor-qa'}};}});return{routes,calls,db};
}
test('scope denial stops before any planning write',async()=>{const {routes,calls}=setup({authorized:false});const res=response();await routes['POST /api/torneos/:id/planificar-fixture']({params:{id:901},body:{}},res);assert.equal(res.statusCode,403);assert.equal(calls.length,0);});
test('explicit start rejects unresolved sporting places and keeps accountless named players eligible',async()=>{
 const {db,calls}=setup();await assert.rejects(startPlannedTournament(db,{torneo,equipos:[{...team(1),jugadores:[{tipo_identidad:'plaza_pendiente'}]}],actorId:'actor'}),e=>e.code==='PARTICIPANTS_NOT_READY');assert.equal(calls.length,0);
 const receipt=await startPlannedTournament(db,{torneo,equipos:[team(1),team(2)],actorId:'actor'});assert.equal(receipt.estado,'en_curso');assert.equal(calls[0].body.p_actor_id,'actor');assert.equal(calls[0].body.p_roster.length,2);
});
test('legacy group generator passes through; Nations never gets normal fixture writes',async()=>{const {routes,calls}=setup({event:{...torneo,tipo_torneo:'grupos_knockout'}});let passed=false;await routes['POST /api/torneos/:id/generar-partidos']({params:{id:901}},response(),()=>{passed=true;});assert.equal(passed,true);assert.equal(calls.length,0);
 const nations=setup({event:{...torneo,plan_nations:{enabled:true}}});const res=response();await nations.routes['POST /api/torneos/:id/planificar-fixture']({params:{id:901},body:{}},res);assert.equal(res.statusCode,409);assert.equal(nations.calls.length,0);
});
test('marker is blocked until explicit start and teams are resolved',async()=>{const s=setup();const res=response();await s.routes['POST /api/torneos/:id/partidos/:partidoId/marcador']({params:{id:901,partidoId:5}},res);assert.equal(res.statusCode,409);assert.equal(s.calls.length,0);});
test('invalid schedule never reaches SQL and cannot claim saved state',async()=>{const s=setup();const res=response();await s.routes['PUT /api/torneos/:id/partidos/:partidoId/programacion']({params:{id:901,partidoId:5},body:{court_id:1,fecha_hora:'2026-11-20T11:00',duration_minutes:60}},res);assert.equal(res.statusCode,400);assert.equal(s.calls.length,0);});
