import test from 'node:test';import assert from 'node:assert/strict';
import {validateNationalLineup,lineupRosterPlayers,lineupPlayerId,playerId,rankingPlayerKey} from './nationalTeamLineup.js';
const players=Array.from({length:8},(_,i)=>({participante_id:`33333333-3333-4333-8333-${String(i).padStart(12,'0')}`,user_id:null,nombre:`Invitado${i}`,estado:'confirmado',tipo_identidad:'generico'}));
test('eight guests use exactly four sporting references without inventing auth identities or ranking IDs',()=>{
 const team={jugadores:players};const ids=players.map(lineupPlayerId),body={iniciales:ids.slice(0,2),suplentes:ids.slice(2,4)};
 assert.deepEqual(validateNationalLineup(body,team,{allowGeneric:true}),body);assert.throws(()=>validateNationalLineup(body,team));
 assert.equal(lineupRosterPlayers(team).length,8);assert.ok(lineupRosterPlayers(team).every(p=>p.user_id===null));assert.ok(players.every(p=>playerId(p)===''));assert.equal(rankingPlayerKey(team,players[0]),'Invitado0');
 assert.throws(()=>validateNationalLineup({...body,suplentes:[ids[0],ids[3]]},team,{allowGeneric:true}));
});

test('four named guests and four unfilled slots may declare only the four actual participants',()=>{const team={jugadores:players.map((p,i)=>i<4?p:{...p,tipo_identidad:'plaza_pendiente',nombre:'',estado:'pendiente'})};const ids=players.map(lineupPlayerId);assert.deepEqual(validateNationalLineup({iniciales:ids.slice(0,2),suplentes:ids.slice(2,4)},team,{allowGeneric:true}),{iniciales:ids.slice(0,2),suplentes:ids.slice(2,4)});assert.throws(()=>validateNationalLineup({iniciales:ids.slice(0,2),suplentes:ids.slice(6,8)},team,{allowGeneric:true}));});

test('closure accepts only protected registry eligibility for a linked guest without mutating frozen roster',async()=>{
 const {closeNationalTournament}=await import('./nationalTeamLineup.js');
 const uid='11111111-1111-4111-8111-111111111111';const original={id:1,jugadores:players};
 let eligible=true;const db={rpc:async()=>({data:{ok:true,status:'finalized',torneo_id:9,torneo:{id:9},equipos:[{...original,participantes_ranking:[uid]}]}}),from(table){assert.equal(table,'torneo_participantes');return{select(){return this;},eq(k,v){assert.equal(k,'torneo_id');assert.equal(v,9);return this;},in(k,ids){assert.equal(k,'id');assert.deepEqual(ids,players.map(p=>p.participante_id));return Promise.resolve({data:[{id:ids[0],linked_user_id:uid,ranking_oficial_elegible:eligible}]});}};}};
 await closeNationalTournament(db,{torneo:{id:9},equipos:[original],puntosData:[],actorId:uid});
 assert.ok(original.jugadores.every(p=>p.user_id===null));eligible=false;
 await assert.rejects(()=>closeNationalTournament(db,{torneo:{id:9},equipos:[original],puntosData:[],actorId:uid}),{status:503});
});
