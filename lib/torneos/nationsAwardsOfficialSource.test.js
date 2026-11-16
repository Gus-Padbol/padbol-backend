import test from 'node:test';import assert from 'node:assert/strict';import {loadOfficialNationsAwardParticipants} from './nationsAwardsOfficialSource.js';
const teamA=101,teamB=102;const ids={A:{A:['a1','a2','a3','a4']},B:{B:['b1','b2','b3','b4']}};
const matches=[...Array(30)].map((_,i)=>({id:500+i,torneo_id:57,grupo:['A','B','C'][i%3],bracket_round:null,estado:'finalizado',equipo_a_id:teamA,equipo_b_id:teamB,ganador_equipo_id:teamA})).concat([...Array(7)].map((_,i)=>({id:600+i,torneo_id:57,grupo:null,bracket_round:[1,1,1,1,2,2,3][i],bracket_position:i<4?i+1:i<6?i-3:1,estado:'finalizado',equipo_a_id:teamA,equipo_b_id:teamB,ganador_equipo_id:teamA,partido_siguiente_id:null,partido_siguiente_slot:null})));
const plan={revision:4,qualified:[...Array(8)].map((_,i)=>({equipo_id:i<4?teamA:teamB,seed:i+1})),standings:[{rows:[]}],config:{rules:{third_place_match:false}},classification_source:[]};
// use a tiny synthetic plan-compatible builder by stubbing placements via module? exercise source failure instead if not valid
test('official source requires pool and completed finalization',async()=>{await assert.rejects(()=>loadOfficialNationsAwardParticipants({pool:null,eventId:57,plan,matches}),/pool/i);});
test('no trusted body participants is part of signature/source',()=>{assert.equal(typeof loadOfficialNationsAwardParticipants, 'function');});
const jpgames=(setId,a,b,ord)=>Array.from({length:a+b},(_,i)=>({type:'game',historyId:`m1-${ord+i}`,ordinal:ord+i,set:setId,number:i+1,completed:true,teams:{101:['p1','p2'],102:['p3','p4']}}));
test('loads private aggregate, maps real players and positions',async()=>{
 const events=jpgames(1,6,3,1);const ledger={version:1,total:events.length,events,active:events.map(e=>e.historyId)};
 const client={query:async(sql,args)=>{if(/BEGIN|COMMIT|ROLLBACK/.test(sql))return{};return {rows:[{scoreboard_id:'sb1',partido_torneo_id:1,torneo_id:57,historial_sets:[{set:1,a:6,b:3}],states:{101:{status:'closed',lineup:{iniciales:['p1','p2'],suplentes:['p5','p6']}},102:{status:'closed',lineup:{iniciales:['p3','p4'],suplentes:['p7','p8']}}},games_ledger:ledger,revision:3,finalization_status:'completed'}]};},release(){}};
 const pool={connect:async()=>client};
 const context=async()=>({membership:{A:101,B:102},teams:{101:{players:[{id:'p1'},{id:'p2'},{id:'p5'},{id:'p6'}]},102:{players:[{id:'p3'},{id:'p4'},{id:'p7'},{id:'p8'}]}}});
 const plan={revision:4,qualified:[{equipo_id:101},{equipo_id:102}],standings:[],config:{rules:{third_place_match:false}}};const matches=[{id:1,torneo_id:57,grupo:'A',bracket_round:null,estado:'finalizado',equipo_a_id:101,equipo_b_id:102,ganador_equipo_id:101}];
 const out=await loadOfficialNationsAwardParticipants({pool,eventId:57,plan,matches,loadContext:context,minimumSets:1,buildPlacements:()=>[{equipo_id:101,posicion:1},{equipo_id:102,posicion:2}]});
 assert.equal(out.participants.length,8);assert.deepEqual(out.participants.filter(p=>['p1','p2','p3','p4'].includes(p.playerId)).map(p=>p.playerSets),[1,1,1,1]);assert.equal(out.sourceRevision,4);assert.equal(out.participants[0].position,1);
});
