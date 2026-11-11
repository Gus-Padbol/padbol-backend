import test from 'node:test'; import assert from 'node:assert/strict';
import {createMarkerState, appendMarkerEvent, computeParticipation} from './nationsParticipationMarker.js';
import {applyMatchGlobalCommand} from './nationsParticipationMatchGlobal.js';
const id=(n)=>`${String(n).repeat(8)}-1111-4111-8111-${String(n).repeat(12)}`;
const L1={iniciales:[id(1),id(2)],suplentes:[id(3),id(4)]}; const L2={iniciales:[id(5),id(6)],suplentes:[id(7),id(8)]};
const states=()=>({t1:createMarkerState({lineup:L1,startedAt:1000}),t2:createMarkerState({lineup:L2,startedAt:1000})});
const actor='server';
test('pausa global aplica mismo serverAt a ambos y excluye intervalo en ambos',()=>{
 let s=states(); s=applyMatchGlobalCommand({states:s,command:'pause',now:3000,actorId:actor,idempotencyKey:'g1'}).states;
 s=applyMatchGlobalCommand({states:s,command:'resume',now:5000,actorId:actor,idempotencyKey:'g2'}).states;
 s=applyMatchGlobalCommand({states:s,command:'close',now:7000,actorId:actor,idempotencyKey:'g3'}).states;
 assert.equal(s.t1.events[0].serverAt,3000); assert.equal(s.t2.events[0].serverAt,3000);
 assert.equal(s.t1.events[1].serverAt,5000); assert.equal(s.t2.events[1].serverAt,5000);
 const c1=computeParticipation(s.t1), c2=computeParticipation(s.t2);
 assert.equal(c1.players.find(p=>p.id===id(1)).activeMs,4000); assert.equal(c2.players.find(p=>p.id===id(5)).activeMs,4000);
});
test('fallo en un equipo no aplica al otro (objeto nuevo, originales intactos)',()=>{
 let s=states(); s.t2={...s.t2,status:'closed'};
 assert.throws(()=>applyMatchGlobalCommand({states:s,command:'pause',now:2000,actorId:actor,idempotencyKey:'g'}),{code:'PAUSE_INVALID'});
 assert.equal(s.t1.status,'open'); assert.equal(s.t1.events.length,0);
});
test('retry mismo key global no duplica eventos',()=>{
 let s=states(); s=applyMatchGlobalCommand({states:s,command:'pause',now:2000,actorId:actor,idempotencyKey:'g'}).states;
 const again=applyMatchGlobalCommand({states:s,command:'pause',now:2000,actorId:actor,idempotencyKey:'g'});
 assert.equal(again.states.t1.events.length,1); assert.equal(again.states.t2.events.length,1);
});
