import test, {before, after} from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {deflateSync} from 'node:zlib';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {createContentDesignsRouter} from './contentDesigns.js';
import {createContentDesignsBodyGate, CONTENT_DESIGNS_JSON_LIMIT, CONTENT_DESIGNS_MOUNT_PATH} from '../lib/contentDesignsBodyGate.js';
import {known, pngLogo} from './contentDesigns.fixture038.mjs';

// Fixture propio 052: PG17 aislado en puerto libre. No reutiliza el puerto fijo
// del fixture 038 ni modifica su fuente; monta el gate real de server.js.
const API = '/api/admin/content/designs';
const b64 = bytes => Buffer.alloc(bytes).toString('base64');

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const b of bytes) {
    crc ^= b;
    for (let n = 0; n < 8; n++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const tag = Buffer.from(type), out = Buffer.alloc(data.length + 12);
  out.writeUInt32BE(data.length);
  tag.copy(out, 4);
  data.copy(out, 8);
  out.writeUInt32BE(crc32(Buffer.concat([tag, data])), data.length + 8);
  return out;
}
// PNG RGBA determinista >100KB decodificados y <2MB, filtros válidos.
function bigPng({width = 400, height = 400, seed = 0x052052} = {}) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  let state = seed >>> 0;
  for (let y = 0; y < height; y++) {
    const row = y * (width * 4 + 1);
    raw[row] = 0;
    for (let i = 1; i <= width * 4; i++) {
      state = (1664525 * state + 1013904223) >>> 0;
      raw[row + i] = state >>> 24;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const bytes = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  return {dataUrl: `data:image/png;base64,${bytes.toString('base64')}`, bytes: bytes.length};
}
const doc = pngDataUrl => ({
  schemaVersion: 1,
  title: 'Diseño privado 052',
  baseEntryId: known.entry,
  baseSourceVersion: 1,
  format: 'feed',
  layers: [
    {id: 'venueName', type: 'text', text: 'PP A', x: 0.5, y: 0.5, fontFamily: 'Outfit', fontWeight: 800, fontSize: 56, color: '#FFFFFF', align: 'center'},
    {id: 'venueLogo', type: 'logo', x: 0.5, y: 0.8, size: 0.16, pngDataUrl},
  ],
});
const intent = pngDataUrl => ({sede_id: 7, operation_key: randomUUID(), project: {id: randomUUID(), expectedVersion: 0, document: doc(pngDataUrl)}});

async function freePort() {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function startOwn() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'designs052-'));
  const data = path.join(dir, 'data');
  const port = await freePort();
  const run = (name, args) => execFileSync('/opt/homebrew/bin/' + name, args, {
    env: {PATH: '/usr/bin:/bin', LC_ALL: 'C'},
    stdio: 'pipe',
    timeout: 15000,
  });
  let pool, server;
  try {
    run('initdb', ['-D', data, '-U', 'postgres', '-A', 'trust', '--no-locale', '-E', 'UTF8']);
    run('pg_ctl', ['-D', data, '-l', path.join(dir, 'pg.log'), '-o', `-F -h '' -k ${dir} -p ${port}`, '-w', 'start']);
    pool = new pg.Pool({host: dir, port, user: 'postgres', database: 'postgres', max: 10, connectionTimeoutMillis: 2000, query_timeout: 10000});
    assert.match((await pool.query('SHOW server_version_num')).rows[0].server_version_num, /^17/);
    await pool.query("CREATE ROLE anon NOLOGIN;CREATE ROLE authenticated NOLOGIN;CREATE ROLE service_role NOLOGIN;CREATE SCHEMA auth;CREATE TABLE auth.users(id uuid PRIMARY KEY);CREATE TABLE organizaciones(id uuid PRIMARY KEY);CREATE TABLE sedes(id bigint PRIMARY KEY,nombre text);INSERT INTO sedes VALUES(7,'PP A'),(8,'PP B');CREATE TABLE user_roles(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,user_id uuid,role text,sede_id bigint)");
    await pool.query('CREATE SCHEMA storage;CREATE TABLE storage.buckets(id text PRIMARY KEY,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);CREATE TABLE storage.objects(id uuid,bucket_id text,name text)');
    await pool.query(fs.readFileSync(new URL('../sql/migrations/20261026010000_content_workspace.sql', import.meta.url), 'utf8'));
    await pool.query(fs.readFileSync(new URL('../sql/candidates/20261124_content_library_catalog.sql', import.meta.url), 'utf8'));
    await pool.query(fs.readFileSync(new URL('../sql/candidates/20261124_private_designs038.sql', import.meta.url), 'utf8'));
    await pool.query('INSERT INTO auth.users VALUES($1)', [known.a]);
    await pool.query("INSERT INTO user_roles(user_id,role,sede_id) VALUES($1,'admin_club',7)", [known.a]);
    await pool.query('INSERT INTO content_workspace_items(id,payload,created_by,updated_by) VALUES($1,$2,$1,$1)', [known.item, {title: 'Approved background', status: 'aprobado', assetKind: 'textless', format: 'feed'}]);
    const png = Buffer.from(pngLogo().split(',')[1], 'base64');
    await pool.query("INSERT INTO content_workspace_files(id,item_id,name,mime_type,size,storage_path,created_by) VALUES($1,$2,'background.png','image/png',$4,$5,$3)", [known.file, known.item, known.a, png.length, known.item + '/' + known.file]);
    await pool.query("INSERT INTO content_library_categories(sede_id,category_key,enabled,updated_by) VALUES(7,'promociones',true,$1)", [known.a]);
    await pool.query("INSERT INTO content_library_entries(id,item_id,file_id,category_key,source_version,published_by) VALUES($1,$2,$3,'promociones',1,$4)", [known.entry, known.item, known.file, known.a]);

    const db = {calls: 0};
    const pgPool = {query(...args) { db.calls++; return pool.query(...args); }};
    const authDeps = {
      getAuthenticatedUser: async req => ({user: req.headers.authorization === `Bearer ${known.a}` ? {id: known.a} : null}),
      fetchUserRoleRowForAuthUser: async user => (await pool.query('SELECT role,sede_id FROM user_roles WHERE user_id=$1', [user.id])).rows[0] || null,
    };
    const app = express();
    // Mismo orden que server.js: gate 052 antes del parser global (default 100KB).
    app.use(createContentDesignsBodyGate());
    app.use(express.json());
    app.post('/api/test/global-body', (req, res) => res.json({ok: true, bytes: JSON.stringify(req.body || {}).length}));
    app.use(API, createContentDesignsRouter({pgPool, ...authDeps}));
    server = createServer(app);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const call = async (method, url, body, headers = {}) => {
      const response = await fetch(baseUrl + url, {
        method,
        signal: AbortSignal.timeout(15000),
        headers: {'content-type': 'application/json', authorization: `Bearer ${known.a}`, ...headers},
        ...(body !== undefined ? {body: typeof body === 'string' ? body : JSON.stringify(body)} : {}),
      });
      const text = await response.text();
      let json = null;
      try { json = JSON.parse(text); } catch {}
      return {status: response.status, contentType: response.headers.get('content-type'), text, json};
    };
    return {pool, pgPool, db, baseUrl, call, async stop() {
      if (server) await new Promise(resolve => { server.close(resolve); server.closeAllConnections?.(); });
      if (pool) await pool.end();
      run('pg_ctl', ['-D', data, '-m', 'immediate', '-w', 'stop']);
      fs.rmSync(dir, {recursive: true, force: true});
    }};
  } catch (error) {
    try { if (server) await new Promise(resolve => server.close(resolve)); } catch {}
    try { if (pool) await pool.end(); } catch {}
    try { run('pg_ctl', ['-D', data, '-m', 'immediate', '-w', 'stop']); } catch {}
    fs.rmSync(dir, {recursive: true, force: true});
    throw error;
  }
}

let ctx;
const priorFlag = process.env.CONTENT_PRIVATE_DESIGNS_ENABLED;
before(async () => {
  process.env.CONTENT_PRIVATE_DESIGNS_ENABLED = 'true';
  ctx = await startOwn();
});
after(async () => {
  await ctx?.stop();
  if (priorFlag === undefined) delete process.env.CONTENT_PRIVATE_DESIGNS_ENABLED;
  else process.env.CONTENT_PRIVATE_DESIGNS_ENABLED = priorFlag;
});

test('052 gate 4mb y parser global 100KB quedan registrados en el server real', () => {
  assert.equal(CONTENT_DESIGNS_JSON_LIMIT, '4mb');
  assert.equal(CONTENT_DESIGNS_MOUNT_PATH, API);
  const source = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  const designsGate = source.indexOf('app.use(createContentDesignsBodyGate())');
  const profileGate = source.indexOf('app.use(createProfilePhotoGate(');
  const webhookRaw = source.indexOf('app.use(WHATSAPP_CLOUD_WEBHOOK_PATH, express.raw(');
  const relayRaw = source.indexOf('app.use(RELAY_PATH, express.raw(');
  const globalParser = source.indexOf('app.use(express.json({');
  assert.ok(designsGate > 0 && profileGate > 0 && webhookRaw > 0 && relayRaw > 0 && globalParser > 0);
  assert.ok(webhookRaw < designsGate && relayRaw < designsGate, 'webhooks conservan su raw body previo');
  assert.ok(designsGate < globalParser, 'gate designs debe ir antes del parser global');
  assert.ok(profileGate < globalParser, 'parser de foto debe conservar su orden previo');
  assert.ok(!/limit\s*:/.test(source.slice(globalParser, globalParser + 260)), 'el parser global debe conservar el default de 100KB');
  assert.match(source, /req\.originalUrl === '\/api\/webhooks\/stripe'/);
  assert.match(source, /app\.use\('\/api\/admin\/content\/designs', createContentDesignsRouter\(/);
});

test('052 HTTP real: PNG >100KB (<2MB) atraviesa gate, handler 038 y PG con rol/metadata correctos', async () => {
  const png = bigPng();
  assert.ok(png.bytes > 100 * 1024 && png.bytes < 2 * 1024 * 1024, `PNG ${png.bytes} fuera de rango`);
  const b = intent(png.dataUrl);
  const saved = await ctx.call('POST', API, b);
  assert.equal(saved.status, 200, saved.text);
  assert.equal(saved.json.project.version, 1);
  assert.equal(saved.json.project.sedeId, 7);
  assert.equal(saved.json.replayed, false);
  assert.equal(saved.json.receipt.projectId, b.project.id);
  const row = (await ctx.pool.query("SELECT created_by,sede_id,version,document->'layers'->1->>'pngDataUrl' png FROM content_design_projects WHERE id=$1", [b.project.id])).rows[0];
  assert.equal(row.created_by, known.a);
  assert.equal(Number(row.sede_id), 7);
  assert.equal(Number(row.version), 1);
  assert.ok(row.png.startsWith('data:image/png;base64,'));
  assert.ok(row.png.length > 100 * 1024, `logo persistido ${row.png.length}`);
  const op = (await ctx.pool.query('SELECT actor_id,sede_id,version FROM content_design_operations WHERE project_id=$1', [b.project.id])).rows[0];
  assert.deepEqual({actor: op.actor_id, sede: Number(op.sede_id), version: Number(op.version)}, {actor: known.a, sede: 7, version: 1});
});

test('052 otro endpoint y ruta hermana >100KB siguen rechazando 413', async () => {
  const big = {blob: b64(300 * 1024)};
  const other = await ctx.call('POST', '/api/test/global-body', big);
  assert.equal(other.status, 413);
  const sibling = await ctx.call('POST', `${API}-extra`, big);
  assert.equal(sibling.status, 413);
  assert.notEqual(sibling.json?.code, 'CONTENT_DESIGN_TOO_LARGE');
});

test('052 >4MB en designs rechaza 413 JSON tipado antes de router/PG', async () => {
  const before = ctx.db.calls;
  const projectsBefore = (await ctx.pool.query('SELECT count(*)::int n FROM content_design_projects')).rows[0].n;
  const operationsBefore = (await ctx.pool.query('SELECT count(*)::int n FROM content_design_operations')).rows[0].n;
  const oversized = intent(`data:image/png;base64,${'A'.repeat(5 * 1024 * 1024)}`);
  const response = await ctx.call('POST', API, oversized);
  assert.equal(response.status, 413);
  assert.match(response.contentType || '', /^application\/json/);
  assert.equal(response.json?.code, 'CONTENT_DESIGN_TOO_LARGE');
  assert.match(response.json?.error || '', /4 MB/);
  assert.equal(ctx.db.calls, before, 'el parser debe rechazar antes de consultar PG');
  assert.equal((await ctx.pool.query('SELECT count(*)::int n FROM content_design_projects')).rows[0].n, projectsBefore);
  assert.equal((await ctx.pool.query('SELECT count(*)::int n FROM content_design_operations')).rows[0].n, operationsBefore);
});
