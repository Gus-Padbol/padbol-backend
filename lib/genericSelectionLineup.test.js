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
