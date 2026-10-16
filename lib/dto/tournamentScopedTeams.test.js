import test from 'node:test';import assert from 'node:assert/strict';
import {mayReadTournamentEnrollment,mapTournamentTeamReadRow}from './tournamentScopedTeams.js';
const row={id:1,torneo_id:48,sede_id:8,nombre:'QA team',jugadores:[{nombre:'Guest',participante_id:'pid'}],inscripcion_estado:'confirmado',solicitudes:[{email:'private@example.invalid'}],creador_id:'private',codigo_pago:'private'};
test('four registry confirmed teams retain the exact planner contract only for scoped administration',()=>{
 for(const role of [{rol:'admin_club',sede_id:8},{rol:'super_admin'}]){
  const admin=mayReadTournamentEnrollment({user:{id:'operator'},role},{sede_id:8});assert.equal(admin,true);
  const teams=[1,2,3,4].map(id=>mapTournamentTeamReadRow({...row,id},{admin}));
  assert.equal(teams.filter(e=>['confirmado','confirmada'].includes(e.inscripcion_estado)).length,4);
  for(const team of teams)assert.ok(!['solicitudes','creador_id','codigo_pago'].some(k=>k in team));
 }
});
test('anonymous/player/nationaladmin/venueadmin/wrong club never receive inscription metadata',()=>{
 for(const auth of [null,{role:{rol:'super_admin'}},...['jugador','admin_nacional','admin_sede'].map(rol=>({user:{id:'user'},role:{rol,sede_id:8}})),{user:{id:'other'},role:{rol:'admin_club',sede_id:9}}]){
  const admin=mayReadTournamentEnrollment(auth,{sede_id:8});assert.equal(admin,false);assert.equal('inscripcion_estado'in mapTournamentTeamReadRow(row,{admin}),false);
 }
});
test('unconfirmed teams remain unconfirmed and no public mapper changes',()=>{
 assert.equal(mapTournamentTeamReadRow({...row,inscripcion_estado:'pendiente'},{admin:true}).inscripcion_estado,'pendiente');
 assert.equal('inscripcion_estado'in mapTournamentTeamReadRow(row),false);
});

test('admin registry DTO retains sporting identity and mode while never inventing an account or exposing contact data',()=>{
 for(const modalidad_plantel of ['selecciones','dobles']){
  const dto=mapTournamentTeamReadRow({...row,modalidad_plantel,jugadores:Array.from({length:8},(_,i)=>({participante_id:`pid${i}`,tipo_identidad:'generico',nombre:`Guest${i}`,estado:'confirmado',email:'private@example.invalid'}))},{admin:true});
  assert.equal(dto.modalidad_plantel,modalidad_plantel);assert.equal(dto.jugadores.length,8);
  assert.ok(dto.jugadores.every((p,i)=>p.participante_id===`pid${i}`&&p.tipo_identidad==='generico'&&p.user_id===null&&p.id===null&&!('email'in p)));
 }
});

test('public selection identity kind is semantic only, enum bounded, with no new PID/account/contact fields',()=>{
 for(const tipo_identidad of ['generico','plaza_pendiente','cuenta']){
  const dto=mapTournamentTeamReadRow({...row,modalidad_plantel:'selecciones',jugadores:[{nombre:'QA',tipo_identidad,participante_id:'private-pid',email:'private@example.invalid'}]});
  assert.equal(dto.jugadores[0].tipo_identidad,tipo_identidad);assert.ok(!dto.jugadores[0].user_id);assert.ok(!('participante_id'in dto.jugadores[0]));assert.ok(!('email'in dto.jugadores[0]));
 }
 assert.equal('tipo_identidad'in mapTournamentTeamReadRow({...row,modalidad_plantel:'selecciones',jugadores:[{nombre:'QA',tipo_identidad:'invalid'}]}).jugadores[0],false);
});
