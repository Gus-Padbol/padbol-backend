import test from 'node:test';import assert from 'node:assert/strict';
import {buildTournamentFixturePlan,persistTournamentPlan} from './tournamentPlanningService.js';
const torneo={id:90,sede_id:8,estado:'abierto',tipo_torneo:'knockout'};
const equipos=Array.from({length:4},(_,i)=>({id:i+1,inscripcion_estado:'confirmada'}));
test('manual draw preserves exact first round and progression without a start mutation',()=>{
 const plan=buildTournamentFixturePlan(torneo,equipos,{origin:'manual',pairings:[{equipo_a_id:1,equipo_b_id:4},{equipo_a_id:2,equipo_b_id:3}]});
 assert.equal(plan.length,3);assert.deepEqual(plan.map(p=>[p.equipo_a_id,p.equipo_b_id]),[[1,4],[2,3],[null,null]]);assert.deepEqual(plan.map(p=>p.ronda),[1,1,2]);assert.ok(plan.every(p=>p.estado==='pendiente'));assert.equal(torneo.estado,'abierto');
});
test('manual rejects omitted duplicated foreign self and unsupported byes',()=>{
 for(const pairings of [[],[{equipo_a_id:1,equipo_b_id:1},{equipo_a_id:2,equipo_b_id:3}],[{equipo_a_id:1,equipo_b_id:4},{equipo_a_id:2,equipo_b_id:99}],[{equipo_a_id:1,equipo_b_id:null},{equipo_a_id:2,equipo_b_id:3}]])assert.throws(()=>buildTournamentFixturePlan(torneo,equipos,{origin:'manual',pairings}));
 assert.throws(()=>buildTournamentFixturePlan(torneo,equipos.slice(0,3)));
});
test('no Nations, running event, unconfirmed roster or unknown origin accepted',()=>{
 for(const change of [{plan_nations:{}},{estado:'en_curso'}])assert.throws(()=>buildTournamentFixturePlan({...torneo,...change},equipos));
 assert.throws(()=>buildTournamentFixturePlan(torneo,[...equipos,{id:5,inscripcion_estado:'pendiente'}]));assert.throws(()=>buildTournamentFixturePlan(torneo,equipos,{origin:'unknown'}));
});
test('round robin contains each unique pair, never an incomplete manual schedule',()=>{
 const plan=buildTournamentFixturePlan({...torneo,tipo_torneo:'round_robin'},equipos);assert.equal(plan.length,6);assert.equal(new Set(plan.map(p=>[p.equipo_a_id,p.equipo_b_id].join(':'))).size,6);
 assert.throws(()=>buildTournamentFixturePlan({...torneo,tipo_torneo:'round_robin'},equipos,{origin:'manual'}));
});
test('atomic persistence sends exact actor and roster; errors cannot claim a saved plan',async()=>{
 let sent;const db={rpc:async(name,body)=>{sent={name,body};return {error:{code:'40001'}};}};
 await assert.rejects(persistTournamentPlan(db,{torneo,equipos,actorId:'qa'}),e=>e.status===409);assert.equal(sent.name,'planificar_fixture_torneo');assert.equal(sent.body.p_actor_id,'qa');assert.deepEqual(sent.body.p_equipo_ids,[1,2,3,4]);
});

test('new confirmado and historical confirmada registrations both remain fixture eligible',()=>{assert.equal(buildTournamentFixturePlan(torneo,equipos.map((e,i)=>({...e,inscripcion_estado:i%2?'confirmado':'confirmada'}))).length,3);});
