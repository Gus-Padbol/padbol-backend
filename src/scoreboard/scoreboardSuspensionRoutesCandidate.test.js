import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installScoreboardSuspensionRoutesCandidate } from './scoreboardSuspensionRoutesCandidate.js';
function harness(options = {}) {
  const handlers = new Map(), calls = [];
  installScoreboardSuspensionRoutesCandidate({ post: (path, handler) => handlers.set(path, handler) }, {
    getAuthenticatedUser: async () => options.unauthorized ? { status: 401 } : { user: { id: 'actor' } },
    fetchPartido: async () => ({ id: 'marker', sede_id: 8 }), resolveRole: async () => ({}),
    assertCanControl: () => { if (options.forbidden) throw Object.assign(new Error('private'), { status: 403 }); },
    db: { rpc: async (name, args) => { calls.push({ name, args }); return options.result ?? { data: { id: 'marker', estado: 'en_curso', control_token_hash: 'private' } }; } },
    publishUpdate: async () => { if (options.socketError) throw Error('offline'); },
  });
  return { calls, async run(action, body) {
    let status = 200, data; const res = { status(n) { status = n; return this; }, json(v) { data = v; return this; } };
    await handlers.get(`/api/scoreboard/partidos/:id/${action}`)({ params: { id: 'marker' }, body }, res);
    return { status, data };
  } };
}
const valid = { updated_at: '2026-10-21T12:00:00Z', court_id: 14, duration_minutes: 90 };
test('validates authorization and input before making any mutation', async () => {
 for (const options of [{ unauthorized: true }, { forbidden: true }]) { const h=harness(options); assert.notEqual((await h.run('resume',valid)).status,200); assert.equal(h.calls.length,0); }
 const h=harness(); assert.equal((await h.run('resume',{ ...valid, court_id: 0 })).status,400); assert.equal(h.calls.length,0);
});
test('forwards version and court to the transaction and never returns secrets', async () => {
 const h=harness(); const result=await h.run('resume',valid); assert.equal(result.status,200); assert.equal(result.data.control_token_hash,undefined);
 assert.deepEqual(h.calls[0], { name: 'scoreboard_resume_candidate', args: { p_id:'marker', p_expected:valid.updated_at, p_actor:'actor', p_court_id:14, p_duration_minutes:90 } });
});
test('reports concurrency and completed transaction despite socket failure', async () => {
 const stale=harness({ result:{ data:null } }); assert.equal((await stale.run('suspend',valid)).status,409);
 const busy=harness({ result:{ error:{code:'23505'} } }); assert.equal((await busy.run('resume',valid)).status,409);
 const socket=harness({ socketError:true }); assert.equal((await socket.run('resume',valid)).status,200);
});
