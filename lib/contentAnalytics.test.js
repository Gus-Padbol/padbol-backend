import {test} from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync, createVerify} from 'node:crypto';
import {createContentAnalytics, GA4_PROPERTY_ID} from './contentAnalytics.js';

const actor = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const {privateKey, publicKey} = generateKeyPairSync('rsa', {modulusLength: 2048});
const env = {GA4_READ_SERVICE_ACCOUNT_EMAIL: 'reader@padbol-test.iam.gserviceaccount.com', GA4_READ_SERVICE_ACCOUNT_PRIVATE_KEY: privateKey.export({format: 'pem', type: 'pkcs8'}).toString()};
const now = () => new Date('2026-10-28T14:00:00Z');
function fixture(extra = {}) {
  let allowed = true; const calls = [], queries = [];
  const pool = {async connect() { return {async query(sql, args) {queries.push({sql, args}); return {rows: [{allowed}]};}, release() {}}; }};
  const reports = () => {
    const report = (names, daily, values) => ({metricHeaders: names.map(name => ({name})), dimensionHeaders: daily ? [{name: 'date'}] : [], metadata: {timeZone: 'America/Argentina/Buenos_Aires'}, rowCount: 1, rows: [{dimensionValues: daily ? [{value: '20261026'}] : [], metricValues: values.map(value => ({value: String(value)}))}]});
    return [report(['activeUsers', 'sessions', 'screenPageViews'], false, [5, 9, 20]), report(['activeUsers', 'sessions', 'screenPageViews'], true, [4, 7, 16]), report(['eventCount'], false, [2]), report(['eventCount'], true, [2])];
  };
  const fetchImpl = async (url, options) => {calls.push({url, options}); if (extra.fetchImpl) return extra.fetchImpl(url, options); return new Response(JSON.stringify(url.includes('oauth2.') ? {access_token: 'mock-token', token_type: 'Bearer', expires_in: 3600} : {reports: extra.reports ? extra.reports(reports()) : reports()}));};
  return {calls, queries, setAllowed(value) {allowed = value;}, service: createContentAnalytics({pool, env: extra.env || env, now, fetchImpl})};
}
test('missing/invalid configuration is honest and performs no outbound request', async () => {
  for (const invalid of [{}, {...env, GA4_READ_SERVICE_ACCOUNT_PRIVATE_KEY: 'not a key'}, {...env, GA4_READ_SERVICE_ACCOUNT_EMAIL: 'personal@example.com'}]) {
    const f = fixture({env: invalid});
    assert.equal((await f.service.status(actor)).connection.status, 'not_configured');
    await assert.rejects(f.service.summary(actor), e => e.code === 'GA4_READ_CONNECTION_NOT_CONFIGURED' && e.status === 409);
    assert.equal(f.calls.length, 0);
  }
});
test('persisted access is checked before every read and network request, even with a cached OAuth token', async () => {
  const f = fixture(); await f.service.summary(actor); f.setAllowed(false);
  const count = f.calls.length;
  await assert.rejects(f.service.status(actor), e => e.code === 'FORBIDDEN');
  await assert.rejects(f.service.summary(actor), e => e.code === 'FORBIDDEN');
  assert.equal(f.calls.length, count);
  assert.ok(f.queries.every(q => q.sql === 'select public.content_meta_access($1) allowed' && q.args[0] === actor));
  await assert.rejects(f.service.status('forged-email@example.com'), e => e.status === 403);
});
test('uses signed read-only OAuth assertion, fixed endpoints, aggregate reports and period totals', async () => {
  const f = fixture(); const data = await f.service.summary(actor, {since: '2026-10-01', until: '2026-10-27'});
  assert.deepEqual(data.totals, {activeUsers: 5, sessions: 9, pageViews: 20, leads: 2});
  assert.equal(data.daily[0].activeUsers, 4); // Never sum daily users to fabricate a period unique count.
  assert.equal(data.meta.propertyId, GA4_PROPERTY_ID);
  assert.equal(data.meta.source, 'ga4_data_api');
  const [oauth, reports] = f.calls;
  assert.equal(oauth.url, 'https://oauth2.googleapis.com/token');
  const form = new URLSearchParams(oauth.options.body), jwt = form.get('assertion').split('.');
  const claims = JSON.parse(Buffer.from(jwt[1], 'base64url'));
  assert.equal(claims.scope, 'https://www.googleapis.com/auth/analytics.readonly');
  assert.equal(claims.aud, oauth.url); assert.equal(claims.exp - claims.iat, 3600);
  assert.equal(createVerify('RSA-SHA256').update(jwt[0] + '.' + jwt[1]).end().verify(publicKey, jwt[2], 'base64url'), true);
  assert.equal(reports.url, 'https://analyticsdata.googleapis.com/v1beta/properties/435359413:batchRunReports');
  const request = JSON.parse(reports.options.body);
  assert.equal(request.requests.length, 4);
  assert.ok(request.requests.every(r => r.dimensions.length === 0 || r.dimensions[0].name === 'date'));
  assert.equal(request.requests[0].dimensionFilter.filter.stringFilter.value, '7814357529');
  assert.equal(request.requests[2].dimensionFilter.andGroup.expressions[1].filter.stringFilter.value, 'lead_success');
  assert.ok(f.calls.every(c => c.options.redirect === 'error' && c.options.method === 'POST'));
  await f.service.summary(actor); assert.equal(f.calls.filter(c => c.url.includes('oauth2.')).length, 1);
  assert.ok(!JSON.stringify(data).includes('mock-token'));
});
test('validates calendar days, complete periods, max inclusive92 days, and rejects property/metric overrides before network', async () => {
  const f = fixture();
  for (const query of [{since: '2026-02-30'}, {since: '2026-10-27', until: '2026-10-01'}, {until: '2026-10-28'}, {since: '2026-01-01', until: '2026-10-27'}, {propertyId: 'other'}, {since: ['2026-10-01']}]) {
    await assert.rejects(f.service.summary(actor, query), e => e.code === 'GA4_INVALID_DATE');
  }
  assert.equal(f.calls.length, 0);
  const result = await f.service.summary(actor, {since: '2026-07-28', until: '2026-10-27'});
  assert.equal(result.range.since, '2026-07-28');
});
test('empty report rows stay missing, not fabricated zeros; reports carry privacy and sampling warnings', async () => {
  const f = fixture({reports: reports => reports.map(r => ({...r, rowCount: 0, rows: [], metadata: {...r.metadata, subjectToThresholding: true, samplingMetadatas: [{}]}}))});
  const result = await f.service.summary(actor);
  assert.deepEqual(result.totals, {activeUsers: null, sessions: null, pageViews: null, leads: null});
  assert.deepEqual(result.daily, []); assert.ok(result.meta.warnings.some(w => w.includes('privacidad'))); assert.ok(result.meta.warnings.some(w => w.includes('muestreados')));
});
test('rejects incomplete, mismatched or malformed Google response without exposing provider content', async () => {
  const variants = [r => r.slice(0, 3), r => {r[0].metricHeaders[0].name = 'wrong'; return r;}, r => {r[0].rows[0].metricValues[0].value = '-1'; return r;}, r => {r[1].rows[0].dimensionValues[0].value = '20261399'; return r;}, r => {r[1].rowCount = 200; return r;}, r => {r[0].metadata.timeZone = 'not a zone'; r.forEach(x => {x.metadata.timeZone = 'not a zone';}); return r;}];
  for (const variant of variants) await assert.rejects(fixture({reports: variant}).service.summary(actor), e => e.code === 'GA4_INVALID_RESPONSE');
});
test('Google authorization failure and network errors stay generic, never propagate token, private key or provider error', async () => {
  const f = fixture({fetchImpl: async () => new Response(JSON.stringify({error: 'private-provider-token-detail'}), {status: 403})});
  await assert.rejects(f.service.summary(actor), e => e.code === 'GA4_READ_AUTHORIZATION_FAILED' && !e.message.includes('private-provider'));
  const g = fixture({fetchImpl: async () => {throw Error('secret-token');}});
  await assert.rejects(g.service.summary(actor), e => e.code === 'GA4_READ_UNAVAILABLE' && !e.message.includes('secret-token'));
});
