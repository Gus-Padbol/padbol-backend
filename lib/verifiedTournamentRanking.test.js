import test from 'node:test';
import assert from 'node:assert/strict';
import { projectVerifiedTournamentRankingTeams } from './verifiedTournamentRanking.js';
const uid='11111111-1111-4111-8111-111111111111';
const team={id:7,torneo_id:51,modalidad_plantel:'selecciones',participantes_ranking:[uid],jugadores:[{participante_id:'guest',nombre:'QA Guest'}]};
const record={torneo_id:51,equipo_id:7,participantes:[{participante_id:'guest',user_id:uid}]};
const db=(records=[record],error=null)=>({from:table=>{assert.equal(table,'torneo_participante_ranking_cierres');return {select:()=>({in:async()=>({data:records,error})})};}});
test('verified closed accreditation is projected without modifying the frozen roster',async()=>{
 const input=structuredClone(team);const [result]=await projectVerifiedTournamentRankingTeams(db(),[input]); assert.equal(result.jugadores[0].user_id,uid);assert.equal(input.jugadores[0].user_id,undefined);assert.equal(input.jugadores[0].participante_id,'guest');
});
test('missing, empty, wrong-event and wrong-team close snapshots never grant ranking',async()=>{
 for(const rows of [[],[{...record,participantes:[]}],[{...record,torneo_id:52}],[{...record,equipo_id:8}]]){
  const [result]=await projectVerifiedTournamentRankingTeams(db(rows),[team]);assert.deepEqual(result.jugadores,[]);
 }
});
test('selection ranking requires the actually declared account as well as closure accreditation',async()=>{
 const [result]=await projectVerifiedTournamentRankingTeams(db(),[{...team,participantes_ranking:[]}]);assert.deepEqual(result.jugadores,[]);
});
test('legacy rosters do not require or acquire registry identities',async()=>{
 const legacy={...team,jugadores:[{user_id:uid,nombre:'QA Existing'}]};assert.equal((await projectVerifiedTournamentRankingTeams({},[legacy]))[0],legacy);
});
test('unverified snapshot reads fail visibly instead of falling back to generic identities',async()=>{
 await assert.rejects(projectVerifiedTournamentRankingTeams(db(null,{code:'offline'}),[team]),/No se pudo verificar/);
});
test('generic doubles linked and approved after closure remain outside the empty snapshot',async()=>{
 const [result]=await projectVerifiedTournamentRankingTeams(db([{...record,participantes:[]}]),[{...team,modalidad_plantel:'dobles',participantes_ranking:null,jugadores:[{participante_id:'guest',user_id:uid,ranking_oficial_elegible:true}]}]);assert.deepEqual(result.jugadores,[]);assert.equal(result.registry_ranking_verified,true);
});
test('doubles accredited at closure can qualify without modifying their old generic display snapshot',async()=>{
 const [result]=await projectVerifiedTournamentRankingTeams(db(),[{...team,modalidad_plantel:'dobles',participantes_ranking:null}]);assert.equal(result.jugadores[0].user_id,uid);
});
