import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startContentLibraryFixture, KNOWN } from './contentLibrary.fixture028.mjs';

const { itemImage: ITEM, fileImage: FILE, pngBytes: PNG, tokens } = KNOWN;
let fx, baseUrl, pool;
async function call(method, url, body, token = 'super') {
  const headers = {}; if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const r = await fetch(baseUrl + url, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  let data = null; if ((r.headers.get('content-type') || '').includes('application/json')) data = await r.json();
  return { status: r.status, body: data, headers: r.headers, buffer: data ? null : Buffer.from(await r.arrayBuffer()) };
}
const publish = () => call('POST', '/api/admin/content/library/entries', { item_id: ITEM, file_id: FILE, expected_version: 1, category_key: 'entrenamiento' });
const image = (id, version = 1, token = 'a') => call('GET', `/api/admin/content/library/${id}/image?source_version=${version}`, undefined, token);
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
before(async () => { process.env.CONTENT_PRIVATE_DESIGNS_ENABLED = 'true'; fx = await startContentLibraryFixture(); baseUrl = fx.baseUrl; pool = fx.pool; });
beforeEach(async () => {
  process.env.CONTENT_PRIVATE_DESIGNS_ENABLED = 'true';
  await pool.query('TRUNCATE public.content_library_entries');
  await pool.query("UPDATE public.content_library_categories SET enabled=true WHERE sede_id=7 AND category_key='entrenamiento'");
  await pool.query("UPDATE public.user_roles SET role='admin_club' WHERE user_id=$1", [KNOWN.clubAId]);
  fx.storage.downloadCalls = 0; fx.storage.downloadBlob = new Blob([PNG], { type: 'image/png' }); fx.storage.downloadError = null; fx.storage.pendingDownload = null;
});
after(async () => { if (fx) await fx.stop(); });

test('image bytes, exact headers, version/PP denial and flag off', async () => {
  const pub = await publish(); assert.equal(pub.status, 201); const id = pub.body.entry.id;
  const r = await image(id); assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.headers.get('content-type'), 'image/png');
  assert.equal(r.headers.get('cache-control'), 'private, no-store');
  assert.equal(r.headers.get('vary'), 'Authorization');
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(r.headers.get('x-content-sha256'), (await import('node:crypto')).createHash('sha256').update(PNG).digest('hex'));
  assert.deepEqual(r.buffer, PNG);
  assert.equal((await image(id, 1, 'b')).status, 404);
  assert.equal((await image(id, 2)).status, 409);
  assert.equal((await call('GET', `/api/admin/content/library/${id}/image`, undefined, 'a')).status, 400);
  process.env.CONTENT_PRIVATE_DESIGNS_ENABLED = 'false';
  assert.equal((await image(id)).status, 503);
});
test('category or actor revocation during awaited download releases no image', async () => {
  const pub = await publish(); const id = pub.body.entry.id;
  const gate = deferred(); fx.storage.pendingDownload = gate.promise;
  const pending = image(id); for (let i=0;i<100 && fx.storage.downloadCalls===0;i++) await new Promise(r=>setTimeout(r,5));
  assert.equal(fx.storage.downloadCalls,1);
  await pool.query("UPDATE public.content_library_categories SET enabled=false WHERE sede_id=7 AND category_key='entrenamiento'");
  gate.resolve(); const revoked = await pending; assert.equal(revoked.status,404); assert.equal(revoked.buffer,null);
  await pool.query("UPDATE public.content_library_categories SET enabled=true WHERE sede_id=7 AND category_key='entrenamiento'");
  const roleGate = deferred(); fx.storage.pendingDownload = roleGate.promise;
  const rolePending = image(id); for (let i=0;i<100 && fx.storage.downloadCalls<2;i++) await new Promise(r=>setTimeout(r,5));
  await pool.query("UPDATE public.user_roles SET role='editor_contenido' WHERE user_id=$1", [KNOWN.clubAId]);
  roleGate.resolve(); const roleRevoked = await rolePending; assert.equal(roleRevoked.status,403); assert.equal(roleRevoked.buffer,null);
  await pool.query("UPDATE public.user_roles SET role='admin_club',sede_id=7 WHERE user_id=$1", [KNOWN.clubAId]);
});
test('bucket/MIME/signature/size/SDK failures fail closed', async () => {
  const pub = await publish(); const id = pub.body.entry.id;
  fx.storage.privateBucket = true; assert.equal((await image(id)).status,503); fx.storage.privateBucket = false;
  fx.storage.downloadBlob = new Blob([PNG], { type: 'image/jpeg' }); assert.equal((await image(id)).status,415);
  fx.storage.downloadBlob = new Blob([Buffer.alloc(8*1024*1024+1)], { type: 'image/png' }); assert.equal((await image(id)).status,413);
  fx.storage.downloadError = new Error('storage unavailable'); assert.equal((await image(id)).status,503);
});
