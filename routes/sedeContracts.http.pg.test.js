import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import express from 'express';
import { createServer } from 'node:http';
import { once } from 'node:events';
import pg from 'pg';
import { mountSedeContractsRoutes } from './sedeContracts.js';
import { CONTRACT_PRIVATE_BUCKET } from '../lib/sedeContracts.js';
import { createSedeContractPrivateStorage } from '../lib/sedeContractPrivateStorage.js';

// Aceptación HTTP real (Express + FormData) -> handler real -> PostgreSQL 17
// propio por Unix socket, con las 7 columnas efectivas de contratos_sedes y la
// forma real de user_roles (13 columnas, user_id UUID no único). El candidato
// SQL sólo se aplica en el caso de archivo. El SDK de storage es un boundary
// simulado en memoria: ningún bucket/red/proveedor real.
const PG_BIN = '/opt/homebrew/bin';
const PG_PORT = 55487;
const ACTOR_A = '11111111-1111-4111-8111-111111111111';
const ACTOR_B = '22222222-2222-4222-8222-222222222222';
const ACTOR_C = '33333333-3333-4333-8333-333333333333';
const UUID_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const UUID_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const UUID_C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const PDF = Buffer.from('%PDF-1.7\ncontrato fixture 053\n%%EOF\n');
const PDF_ALT = Buffer.from('%PDF-1.7\ncontrato fixture 053 distinto\n%%EOF\n');
const PRIVATE_CANDIDATE = new URL('../sql/candidates/20261124_sede_contract_private_storage_candidate.sql', import.meta.url);

const BASE_SCHEMA_SQL = `
create table public.sedes(id bigint primary key, nombre text not null);
create table public.user_roles(
  id bigint not null,
  user_id uuid,
  role text not null,
  pais text,
  sede_id bigint,
  created_at timestamp without time zone default now(),
  email text,
  nombre text,
  torneos_oficiales_habilitados boolean default false,
  alcance text default 'sede',
  ciudad text,
  provincia text,
  organizacion_id uuid
);
create table public.contratos_sedes(
  id uuid primary key default gen_random_uuid(),
  sede_id integer,
  fecha_inicio date not null,
  fecha_vencimiento date,
  referencia text,
  archivo_url text,
  created_at timestamp with time zone default now(),
  constraint contratos_sedes_sede_id_fkey foreign key (sede_id)
    references public.sedes(id) on delete cascade
);
insert into public.sedes(id, nombre) values
  (501, 'Sede Fixture 501'), (502, 'Sede Fixture 502');
insert into public.user_roles(id, user_id, role, alcance, sede_id, email) values
  (1, '${ACTOR_A}', 'super_admin', 'global', null, 'super@fixture.invalid'),
  (2, '${ACTOR_B}', 'admin_club', 'sede', 501, 'club@fixture.invalid'),
  (3, '${ACTOR_C}', 'super_admin', 'global', null, 'other@fixture.invalid');
`;

const STORAGE_SCHEMA_SQL = `
create schema storage;
create table storage.buckets(
  id text primary key,
  name text,
  public boolean,
  file_size_limit bigint,
  allowed_mime_types text[]
);
create table storage.objects(id uuid primary key default gen_random_uuid(), bucket_id text, name text);
alter table storage.objects enable row level security;
`;

let cluster = null;
let pool = null;

function pgBin(name) {
  const binary = path.join(PG_BIN, name);
  if (!fs.existsSync(binary)) throw new Error(`Binario PostgreSQL requerido no encontrado: ${binary}`);
  return binary;
}

before(async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'contrato053-pg17-'));
  const dataDir = path.join(tempDir, 'data');
  const sockDir = path.join(tempDir, 'sock');
  fs.mkdirSync(sockDir);
  const env = { ...process.env, LC_ALL: 'C', PATH: `${PG_BIN}:${process.env.PATH}` };
  const run = (binary, args) => execFileSync(binary, args, { stdio: 'ignore', env, timeout: 60000 });
  cluster = { tempDir, dataDir, sockDir, running: false, pid: null };
  run(pgBin('initdb'), ['-D', dataDir, '-U', 'postgres', '-A', 'trust', '--no-locale', '-E', 'UTF8']);
  run(pgBin('pg_ctl'), [
    '-D', dataDir,
    '-l', path.join(tempDir, 'pg.log'),
    '-o', `-F -h '' -k ${sockDir} -p ${PG_PORT}`,
    '-w', 'start',
  ]);
  cluster.running = true;
  cluster.pid = Number(fs.readFileSync(path.join(dataDir, 'postmaster.pid'), 'utf8').split('\n')[0]);
  pool = new pg.Pool({
    host: sockDir,
    port: PG_PORT,
    user: 'postgres',
    database: 'postgres',
    max: 10,
    connectionTimeoutMillis: 3000,
    query_timeout: 15000,
  });
  assert.equal((await pool.query('show listen_addresses')).rows[0].listen_addresses, '', 'el cluster debe escuchar sólo por Unix socket');
  assert.equal((await pool.query('show server_version_num')).rows[0].server_version_num.slice(0, 2), '17');
  await pool.query('create role anon nologin; create role authenticated nologin; create role service_role nologin;');
});

after(async () => {
  if (pool) {
    await pool.end();
    pool = null;
  }
  if (cluster?.running) {
    const out = execFileSync(pgBin('pg_ctl'), ['-D', cluster.dataDir, '-m', 'immediate', '-w', 'stop'], {
      encoding: 'utf8',
      env: { ...process.env, LC_ALL: 'C' },
    });
    cluster.running = false;
    if (fs.existsSync(path.join(cluster.dataDir, 'postmaster.pid'))) throw new Error('postmaster.pid del cluster propio sigue existiendo');
    if (fs.existsSync(path.join(cluster.sockDir, `.s.PGSQL.${PG_PORT}`))) throw new Error('socket del cluster propio sigue existiendo');
    try {
      process.kill(cluster.pid, 0);
      throw new Error('postmaster del cluster propio sigue vivo');
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
    fs.rmSync(cluster.tempDir, { recursive: true, force: true });
    console.log('FIXTURE_CLEANUP_OK', JSON.stringify({ owner: 'contrato053', pg_ctl: out.trim(), pid: cluster.pid, socket_removed: true }));
  }
});

async function reset({ withFileCapability = false } = {}) {
  const candidateSql = fs.readFileSync(PRIVATE_CANDIDATE, 'utf8');
  await pool.query('drop schema if exists public cascade; drop schema if exists storage cascade; create schema public;');
  await pool.query(BASE_SCHEMA_SQL);
  if (withFileCapability) {
    await pool.query(STORAGE_SCHEMA_SQL);
    await pool.query(candidateSql);
  }
}

function makeStorage({ publicBucket = false } = {}) {
  const objects = new Map();
  const calls = [];
  let failNext = false;
  return {
    objects,
    calls,
    failNextUpload() { failNext = true; },
    async getBucket(name) {
      calls.push({ op: 'getBucket', name });
      if (name !== CONTRACT_PRIVATE_BUCKET) return { data: null, error: { message: 'not found' } };
      return { data: { id: name, name, public: publicBucket }, error: null };
    },
    from(bucket) {
      if (bucket !== CONTRACT_PRIVATE_BUCKET) throw new Error(`Bucket no autorizado: ${bucket}`);
      return {
        async upload(objectPath, buffer, options = {}) {
          calls.push({ op: 'upload', bucket, path: objectPath, contentType: options.contentType, upsert: options.upsert, size: buffer.length });
          if (failNext) {
            failNext = false;
            return { data: null, error: { statusCode: '500', message: 'Fixture storage no disponible' } };
          }
          if (objects.has(objectPath)) {
            return { data: null, error: { statusCode: '409', message: 'The resource already exists' } };
          }
          objects.set(objectPath, { buffer: Buffer.from(buffer), contentType: options.contentType });
          return { data: { path: objectPath }, error: null };
        },
        async remove(paths) {
          calls.push({ op: 'remove', paths });
          throw new Error('El adaptador de contratos no debe borrar objetos');
        },
        async createSignedUrl(objectPath) {
          calls.push({ op: 'createSignedUrl', path: objectPath });
          throw new Error('El adaptador de contratos no debe emitir URLs');
        },
      };
    },
  };
}

// Sólo lecturas PostgREST equivalentes a las que usa el handler (rol actual y
// existencia de sede). Insert/RPC por REST están prohibidos: la metadata debe
// resolverse en la transacción PG con FOR SHARE.
function makeSupabase() {
  function from(table) {
    if (!['user_roles', 'sedes'].includes(table)) throw new Error(`Tabla REST no esperada: ${table}`);
    let columns = '*';
    let single = false;
    let limitN = null;
    const filters = [];
    const q = {
      select(value = '*') { columns = value; return q; },
      eq(column, value) { filters.push([column, value]); return q; },
      limit(value) { limitN = value; return q; },
      maybeSingle() { single = true; return q.run(); },
      single() { single = true; return q.run(); },
      insert() { throw new Error('REST insert no permitido: la metadata debe ir por transacción PG'); },
      then(resolve, reject) { return q.run().then(resolve, reject); },
      async run() {
        try {
          const params = [];
          const where = filters.map(([column, value]) => {
            params.push(value);
            return `${column} = $${params.length}`;
          }).join(' and ');
          const sql = `select ${columns} from public.${table}`
            + (where ? ` where ${where}` : '')
            + (limitN != null ? ` limit ${Number(limitN)}` : '');
          const result = await pool.query(sql, params);
          return { data: single ? (result.rows[0] ?? null) : result.rows, error: null };
        } catch (error) {
          return { data: null, error };
        }
      },
    };
    return q;
  }
  return { from, rpc() { throw new Error('RPC REST no permitido: la metadata debe ir por transacción PG'); } };
}

async function startHarness({ withFileCapability = false, adapterEnabled = false, storage = makeStorage() } = {}) {
  await reset({ withFileCapability });
  const app = express();
  const users = new Map([
    ['token-a', { id: ACTOR_A, email: 'super@fixture.invalid' }],
    ['token-b', { id: ACTOR_B, email: 'club@fixture.invalid' }],
    ['token-c', { id: ACTOR_C, email: 'other@fixture.invalid' }],
  ]);
  const authUserFromBearer = async (req) => {
    const match = /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization || ''));
    return match ? (users.get(match[1].trim()) || null) : null;
  };
  const supabaseAdmin = makeSupabase();
  const privateStorage = adapterEnabled
    ? createSedeContractPrivateStorage({ supabaseAdmin: { storage }, enabled: true })
    : null;
  mountSedeContractsRoutes(app, {
    supabaseAdmin,
    pgPool: pool,
    authUserFromBearer,
    privateStorage,
  });
  const server = createServer(app);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    storage,
    close: async () => {
      await new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections?.();
      });
    },
  };
}

async function postContract(base, {
  sedeId = 501,
  token = 'token-a',
  uuid = UUID_A,
  inicio = '2026-11-24',
  vencimiento = '2027-11-24',
  referencia = 'REF-053',
  file = null,
  extraUuid = null,
  omit = [],
} = {}) {
  const form = new FormData();
  if (!omit.includes('fecha_inicio')) form.append('fecha_inicio', inicio);
  if (!omit.includes('fecha_vencimiento') && vencimiento != null) form.append('fecha_vencimiento', vencimiento);
  if (!omit.includes('referencia') && referencia != null) form.append('referencia', referencia);
  if (!omit.includes('contrato_uuid') && uuid != null) form.append('contrato_uuid', uuid);
  if (extraUuid) form.append('contrato_uuid', extraUuid);
  if (file) form.append('archivo', new Blob([file.buffer], { type: file.type }), file.name);
  const response = await fetch(`${base}/api/sedes/${sedeId}/contrato`, {
    method: 'POST',
    headers: token ? { authorization: `Bearer ${token}` } : {},
    body: form,
  });
  return { status: response.status, body: await response.json() };
}

async function countContracts() {
  const result = await pool.query('select count(*)::int as n from public.contratos_sedes');
  return result.rows[0].n;
}

async function contractRows() {
  return (await pool.query('select * from public.contratos_sedes order by created_at, id')).rows;
}

async function setRole(userId, role) {
  await pool.query('update public.user_roles set role = $1 where user_id = $2', [role, userId]);
}

async function waitForLockedContractTransaction(excludedPid, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { rows } = await pool.query(`
      select pid, wait_event_type, wait_event, query
        from pg_stat_activity
       where datname = current_database()
         and pid <> pg_backend_pid()
         and wait_event_type = 'Lock'
         and position('for share' in lower(query)) > 0
    `);
    const row = rows.find((candidate) => Number(candidate.pid) !== Number(excludedPid));
    if (row) {
      return {
        pid: Number(row.pid),
        waitEventType: row.wait_event_type,
        waitEvent: row.wait_event,
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('No se observó un lock wait real de PostgreSQL en la transacción de contrato');
}

test('metadata-only con 7 columnas reales: alta, replay, 409 y sin dedupe por referencia', async () => {
  const harness = await startHarness();
  try {
    const first = await postContract(harness.base, { referencia: 'REF-053' });
    assert.equal(first.status, 201);
    assert.equal(first.body.ok, true);
    assert.equal(first.body.contrato.id, UUID_A);
    assert.equal(first.body.contrato.sede_id, 501);
    assert.equal(first.body.contrato.fecha_inicio, '2026-11-24');
    assert.equal(first.body.contrato.fecha_vencimiento, '2027-11-24');
    assert.equal(first.body.contrato.referencia, 'REF-053');
    assert.equal(first.body.contrato.archivo, null);
    assert.equal(first.body.replayed, false);

    const columns = (await pool.query(`
      select column_name from information_schema.columns
       where table_schema = 'public' and table_name = 'contratos_sedes'
       order by ordinal_position
    `)).rows.map((row) => row.column_name);
    assert.deepEqual(columns, ['id', 'sede_id', 'fecha_inicio', 'fecha_vencimiento', 'referencia', 'archivo_url', 'created_at']);

    const stored = (await contractRows())[0];
    assert.equal(stored.id, UUID_A);
    assert.equal(stored.archivo_url, null);
    assert.equal(stored.storage_path, undefined);

    const replay = await postContract(harness.base);
    assert.equal(replay.status, 200);
    assert.equal(replay.body.replayed, true);
    assert.equal(replay.body.contrato.id, UUID_A);
    assert.equal(await countContracts(), 1);

    const conflict = await postContract(harness.base, { referencia: 'REF-DISTINTA' });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.code, 'contrato_payload_conflict');
    assert.equal(await countContracts(), 1);

    const changedDate = await postContract(harness.base, { inicio: '2026-11-25' });
    assert.equal(changedDate.status, 409);
    assert.equal(await countContracts(), 1);

    const foreignSede = await postContract(harness.base, { sedeId: 502, uuid: UUID_A });
    assert.equal(foreignSede.status, 409);
    assert.equal(await countContracts(), 1);

    const differentContract = await postContract(harness.base, { uuid: UUID_B, referencia: 'REF-053' });
    assert.equal(differentContract.status, 201, 'la misma fecha/referencia con otro UUID es otro contrato legítimo');
    assert.equal(await countContracts(), 2);

    const generated = await postContract(harness.base, { uuid: null, omit: ['contrato_uuid'], referencia: 'SIN-UUID' });
    assert.equal(generated.status, 201);
    assert.match(generated.body.contrato.id, /^[0-9a-f-]{36}$/);
    assert.equal(await countContracts(), 3);
  } finally {
    await harness.close();
  }
});

test('401/403/404, revocación persistida y segunda fila de rol no autorizan', async () => {
  const harness = await startHarness();
  try {
    assert.equal((await postContract(harness.base, { token: null })).status, 401);
    assert.equal((await postContract(harness.base, { token: 'token-inventado' })).status, 401);
    const nonSuper = await postContract(harness.base, { token: 'token-b' });
    assert.equal(nonSuper.status, 403);
    assert.equal(nonSuper.body.code, 'forbidden');

    const missingSede = await postContract(harness.base, { sedeId: 9999 });
    assert.equal(missingSede.status, 404);
    assert.equal(missingSede.body.code, 'sede_no_encontrada');

    assert.equal((await postContract(harness.base, { sedeId: '0' })).status, 400);
    assert.equal((await postContract(harness.base, { sedeId: '99999999999999999' })).status, 400);
    assert.equal((await postContract(harness.base, { inicio: '2026-02-31' })).body.code, 'fecha_inicio_invalida');
    assert.equal((await postContract(harness.base, { vencimiento: '2026-01-01' })).body.code, 'fecha_vencimiento_invalida');
    assert.equal((await postContract(harness.base, { referencia: 'x'.repeat(241) })).status, 400);
    const duplicatedUuid = await postContract(harness.base, { extraUuid: UUID_B });
    assert.equal(duplicatedUuid.status, 400);
    assert.equal(duplicatedUuid.body.code, 'contrato_uuid_invalido');
    assert.equal(await countContracts(), 0);

    await setRole(ACTOR_A, 'admin_club');
    const revoked = await postContract(harness.base);
    assert.equal(revoked.status, 403);
    assert.equal(revoked.body.code, 'forbidden');
    assert.equal(await countContracts(), 0, 'rol revocado antes de la transacción no escribe');

    // Dos filas para el mismo actor UUID son ambiguas: el OR de roles no se
    // ensancha ni se acepta "alguna fila super_admin".
    await setRole(ACTOR_A, 'super_admin');
    await pool.query(
      `insert into public.user_roles(id, user_id, role, alcance, sede_id, email)
       values (50, $1, 'admin_club', 'sede', 501, 'extra@fixture.invalid')`,
      [ACTOR_A],
    );
    const ambiguous = await postContract(harness.base, { uuid: UUID_B });
    assert.equal(ambiguous.status, 403);
    assert.equal(ambiguous.body.code, 'forbidden');
    assert.equal(await countContracts(), 0);
    await pool.query('delete from public.user_roles where id = 50');

    const restored = await postContract(harness.base, { uuid: UUID_B });
    assert.equal(restored.status, 201);
    assert.equal(await countContracts(), 1);
  } finally {
    await harness.close();
  }
});

test('archivo: rechazo pre-write, capability ausente y flag OFF fallan cerrado', async () => {
  const sinAdapter = makeStorage();
  const noCapability = await startHarness({ storage: sinAdapter });
  try {
    const wrongMime = await postContract(noCapability.base, {
      file: { buffer: PDF, name: 'contrato.pdf', type: 'image/jpeg' },
    });
    assert.equal(wrongMime.status, 400);
    assert.equal(wrongMime.body.code, 'archivo_mime_invalido');

    const wrongMagic = await postContract(noCapability.base, {
      file: { buffer: Buffer.from('esto no es un contrato'), name: 'contrato.pdf', type: 'application/pdf' },
    });
    assert.equal(wrongMagic.status, 400);
    assert.equal(wrongMagic.body.code, 'archivo_invalido');

    const nullAdapter = await postContract(noCapability.base, {
      uuid: UUID_C,
      file: { buffer: PDF, name: 'contrato.pdf', type: 'application/pdf' },
    });
    assert.equal(nullAdapter.status, 503);
    assert.equal(nullAdapter.body.code, 'contrato_storage_unavailable');
    assert.equal(await countContracts(), 0);
    assert.equal(sinAdapter.calls.length, 0, 'flag OFF no toca el SDK de storage');

    // Aun con una fila metadata-only preexistente, un archivo con flag OFF no
    // puede devolver un replay que simule un archivo guardado.
    assert.equal((await postContract(noCapability.base)).status, 201);
    const replayWithFileOff = await postContract(noCapability.base, {
      file: { buffer: PDF, name: 'contrato.pdf', type: 'application/pdf' },
    });
    assert.equal(replayWithFileOff.status, 503);
    assert.equal(replayWithFileOff.body.code, 'contrato_storage_unavailable');
    assert.equal(await countContracts(), 1);
    assert.equal(sinAdapter.calls.length, 0);
  } finally {
    await noCapability.close();
  }

  const conAdapter = makeStorage();
  const base7 = await startHarness({ adapterEnabled: true, storage: conAdapter });
  try {
    const missingColumn = await postContract(base7.base, {
      uuid: UUID_C,
      file: { buffer: PDF, name: 'contrato.pdf', type: 'application/pdf' },
    });
    assert.equal(missingColumn.status, 503);
    assert.equal(missingColumn.body.code, 'contrato_storage_metadata_unavailable');
    assert.equal(await countContracts(), 0);
    assert.equal(conAdapter.calls.length, 0, 'sin columna candidata no se sube nada');

    assert.equal((await postContract(base7.base)).status, 201);
    const existingWithFile = await postContract(base7.base, {
      file: { buffer: PDF, name: 'contrato.pdf', type: 'application/pdf' },
    });
    assert.equal(existingWithFile.status, 503);
    assert.equal(existingWithFile.body.code, 'contrato_storage_metadata_unavailable');
    assert.equal(await countContracts(), 1);
    assert.equal(conAdapter.calls.length, 0, 'sin columna candidata tampoco hay replay con archivo');
  } finally {
    await base7.close();
  }
});

test('archivo privado con candidato aplicado y SDK simulado: path, replay, 409, sin borrado ni URL', async () => {
  const storage = makeStorage();
  const harness = await startHarness({ withFileCapability: true, adapterEnabled: true, storage });
  try {
    const sha = crypto.createHash('sha256').update(PDF).digest('hex');
    const expectedPath = `501/${UUID_A}/${sha}.pdf`;
    const first = await postContract(harness.base, {
      file: { buffer: PDF, name: '../../cliente.pdf', type: 'application/pdf' },
    });
    assert.equal(first.status, 201);
    assert.equal(first.body.contrato.archivo.bucket, CONTRACT_PRIVATE_BUCKET);
    assert.equal(first.body.contrato.archivo.path, expectedPath);
    assert.equal(first.body.contrato.archivo.sha256, sha);
    assert.equal(first.body.contrato.archivo.mime, 'application/pdf');
    assert.equal(first.body.contrato.archivo.size, PDF.length);

    const stored = (await contractRows())[0];
    assert.equal(stored.storage_path, expectedPath);
    assert.equal(stored.archivo_url, null, 'nunca se publica una URL pública para el archivo privado');
    assert.equal(storage.objects.size, 1);
    assert.equal(storage.calls.filter((call) => call.op === 'upload').length, 1);
    assert.equal(storage.calls.filter((call) => call.op === 'upload')[0].upsert, false);
    assert.equal(storage.calls.filter((call) => call.op === 'getBucket').length, 1);
    assert.equal(storage.calls.filter((call) => call.op === 'createSignedUrl').length, 0);
    assert.equal(storage.calls.filter((call) => call.op === 'remove').length, 0);

    const bucket = (await pool.query('select public from storage.buckets where id = $1', [CONTRACT_PRIVATE_BUCKET])).rows[0];
    assert.deepEqual(bucket, { public: false });
    const policy = (await pool.query(
      "select policyname from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'contratos_sedes_privados_browser_deny'",
    )).rows[0];
    assert.ok(policy, 'el candidato aplicado crea la deny policy restrictiva');

    const replay = await postContract(harness.base, {
      file: { buffer: PDF, name: 'otro-nombre.pdf', type: 'application/pdf' },
    });
    assert.equal(replay.status, 200);
    assert.equal(replay.body.replayed, true);
    assert.equal(replay.body.contrato.archivo.path, expectedPath);
    assert.equal(await countContracts(), 1);
    assert.equal(storage.calls.filter((call) => call.op === 'upload').length, 1, 'el replay no vuelve a subir');

    const differentFile = await postContract(harness.base, {
      file: { buffer: PDF_ALT, name: 'contrato.pdf', type: 'application/pdf' },
    });
    assert.equal(differentFile.status, 409);
    assert.equal(differentFile.body.code, 'contrato_payload_conflict');
    assert.equal(await countContracts(), 1);
    assert.equal(storage.objects.size, 1);
    assert.equal(storage.calls.filter((call) => call.op === 'upload').length, 1, 'payload distinto no sobrescribe el archivo');

    const differentMetadata = await postContract(harness.base, {
      referencia: 'REF-CONFLICTO',
      file: { buffer: PDF, name: 'contrato.pdf', type: 'application/pdf' },
    });
    assert.equal(differentMetadata.status, 409);
    assert.equal(await countContracts(), 1);

    const missingFileOnExisting = await postContract(harness.base);
    assert.equal(missingFileOnExisting.status, 409, 'no se puede descartar silenciosamente el archivo ya guardado');
    assert.equal(storage.calls.filter((call) => call.op === 'remove').length, 0);
  } finally {
    await harness.close();
  }
});

test('revocación compite con el lock del rol: 2 PIDs reales, lock wait observado y 403 sin insert', async () => {
  const harness = await startHarness();
  const revoke = await pool.connect();
  let pending = null;
  try {
    const revocationPid = Number((await revoke.query('select pg_backend_pid() as pid')).rows[0].pid);
    await revoke.query('begin');
    await revoke.query("update public.user_roles set role = 'admin_club' where user_id = $1", [ACTOR_A]);

    pending = postContract(harness.base, { uuid: UUID_A, referencia: 'REF-RACE' });
    const observed = await waitForLockedContractTransaction(revocationPid);
    assert.equal(observed.waitEventType, 'Lock');
    assert.equal(Number.isInteger(observed.pid), true);
    assert.notEqual(observed.pid, revocationPid, 'el lock wait debe observarse en otra sesión PG');

    await revoke.query('commit');
    const revoked = await pending;
    pending = null;
    assert.equal(revoked.status, 403);
    assert.equal(revoked.body.code, 'forbidden');
    assert.equal(await countContracts(), 0, 'la revocación que gana el lock no permite insertar metadata');
    console.log('REVOCATION_RACE_OBSERVED', JSON.stringify({
      revocation_pid: revocationPid,
      contract_pid: observed.pid,
      wait_event_type: observed.waitEventType,
      wait_event: observed.waitEvent,
      status: revoked.status,
      rows: await countContracts(),
    }));

    await revoke.query("update public.user_roles set role = 'super_admin' where user_id = $1", [ACTOR_A]);
    const retry = await postContract(harness.base, { uuid: UUID_A, referencia: 'REF-RACE' });
    assert.equal(retry.status, 201);
    assert.equal(await countContracts(), 1);
  } finally {
    if (pending) {
      await revoke.query('rollback').catch(() => {});
      await pending.catch(() => {});
    }
    revoke.release();
    await harness.close();
  }
});

test('misma UUID en paralelo: una fila; payload distinto concurrente: 409', async () => {
  const harness = await startHarness();
  try {
    const [first, second] = await Promise.all([
      postContract(harness.base, { uuid: UUID_A, referencia: 'REF-CONCURRENTE' }),
      postContract(harness.base, { uuid: UUID_A, referencia: 'REF-CONCURRENTE' }),
    ]);
    assert.deepEqual([first.status, second.status].sort(), [200, 201]);
    assert.equal(first.body.contrato.id, UUID_A);
    assert.equal(second.body.contrato.id, UUID_A);
    assert.equal([first.body.replayed, second.body.replayed].filter(Boolean).length, 1);
    assert.equal(await countContracts(), 1, 'la PK UUID garantiza una sola fila');

    const [left, right] = await Promise.all([
      postContract(harness.base, { uuid: UUID_B, referencia: 'REF-IZQUIERDA' }),
      postContract(harness.base, { uuid: UUID_B, referencia: 'REF-DERECHA' }),
    ]);
    assert.deepEqual([left.status, right.status].sort(), [201, 409]);
    const winner = left.status === 201 ? left : right;
    const loser = left.status === 409 ? left : right;
    assert.equal(loser.body.code, 'contrato_payload_conflict');
    assert.ok(['REF-IZQUIERDA', 'REF-DERECHA'].includes(winner.body.contrato.referencia));
    assert.equal(await countContracts(), 2);
    const rows = await contractRows();
    assert.equal(rows.find((row) => row.id === UUID_B).referencia, winner.body.contrato.referencia);
  } finally {
    await harness.close();
  }
});

test('fallo de metadata hace rollback y el mismo UUID puede reintentar', async () => {
  const harness = await startHarness();
  try {
    await pool.query(`
      create function public.reject_contract_insert() returns trigger language plpgsql as $$
      begin raise exception 'QA_CONTRACT_METADATA_FAILURE'; end $$;
      create trigger reject_contract_insert before insert on public.contratos_sedes
        for each row execute function public.reject_contract_insert();
    `);
    const failed = await postContract(harness.base, { uuid: UUID_C });
    assert.equal(failed.status, 500);
    assert.equal(failed.body.code, 'contrato_no_guardado');
    assert.equal(await countContracts(), 0, 'el trigger de fallo no deja fila parcial');

    await pool.query('drop trigger reject_contract_insert on public.contratos_sedes; drop function public.reject_contract_insert();');
    const retry = await postContract(harness.base, { uuid: UUID_C });
    assert.equal(retry.status, 201);
    assert.equal(await countContracts(), 1);
  } finally {
    await harness.close();
  }
});
