import {test} from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {createContentAnalyticsRouter} from './contentAnalytics.js';
import {createContentWorkspaceRouter} from './contentWorkspace.js';
async function appFor(auth, deps, fn) {
  const app = express(); app.use('/analytics', (req, res, next) => {req.workspaceAuth = auth; next();}, createContentAnalyticsRouter(deps));
  const server = app.listen(0);
  try { await fn(`http://127.0.0.1:${server.address().port}/analytics`); } finally {server.close();}
}
test('HTTP excludes designer and forged query flags before database or Google access', async () => {
  let calls = 0;
  await appFor({user: {id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'}, canDecidePromotion: false}, {pgPool: {connect() {calls++; throw Error('must not reach');}}}, async base => {
    for (const route of ['/status?canDecidePromotion=true', '/summary?actor=owner']) assert.equal((await fetch(base + route)).status, 403);
  });
  assert.equal(calls, 0);
});
test('HTTP revalidates persisted coordinator permission and exposes honest unconfigured state with no-store', async () => {
  const auth = {user: {id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'}, canDecidePromotion: true};
  let allowed = true;
  await appFor(auth, {env: {}, pgPool: {async connect() {return {async query() {return {rows: [{allowed}]};}, release() {}};}}, analyticsFetchImpl() {throw Error('must not reach Google');}}, async base => {
    const status = await fetch(base + '/status'); assert.equal(status.status, 200); assert.equal(status.headers.get('cache-control'), 'private, no-store');
    assert.equal((await status.json()).connection.status, 'not_configured');
    const summary = await fetch(base + '/summary'); assert.equal(summary.status, 409); assert.equal((await summary.json()).code, 'GA4_READ_CONNECTION_NOT_CONFIGURED');
    allowed = false; assert.equal((await fetch(base + '/status')).status, 403);
    assert.equal((await fetch(base + '/summary', {method: 'POST'})).status, 404);
  });
});
test('workspace mount uses its trusted coordinator grant; an ordinary editor cannot open analytics', async () => {
  for (const coordinator of [false, true]) {
    let databaseReads = 0;
    const app = express();
    app.use('/api/admin/content/workspace', createContentWorkspaceRouter({
      env: {}, getAuthenticatedUser: async () => ({user: {id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'}}),
      fetchUserRoleRowForAuthUser: async () => ({role: 'editor_contenido'}),
      supabaseAdmin: {async rpc(name) {assert.equal(name, 'content_workspace_coordinator_access'); return {data: coordinator};}},
      pgPool: {async connect() {databaseReads++; return {async query() {return {rows: [{allowed: true}]};}, release() {}};}},
    }));
    const server = app.listen(0);
    try {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/api/admin/content/workspace/analytics/status`);
      assert.equal(response.status, coordinator ? 200 : 403);
      assert.equal(databaseReads, coordinator ? 1 : 0);
    } finally {server.close();}
  }
});
