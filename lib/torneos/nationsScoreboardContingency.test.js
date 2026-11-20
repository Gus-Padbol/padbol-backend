import assert from 'node:assert/strict';
import test from 'node:test';
import {canManageNationsContingencyScoreboard,isIndependentContingencyScoreboard,isOwnedContingencyScoreboard,GIACOMO_CONTINGENCY_USER_ID,NATIONS_CONTINGENCY_SEDE_ID} from './nationsScoreboardContingency.js';

function poolFor(rowCount) {
  return { query: async () => ({rowCount, rows: rowCount ? [{id:'grant'}] : []}) };
}
test('only Giacomo with active grant on tournament sede gets scoped contingency', async () => {
  assert.equal(await canManageNationsContingencyScoreboard({pool:poolFor(1), userId:GIACOMO_CONTINGENCY_USER_ID, sedeId:NATIONS_CONTINGENCY_SEDE_ID}), true);
  assert.equal(await canManageNationsContingencyScoreboard({pool:poolFor(1), userId:'someone-else', sedeId:9}), false);
  assert.equal(await canManageNationsContingencyScoreboard({pool:poolFor(1), userId:GIACOMO_CONTINGENCY_USER_ID, sedeId:8}), false);
  assert.equal(await canManageNationsContingencyScoreboard({pool:poolFor(0), userId:GIACOMO_CONTINGENCY_USER_ID, sedeId:9}), false);
});
test('contingency only covers independent scoreboards, never official tournament boards',()=>{
 assert.equal(isIndependentContingencyScoreboard({id:'independent',partido_torneo_id:null,torneo_id:null}),true);
 assert.equal(isIndependentContingencyScoreboard({id:'official',partido_torneo_id:77,torneo_id:57}),false);
 assert.equal(isIndependentContingencyScoreboard({id:'tournament',partido_torneo_id:null,torneo_id:57}),false);
});
test('only the owner may operate its contingency marker',()=>{
 assert.equal(isOwnedContingencyScoreboard({partido_torneo_id:null,torneo_id:null,created_by_user_id:GIACOMO_CONTINGENCY_USER_ID},GIACOMO_CONTINGENCY_USER_ID),true);
 assert.equal(isOwnedContingencyScoreboard({partido_torneo_id:null,torneo_id:null,created_by_user_id:'other'},GIACOMO_CONTINGENCY_USER_ID),false);
});
