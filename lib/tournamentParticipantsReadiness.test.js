import test from 'node:test';import assert from 'node:assert/strict';
import {participantSportingReadiness as ready,assertTournamentTeamsSportReady as assertReady} from './tournamentParticipantsReadiness.js';
test('named guests can play doubles without account IDs; pending slots cannot',async()=>{
 const guest=i=>({participante_id:'guest'+i,nombre:'Jugador '+i,tipo_identidad:'generico',estado:'confirmado',ranking_oficial_elegible:false});
 assert.equal(ready({},[guest(1),guest(2)]).habilitado,true);
 const team={id:1,jugadores:[guest(1),{tipo_identidad:'plaza_pendiente',nombre:'Pendiente',estado:'pendiente'}]};
 await assert.rejects(assertReady(null,{torneo:{},equipos:[team]}),e=>e.status===409&&e.details[0].faltantes===1);
 assert.equal(ready({},[guest(1),guest(1)]).habilitado,false);
});
test('selection rosters distinguish four minimum, eight maximum and individual one',()=>{
 const rows=Array.from({length:9},(_,i)=>({participante_id:String(i),nombre:'Invitado '+i}));
 assert.equal(ready({modalidad_plantel:'selecciones'},rows.slice(0,4)).habilitado,true);
 assert.equal(ready({modalidad_plantel:'selecciones'},rows.slice(0,8)).habilitado,true);
 assert.equal(ready({modalidad_plantel:'selecciones'},rows).habilitado,false);
 assert.equal(ready({modalidad_plantel:'individual'},rows.slice(0,1)).habilitado,true);
 assert.equal(ready({modalidad_plantel:'dobles',formato_equipo:'singles'},rows.slice(0,1)).habilitado,true);
});
