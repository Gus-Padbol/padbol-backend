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
const PG_PORT = 55485;
const ACTOR = '11111111-1111-4111-8111-111111111111';
const CLUB_A = '22222222-2222-4222-8222-222222222222';
const CLUB_B = '33333333-3333-4333-8333-333333333333';
const EDITOR = '44444444-4444-4444-8444-444444444444';
const COORDINATOR = '55555555-5555-4555-8555-555555555555';
const ITEM_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ITEM_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ITEM_C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const FILE_A = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const FILE_B = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const FILE_C = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const FILE_PDF = '99999999-9999-4999-8999-999999999999';
const ITEM_IMAGE = 'abababab-abab-4bab-8bab-abababababab';
const FILE_IMAGE = 'cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=','base64');

const DDL = `
CREATE TABLE public.sedes(id bigint PRIMARY KEY,nombre text);
INSERT INTO public.sedes VALUES(7,'PP A'),(8,'PP B');
CREATE TABLE public.user_roles(user_id uuid PRIMARY KEY,role text,sede_id bigint);
INSERT INTO public.user_roles VALUES
 ('${ACTOR}','super_admin',null),('${CLUB_A}','admin_club',7),('${CLUB_B}','admin_club',8),
 ('${EDITOR}','editor_contenido',null),('${COORDINATOR}','coordinador',null);
CREATE SCHEMA storage;
CREATE TABLE storage.buckets(id text PRIMARY KEY,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
CREATE TABLE storage.objects(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),bucket_id text,name text);
DO $r$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
END $r$;`;

const TOKENS = Object.freeze({ super: 'super', a: 'a', b: 'b', editor: 'editor', coordinator: 'coordinator' });
const KNOWN = Object.freeze({ actorId: ACTOR, clubAId: CLUB_A, clubBId: CLUB_B, editorId: EDITOR, coordinatorId: COORDINATOR,
  sedeA: 7, sedeB: 8, itemA: ITEM_A, itemB: ITEM_B, itemC: ITEM_C, fileA: FILE_A, fileB: FILE_B, fileC: FILE_C, filePdf: FILE_PDF,
  itemVersion: 1, category: 'entrenamiento', itemImage: ITEM_IMAGE, fileImage: FILE_IMAGE, pngBytes: PNG, tokens: TOKENS });

function userFor(req) {
  const token = String(req.headers.authorization || '').replace(/^Bearer /, '');
  if (token === TOKENS.super) return { id: ACTOR, email: 'super@fixture' };
  if (token === TOKENS.a) return { id: CLUB_A, email: 'a@fixture' };
  if (token === TOKENS.b) return { id: CLUB_B, email: 'b@fixture' };
  if (token === TOKENS.editor) return { id: EDITOR, email: 'editor@fixture' };
  if (token === TOKENS.coordinator) return { id: COORDINATOR, email: 'coordinator@fixture' };
  return null;
}
async function roleFor(user) {
  if (!user) return null;
  if (user.id === ACTOR) return { role: 'super_admin', sede_id: null };
  if (user.id === CLUB_A) return { role: 'admin_club', sede_id: 7 };
  if (user.id === CLUB_B) return { role: 'admin_club', sede_id: 8 };
  if (user.id === EDITOR) return { role: 'editor_contenido', sede_id: null };
  if (user.id === COORDINATOR) return { role: 'coordinador', sede_id: null };
  return null;
}
function storageBoundary() {
  const storage = {
    privateBucket: false,
    signatureCalls: 0,
    pendingSign: null,
    downloadCalls: 0,
    downloadBlob: new Blob([PNG], { type: 'image/png' }),
    downloadError: null,
    pendingDownload: null,
    async getBucket(name) { return name === 'content-workspace-private' ? { data: { id: name, public: storage.privateBucket }, error: null } : { data: null, error: { message: 'not found' } }; },
    from() {
      return {
        createSignedUrl: (storagePath, ttl) => { storage.signatureCalls += 1; if (storage.pendingSign) return storage.pendingSign; return Promise.resolve({ data: { signedUrl: `https://private.test/${encodeURIComponent(storagePath)}?ttl=${ttl}` }, error: null }); },
        download: async () => { storage.downloadCalls += 1; if (storage.downloadError) return { data: null, error: storage.downloadError }; if (storage.pendingDownload) await storage.pendingDownload; return { data: storage.downloadBlob, error: null }; },
      };
    },
  };
  return storage;
}
async function seedWorkspace(pool) {
  await pool.query(`INSERT INTO public.content_workspace_items(id,version,payload,created_by,updated_by) VALUES
   ($1,1,$2::jsonb,$4,$4),($3,1,$5::jsonb,$4,$4),($6,1,$7::jsonb,$4,$4)`, [ITEM_A, JSON.stringify({ title: 'Entrenamiento A', status: 'aprobado', assetKind: 'final', format: 'video' }), ITEM_B, ACTOR, JSON.stringify({ title: 'Borrador B', status: 'revision', assetKind: 'final', format: 'image' }), ITEM_C, JSON.stringify({ title: 'Publicado C', status: 'publicado', assetKind: 'final', format: 'image' })]);
  await pool.query(`INSERT INTO public.content_workspace_files(id,item_id,name,mime_type,size,storage_path,created_by) VALUES
   ($1,$2,'a.mp4','video/mp4',10,$5,$8),($3,$2,'a.pdf','application/pdf',10,$6,$8),($4,$7,'c.jpg','image/jpeg',10,$9,$8),($10,$7,'c.pdf','application/pdf',10,$11,$8)`, [FILE_A, ITEM_A, FILE_PDF, FILE_C, `${ITEM_A}/${FILE_A}`, `${ITEM_A}/${FILE_PDF}`, ITEM_C, ACTOR, `${ITEM_C}/${FILE_C}`, FILE_B, `${ITEM_C}/${FILE_B}`]);
  await pool.query(`INSERT INTO public.content_workspace_items(id,version,payload,created_by,updated_by) VALUES($1,1,$2::jsonb,$3,$3)`, [ITEM_IMAGE, JSON.stringify({ title: 'Imagen aprobada', status: 'publicado', assetKind: 'final', format: 'image' }), ACTOR]);
  await pool.query(`INSERT INTO public.content_workspace_files(id,item_id,name,mime_type,size,storage_path,created_by) VALUES($1,$2,'tiny.png','image/png',$3,$4,$5)`, [FILE_IMAGE, ITEM_IMAGE, PNG.length, `${ITEM_IMAGE}/${FILE_IMAGE}`, ACTOR]);
  await pool.query(`INSERT INTO public.content_library_categories(sede_id,category_key,enabled,updated_by) VALUES
   (7,'entrenamiento',true,$1),(7,'borrador',false,$1),(8,'entrenamiento',false,$1)`, [ACTOR]);
}
async function cleanup(f, assertOwn = true) {
  if (!f) return;
  if (f.server) { await new Promise(r => f.server.close(r)); if (assertOwn) { if (f.server.listening) throw new Error('owned HTTP server still listening'); } }
  if (f.pool) { await f.pool.end(); }
  if (f.clusterRunning) {
    const out = execFileSync('pg_ctl', ['-D', f.dataDir, '-m', 'immediate', '-w', 'stop'], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } });
    if (assertOwn) {
      if (fs.existsSync(path.join(f.dataDir, 'postmaster.pid'))) throw new Error('owned postmaster.pid remains');
      if (fs.existsSync(path.join(f.sockDir, `.s.PGSQL.${PG_PORT}`))) throw new Error('owned PG socket remains');
      try { process.kill(f.clusterPid, 0); throw new Error('owned postmaster still alive'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
      console.log('FIXTURE_CLEANUP_OK', JSON.stringify({ pg_ctl: out.trim(), pid: f.clusterPid }));
    }
    f.clusterRunning = false;
  }
  if (f.tempDir && fs.existsSync(f.tempDir)) fs.rmSync(f.tempDir, { recursive: true, force: true });
}

/** Start an owned real HTTP+PG17 fixture. Importing this module does not start anything. */
export { KNOWN, TOKENS };
export async function startContentLibraryFixture() {
  const f = { tempDir: null, dataDir: null, sockDir: null, pool: null, server: null, clusterRunning: false, clusterPid: null, storage: storageBoundary(), known: KNOWN, tokens: TOKENS };
  try {
    f.tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'biblioteca-fixture028-'));
    f.dataDir = path.join(f.tempDir, 'data'); f.sockDir = path.join(f.tempDir, 'sock'); fs.mkdirSync(f.sockDir);
    const env = { ...process.env, LC_ALL: 'C', PATH: `/opt/homebrew/bin:${process.env.PATH}` };
    execFileSync('initdb', ['-D', f.dataDir, '-A', 'trust', '-U', process.env.USER, '--no-locale', '-E', 'UTF8'], { stdio: 'ignore', env });
    execFileSync('pg_ctl', ['-D', f.dataDir, '-l', path.join(f.tempDir, 'pg.log'), '-o', `-F -h '' -k ${f.sockDir} -p ${PG_PORT}`, '-w', 'start'], { stdio: 'ignore', env });
    f.clusterRunning = true;
    f.clusterPid = Number(fs.readFileSync(path.join(f.dataDir, 'postmaster.pid'), 'utf8').split('\n')[0]);
    f.pool = new pg.Pool({ host: f.sockDir, port: PG_PORT, user: process.env.USER, database: 'postgres', max: 6 });
    await f.pool.query(DDL);
    await f.pool.query(fs.readFileSync(WS_SQL, 'utf8'));
    await f.pool.query(fs.readFileSync(LIB_SQL, 'utf8'));
    await seedWorkspace(f.pool);
    const app = express(); app.use(express.json());
    const freshRoleFor = async (user) => {
      if (!user) return null;
      const { rows } = await f.pool.query('select role,sede_id from public.user_roles where user_id=$1 limit 1', [user.id]);
      return rows[0] ? { role: rows[0].role, sede_id: rows[0].sede_id } : null;
    };
    app.use('/api/admin/content/library', createContentLibraryRouter({
      pgPool: f.pool, supabaseAdmin: { storage: f.storage },
      getAuthenticatedUser: async (req) => ({ user: userFor(req) }),
      fetchUserRoleRowForAuthUser: freshRoleFor, legacySuperAdminEmails: [],
    }));
    f.server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    f.baseUrl = `http://127.0.0.1:${f.server.address().port}`;
    f.stop = () => cleanup(f, true);
    return f;
  } catch (error) {
    await cleanup(f, false);
    throw error;
  }
}
