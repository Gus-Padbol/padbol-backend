import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startContentLibraryFixture, KNOWN } from './contentLibrary.fixture028.mjs';

const { itemA: ITEM_A, itemB: ITEM_B, fileA: FILE_A, fileB: FILE_B, filePdf: FILE_PDF, tokens } = KNOWN;
let fx, pool, baseUrl;
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
async function call(method, url, body, token = 'super') {
  const headers = {}; if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const r = await fetch(baseUrl + url, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  let data = null; try { data = await r.json(); } catch {}
  return { status: r.status, body: data };
}
before(async () => { fx = await startContentLibraryFixture(); pool = fx.pool; baseUrl = fx.baseUrl; });
beforeEach(async () => {
  fx.storage.signatureCalls = 0; fx.storage.pendingSign = null; fx.storage.privateBucket = false;
  await pool.query('TRUNCATE public.content_library_entries');
  await pool.query("UPDATE public.content_library_categories SET enabled=case when sede_id=7 then true else false end WHERE category_key='entrenamiento'");
});
after(async () => { if (fx) await fx.stop(); });

test('global publication creates one entry; grants differ by PP; same ID for A/B; revoke A leaves B', async () => {
  const pub = await call('POST', '/api/admin/content/library/entries', { item_id: ITEM_A, file_id: FILE_A, expected_version: 1, category_key: 'entrenamiento' });
  assert.equal(pub.status, 201, JSON.stringify(pub.body));
  const entryId = pub.body.entry.id;
  assert.equal((await pool.query('SELECT count(*)::int n FROM public.content_library_entries')).rows[0].n, 1);
  const a = await call('GET', '/api/admin/content/library', undefined, 'a'); assert.equal(a.status, 200); assert.equal(a.body.items.length, 1); assert.equal(a.body.items[0].id, entryId);
  assert.equal(Object.keys(a.body.items[0]).sort().join(','), 'assetKind,category,format,id,mime,sourceVersion,title');
  const b = await call('GET', '/api/admin/content/library', undefined, 'b'); assert.equal(b.status, 200); assert.deepEqual(b.body.items, []);
  const global = await call('GET', '/api/admin/content/library', undefined, 'super'); assert.equal(global.status, 200); assert.equal(global.body.items.length, 1);
  const previewA = await call('GET', '/api/admin/content/library?sede_id=7', undefined, 'super'); assert.equal(previewA.status, 200); assert.equal(previewA.body.items.length, 1);
  const spoof = await call('GET', '/api/admin/content/library?sede_id=8', undefined, 'a'); assert.equal(spoof.status, 403);
  const clubPublish = await call('POST', '/api/admin/content/library/entries', { item_id: ITEM_A, file_id: FILE_A, expected_version: 1, category_key: 'entrenamiento' }, 'a'); assert.equal(clubPublish.status, 403);
  assert.equal((await call('POST', '/api/admin/content/library/entries', { item_id: ITEM_A, file_id: FILE_A, expected_version: 1, category_key: 'entrenamiento' }, 'editor')).status, 403);
  const grantB = await call('POST', '/api/admin/content/library/categories', { sede_id: 8, category_key: 'entrenamiento', enabled: true }); assert.equal(grantB.status, 200);
  const b2 = await call('GET', '/api/admin/content/library', undefined, 'b'); assert.equal(b2.body.items.length, 1); assert.equal(b2.body.items[0].id, entryId);
  assert.equal((await pool.query('SELECT count(*)::int n FROM public.content_library_entries')).rows[0].n, 1);
  assert.equal((await call('POST', '/api/admin/content/library/categories', { sede_id: 7, category_key: 'entrenamiento', enabled: false })).status, 200);
  assert.deepEqual((await call('GET', '/api/admin/content/library', undefined, 'a')).body.items, []);
  assert.equal((await call('GET', '/api/admin/content/library', undefined, 'b')).body.items[0].id, entryId);
});
test('draft/version/PDF/disabled/invalid and unauthorized publish fail closed', async () => {
  assert.equal((await call('POST', '/api/admin/content/library/entries', { item_id: ITEM_B, file_id: FILE_B, expected_version: 1, category_key: 'entrenamiento' })).status, 409);
  assert.equal((await call('POST', '/api/admin/content/library/entries', { item_id: ITEM_A, file_id: FILE_B, expected_version: 1, category_key: 'entrenamiento' })).status, 409);
  assert.equal((await call('POST', '/api/admin/content/library/entries', { item_id: ITEM_A, file_id: FILE_PDF, expected_version: 1, category_key: 'entrenamiento' })).status, 409);
  assert.equal((await call('POST', '/api/admin/content/library/entries', { item_id: ITEM_A, file_id: FILE_A, expected_version: 2, category_key: 'entrenamiento' })).status, 409);
  assert.equal((await call('POST', '/api/admin/content/library/entries', { item_id: 'bad', file_id: FILE_A, expected_version: 1, category_key: 'entrenamiento' })).status, 400);
  assert.equal((await call('POST', '/api/admin/content/library/entries', { item_id: ITEM_A, file_id: FILE_A, expected_version: 1, category_key: 'x' })).status, 400);
  assert.equal((await call('POST', '/api/admin/content/library/entries', { item_id: ITEM_A, file_id: FILE_A, expected_version: 1, category_key: 'entrenamiento' }, 'coordinator')).status, 403);
});
test('download signs private URL only for granted PP; B/revoked-during-signing/private bucket failures do not release URL', async () => {
  const pub = await call('POST', '/api/admin/content/library/entries', { item_id: ITEM_A, file_id: FILE_A, expected_version: 1, category_key: 'entrenamiento' }); assert.equal(pub.status, 201);
  const id = pub.body.entry.id;
  const ok = await call('GET', `/api/admin/content/library/${id}/file`, undefined, 'a'); assert.equal(ok.status, 200); assert.match(ok.body.url, /^https:\/\/private\.test\//); assert.equal(ok.body.expiresIn, 300);
  fx.storage.signatureCalls = 0; const b = await call('GET', `/api/admin/content/library/${id}/file`, undefined, 'b'); assert.equal(b.status, 404); assert.equal(fx.storage.signatureCalls, 0);
  fx.storage.privateBucket = true; const pubBucket = await call('GET', `/api/admin/content/library/${id}/file`, undefined, 'a'); assert.equal(pubBucket.status, 503); assert.equal(fx.storage.signatureCalls, 0); fx.storage.privateBucket = false;
  await call('POST', '/api/admin/content/library/categories', { sede_id: 8, category_key: 'entrenamiento', enabled: true });
  const gate = deferred(); fx.storage.pendingSign = gate.promise; fx.storage.signatureCalls = 0;
  const pending = call('GET', `/api/admin/content/library/${id}/file`, undefined, 'a');
  for (let i = 0; i < 100 && fx.storage.signatureCalls === 0; i += 1) await new Promise(r => setTimeout(r, 5));
  assert.equal(fx.storage.signatureCalls, 1);
  await pool.query("UPDATE public.content_library_categories SET enabled=false WHERE sede_id=7 AND category_key='entrenamiento'");
  gate.resolve({ data: { signedUrl: 'https://private.test/stale' }, error: null });
  const revoked = await pending; assert.equal(revoked.status, 404); assert.equal(revoked.body.url, undefined);
  fx.storage.pendingSign = null;
  assert.equal((await call('GET', `/api/admin/content/library/${id}/file`, undefined, 'b')).status, 200);
  fx.storage.privateBucket = true;
  assert.equal((await call('GET', `/api/admin/content/library/${id}/file`, undefined, 'b')).status, 503);
});
test('workspace version change hides entry globally until explicit republish', async () => {
  assert.equal((await call('POST', '/api/admin/content/library/entries', { item_id: ITEM_A, file_id: FILE_A, expected_version: 1, category_key: 'entrenamiento' })).status, 201);
  await pool.query('UPDATE public.content_workspace_items SET version=2 WHERE id=$1', [ITEM_A]);
  assert.deepEqual((await call('GET', '/api/admin/content/library', undefined, 'a')).body.items, []);
  assert.equal((await call('GET', '/api/admin/content/library', undefined, 'super')).body.items.length, 0);
  const id = (await pool.query('SELECT id FROM public.content_library_entries LIMIT 1')).rows[0].id;
  assert.equal((await call('GET', `/api/admin/content/library/${id}/file`, undefined, 'super')).status, 404);
  assert.equal((await call('POST', '/api/admin/content/library/entries', { item_id: ITEM_A, file_id: FILE_A, expected_version: 2, category_key: 'entrenamiento' })).status, 201);
  assert.equal((await call('GET', '/api/admin/content/library', undefined, 'super')).body.items.length, 1);
});
