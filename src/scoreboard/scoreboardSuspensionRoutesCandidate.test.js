import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installScoreboardSuspensionRoutesCandidate } from './scoreboardSuspensionRoutesCandidate.js';
function harness(options = {}) {
  const handlers = new Map(), calls = [];
  installScoreboardSuspensionRoutesCandidate({ post: (path, handler) => handlers.set(path, handler) }, {
    getAuthenticatedUser: async () => options.unauthorized ? { status: 401 } : { user: { id: 'actor' } },
    fetchPartido: async () => ({ id: 'marker', sede_id: 8, score_a: 30 }), resolveRole: async () => ({}),
    assertCanControl: () => { if (options.forbidden) throw Object.assign(new Error('private'), { status: 403 }); },
    db: { rpc: async (name, args) => { calls.push({ name, args }); return options.result ?? { data: { status:'applied', result:{ id:'marker',estado:'en_curso',control_token_hash:'private' } } }; } },
    publishUpdate: async () => { if (options.socketError) throw Error('offline'); },
  });
  return { calls, async run(action, body) {
    let status = 200, data; const res = { status(n) { status = n; return this; }, json(v) { data = v; return this; } };
    await handlers.get(`/api/scoreboard/partidos/:id/${action}`)({ params: { id: 'marker' }, body }, res);
    return { status, data };
  } };
}
const valid = { action_id:'33333333-3333-4333-8333-333333333333',updated_at:'2026-10-21T12:00:00Z',court_id:14,duration_minutes:90 };
test('validates authorization and input before making any mutation', async () => {
 for (const options of [{ unauthorized:true }, { forbidden:true }]) { const h=harness(options); assert.notEqual((await h.run('resume',valid)).status,200); assert.equal(h.calls.length,0); }
 const h=harness(); assert.equal((await h.run('resume',{...valid,court_id:0})).status,400); assert.equal(h.calls.length,0);
});
test('forwards operation reference and version and never returns secrets', async () => {
 const h=harness(); const result=await h.run('resume',valid); assert.equal(result.status,200); assert.equal(result.data.control_token_hash,undefined);
 assert.deepEqual(h.calls[0],{ name:'scoreboard_transition_receipt_isolated_candidate', args:{p_action_id:valid.action_id,p_action:'resume',p_id:'marker',p_actor:'actor',p_expected:valid.updated_at,p_court_id:14,p_duration:90,p_reason:null} });
 assert.equal(result.data.transition_receipt.status,'applied');
});
test('recovers uncertain result and does not show stale saved score', async () => {
 const h=harness({result:{data:{status:'applied',result:{id:'marker',score_a:0}}}}); const r=await h.run('reconcile',{action_id:valid.action_id,action:'resume'});
 assert.equal(r.status,200); assert.equal(r.data.score_a,30); assert.equal(h.calls[0].name,'scoreboard_reconcile_isolated_candidate');
});
test('reports conflict and completed transaction despite socket failure', async () => {
 const stale=harness({result:{data:{status:'conflict'}}}); assert.equal((await stale.run('suspend',{...valid,reason:'Lluvia'})).status,409);
 const busy=harness({result:{error:{code:'23505'}}}); assert.equal((await busy.run('resume',valid)).status,409);
 const socket=harness({socketError:true}); assert.equal((await socket.run('resume',valid)).status,200);
});
