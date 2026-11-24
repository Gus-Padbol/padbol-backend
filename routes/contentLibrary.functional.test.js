import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import pg from 'pg';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createContentLibraryRouter } from './contentLibrary.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const WS_SQL = path.join(ROOT, 'sql/migrations/20261026010000_content_workspace.sql');
const LIB_SQL = path.join(ROOT, 'sql/candidates/20261124_content_library_catalog.sql');
const PORT = 55485;
const ACTOR = '11111111-1111-4111-8111-111111111111';
const CLUB_A = '22222222-2222-4222-8222-222222222222';
const CLUB_B = '33333333-3333-4333-8333-333333333333';
const ITEM_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ITEM_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ITEM_C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const FILE_A = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const FILE_B = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const FILE_C = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const FILE_PDF = '99999999-9999-4999-8999-999999999999';
let tmp, dataDir, sockDir, pool, server, baseUrl, clusterPid, clusterRunning = false;
let signatureCalls = 0, pendingSign = null, privateBucket = false;

const DDL = `
CREATE TABLE public.sedes(id bigint PRIMARY KEY,nombre text);
INSERT INTO public.sedes VALUES(7,'PP A'),(8,'PP B');
CREATE TABLE public.user_roles(user_id uuid PRIMARY KEY,role text,sede_id bigint);
INSERT INTO public.user_roles VALUES('${ACTOR}','super_admin',null),('${CLUB_A}','admin_club',7),('${CLUB_B}','admin_club',8);
CREATE SCHEMA storage;
CREATE TABLE storage.buckets(id text PRIMARY KEY,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
CREATE TABLE storage.objects(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),bucket_id text,name text);
DO $r$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
END $r$;`;

function authUser(req) {
  const token = String(req.headers.authorization || '');
  if (token === 'Bearer super') return { id: ACTOR, email: 'super@test' };
  if (token === 'Bearer a') return { id: CLUB_A, email: 'a@test' };
  if (token === 'Bearer b') return { id: CLUB_B, email: 'b@test' };
  return null;
}
async function roleFor(user) {
  if (user.id === ACTOR) return { role: 'super_admin', sede_id: null };
  if (user.id === CLUB_A) return { role: 'admin_club', sede_id: 7 };
  if (user.id === CLUB_B) return { role: 'admin_club', sede_id: 8 };
  return null;
}
const storage = {
  async getBucket(name) { return name === 'content-workspace-private' ? { data: { id: name, public: privateBucket }, error: null } : { data: null, error: { message: 'not found' } }; },
  from(name) { return { async createSignedUrl(storagePath, ttl) { signatureCalls += 1; if (pendingSign) return pendingSign; return { data: { signedUrl: `https://private.test/${encodeURIComponent(storagePath)}?ttl=${ttl}` }, error: null }; } }; },
};
async function call(method, url, body, token = 'super') {
  const headers = {}; if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const r = await fetch(baseUrl + url, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  let data = null; try { data = await r.json(); } catch {}
  return { status: r.status, body: data };
}
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
async function seedWorkspace() {
  await pool.query(`INSERT INTO public.content_workspace_items(id,version,payload,created_by,updated_by) VALUES
   ($1,1,$2::jsonb,$4,$4),($3,1,$5::jsonb,$4,$4),($6,1,$7::jsonb,$4,$4)`, [ITEM_A, JSON.stringify({ title: 'Entrenamiento A', status: 'aprobado', assetKind: 'final', format: 'video' }), ITEM_B, ACTOR, JSON.stringify({ title: 'Borrador B', status: 'revision', assetKind: 'final', format: 'image' }), ITEM_C, JSON.stringify({ title: 'Publicado C', status: 'publicado', assetKind: 'final', format: 'image' })]);
  await pool.query(`INSERT INTO public.content_workspace_files(id,item_id,name,mime_type,size,storage_path,created_by) VALUES
   ($1,$2,'a.mp4','video/mp4',10,$5,$8),($3,$2,'a.pdf','application/pdf',10,$6,$8),($4,$7,'c.jpg','image/jpeg',10,$9,$8),($10,$7,'c.pdf','application/pdf',10,$11,$8)`, [FILE_A, ITEM_A, FILE_PDF, FILE_C, `${ITEM_A}/${FILE_A}`, `${ITEM_A}/${FILE_PDF}`, ITEM_C, ACTOR, `${ITEM_C}/${FILE_C}`, FILE_B, `${ITEM_C}/${FILE_B}`]);
  await pool.query(`INSERT INTO public.content_library_categories(sede_id,category_key,enabled,updated_by) VALUES(7,'entrenamiento',true,$1),(7,'borrador',false,$1),(8,'entrenamiento',false,$1)`, [ACTOR]);
}
before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'biblioteca-catalog-')); dataDir = path.join(tmp, 'data'); sockDir = path.join(tmp, 'sock'); fs.mkdirSync(sockDir);
  const env = { ...process.env, LC_ALL: 'C', PATH: `/opt/homebrew/bin:${process.env.PATH}` };
  execFileSync('initdb', ['-D', dataDir, '-A', 'trust', '-U', process.env.USER, '--no-locale', '-E', 'UTF8'], { stdio: 'ignore', env });
  execFileSync('pg_ctl', ['-D', dataDir, '-l', path.join(tmp, 'pg.log'), '-o', `-F -h '' -k ${sockDir} -p ${PORT}`, '-w', 'start'], { stdio: 'ignore', env });
  clusterRunning = true; clusterPid = Number(fs.readFileSync(path.join(dataDir, 'postmaster.pid'), 'utf8').split('\n')[0]);
  pool = new pg.Pool({ host: sockDir, port: PORT, user: process.env.USER, database: 'postgres', max: 6 });
  await pool.query(DDL); await pool.query(fs.readFileSync(WS_SQL, 'utf8')); await pool.query(fs.readFileSync(LIB_SQL, 'utf8')); await seedWorkspace();
  const app = express(); app.use(express.json());
  app.use('/api/admin/content/library', createContentLibraryRouter({ pgPool: pool, supabaseAdmin: { storage }, getAuthenticatedUser: async (req) => ({ user: authUser(req) }), fetchUserRoleRowForAuthUser: roleFor, legacySuperAdminEmails: [] }));
  server = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); }); baseUrl = `http://127.0.0.1:${server.address().port}`;
});
beforeEach(async () => { signatureCalls = 0; pendingSign = null; privateBucket = false; await pool.query('TRUNCATE public.content_library_entries'); await pool.query("UPDATE public.content_library_categories SET enabled=case when sede_id=7 then true else false end WHERE category_key='entrenamiento'"); });
after(async () => { if (server) { await new Promise(r => server.close(r)); assert.equal(server.listening, false); } if (pool) await pool.end(); if (clusterRunning) { const out = execFileSync('pg_ctl', ['-D', dataDir, '-m', 'immediate', '-w', 'stop'], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } }); assert.equal(fs.existsSync(path.join(dataDir, 'postmaster.pid')), false); assert.equal(fs.existsSync(path.join(sockDir, `.s.PGSQL.${PORT}`)), false); assert.throws(() => process.kill(clusterPid, 0), /ESRCH/); console.log('CLEANUP_OK', out.trim()); } if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); });

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

  const grantB = await call('POST', '/api/admin/content/library/categories', { sede_id: 8, category_key: 'entrenamiento', enabled: true }); assert.equal(grantB.status, 200);
  const b2 = await call('GET', '/api/admin/content/library', undefined, 'b'); assert.equal(b2.body.items.length, 1); assert.equal(b2.body.items[0].id, entryId);
  assert.equal((await pool.query('SELECT count(*)::int n FROM public.content_library_entries')).rows[0].n, 1);
  const revokeA = await call('POST', '/api/admin/content/library/categories', { sede_id: 7, category_key: 'entrenamiento', enabled: false }); assert.equal(revokeA.status, 200);
  const a3 = await call('GET', '/api/admin/content/library', undefined, 'a'); assert.deepEqual(a3.body.items, []);
  const b3 = await call('GET', '/api/admin/content/library', undefined, 'b'); assert.equal(b3.body.items[0].id, entryId);
});
test('draft/version/PDF/disabled/invalid and unauthorized publish fail closed', async () => {
  assert.equal((await call('POST', '/api/admin/content/library/entries', { item_id: ITEM_B, file_id: FILE_B, expected_version: 1, category_key: 'entrenamiento' })).status, 409);
  assert.equal((await call('POST', '/api/admin/content/library/entries', { item_id: ITEM_A, file_id: FILE_B, expected_version: 1, category_key: 'entrenamiento' })).status, 409);
  assert.equal((await call('POST', '/api/admin/content/library/entries', { item_id: ITEM_A, file_id: FILE_PDF, expected_version: 1, category_key: 'entrenamiento' })).status, 409);
  assert.equal((await call('POST', '/api/admin/content/library/entries', { item_id: ITEM_A, file_id: FILE_A, expected_version: 2, category_key: 'entrenamiento' })).status, 409);
  assert.equal((await call('POST', '/api/admin/content/library/entries', { item_id: 'bad', file_id: FILE_A, expected_version: 1, category_key: 'entrenamiento' })).status, 400);
  assert.equal((await call('POST', '/api/admin/content/library/entries', { item_id: ITEM_A, file_id: FILE_A, expected_version: 1, category_key: 'x' })).status, 400);
  assert.equal((await call('POST', '/api/admin/content/library/entries', { item_id: ITEM_A, file_id: FILE_A, expected_version: 1, category_key: 'entrenamiento' }, 'a')).status, 403);
});
test('download signs private URL only for granted PP; B/revoked-during-signing/private bucket failures do not release URL', async () => {
  const pub = await call('POST', '/api/admin/content/library/entries', { item_id: ITEM_A, file_id: FILE_A, expected_version: 1, category_key: 'entrenamiento' }); assert.equal(pub.status, 201);
  const id = pub.body.entry.id;
  const ok = await call('GET', `/api/admin/content/library/${id}/file`, undefined, 'a'); assert.equal(ok.status, 200); assert.match(ok.body.url, /^https:\/\/private\.test\//); assert.equal(ok.body.expiresIn, 300);
  signatureCalls = 0; const b = await call('GET', `/api/admin/content/library/${id}/file`, undefined, 'b'); assert.equal(b.status, 404); assert.equal(signatureCalls, 0);
  privateBucket = true; const pubBucket = await call('GET', `/api/admin/content/library/${id}/file`, undefined, 'a'); assert.equal(pubBucket.status, 503); assert.equal(signatureCalls, 0); privateBucket = false;
  await call('POST', '/api/admin/content/library/categories', { sede_id: 8, category_key: 'entrenamiento', enabled: true });
  const gate = deferred(); pendingSign = gate.promise; signatureCalls = 0;
  const pending = call('GET', `/api/admin/content/library/${id}/file`, undefined, 'a');
  for (let i = 0; i < 100 && signatureCalls === 0; i += 1) await new Promise(r => setTimeout(r, 5));
  assert.equal(signatureCalls, 1);
  await pool.query("UPDATE public.content_library_categories SET enabled=false WHERE sede_id=7 AND category_key='entrenamiento'");
  gate.resolve({ data: { signedUrl: 'https://private.test/stale' }, error: null });
  const revoked = await pending; assert.equal(revoked.status, 404); assert.equal(revoked.body.url, undefined);
  pendingSign = null; const stillB = await call('GET', `/api/admin/content/library/${id}/file`, undefined, 'b'); assert.equal(stillB.status, 200); assert.match(stillB.body.url, /^https:\/\/private\.test\//);
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
console.log('LIBRARY027_TESTS_DONE');
