import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import express from 'express';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { PGlite } from '@electric-sql/pglite';
import { mountSedeContractsRoutes } from './sedeContracts.js';
import { CONTRACT_PRIVATE_BUCKET } from '../lib/sedeContracts.js';

// HTTP real (Express + FormData) -> handler real -> PostgreSQL propio (PGlite)
// con las 7 columnas efectivas de contratos_sedes. El SDK de storage es un
// boundary simulado en memoria: ningún bucket/red/proveedor real.
const UUID_A = '11111111-1111-4111-8111-111111111111';
const UUID_B = '22222222-2222-4222-8222-222222222222';
const UUID_C = '33333333-3333-4333-8333-333333333333';
const PDF = Buffer.from('%PDF-1.7\ncontrato fixture 053\n%%EOF\n');
const PDF_ALT = Buffer.from('%PDF-1.7\ncontrato fixture 053 distinto\n%%EOF\n');
const PRIVATE_STORAGE = { bucket: CONTRACT_PRIVATE_BUCKET, column: 'storage_path' };

const COLUMNS = {
  user_roles: ['id', 'user_id', 'email', 'role', 'alcance', 'sede_id'],
  sedes: ['id', 'nombre'],
  contratos_sedes: ['id', 'sede_id', 'fecha_inicio', 'fecha_vencimiento', 'referencia', 'archivo_url', 'created_at', 'storage_path'],
};

class Query {
  constructor(pg, table) {
    this.pg = pg;
    this.table = table;
    this.columns = '*';
    this.filters = [];
    this.limitN = null;
    this.singleRow = false;
    this.mode = 'select';
    this.rows = [];
  }

  select(columns = '*') {
    this.columns = columns;
    return this;
  }

  eq(column, value) {
    if (!COLUMNS[this.table]?.includes(column)) throw new Error(`Columna no soportada: ${column}`);
    this.filters.push([column, value]);
    return this;
  }

  limit(n) {
    this.limitN = n;
    return this;
  }

  maybeSingle() {
    this.singleRow = true;
    return this;
  }

  single() {
    this.singleRow = true;
    return this;
  }

  insert(row) {
    this.mode = 'insert';
    this.rows = Array.isArray(row) ? row : [row];
    return this;
  }

  then(resolve, reject) {
    return this.run().then(resolve, reject);
  }

  async run() {
    try {
      if (this.mode === 'insert') {
        const output = [];
        for (const row of this.rows) {
          const keys = Object.keys(row);
          for (const key of keys) {
            if (!COLUMNS[this.table]?.includes(key)) throw new Error(`Columna no soportada: ${key}`);
          }
          const sql = `insert into public.${this.table} (${keys.join(',')}) values (${keys.map((_, i) => `$${i + 1}`).join(',')}) returning *`;
          const result = await this.pg.query(sql, keys.map((key) => row[key]));
          output.push(result.rows[0]);
        }
        return { data: this.singleRow ? (output[0] ?? null) : output, error: null };
      }
      const selected = this.columns === '*'
        ? '*'
        : this.columns.split(',').map((column) => String(column).trim()).filter(Boolean).join(', ');
      const params = [];
      const where = this.filters.map(([column, value]) => {
        params.push(value);
        return `${column} = $${params.length}`;
      }).join(' and ');
      const sql = `select ${selected} from public.${this.table}`
        + (where ? ` where ${where}` : '')
        + (this.limitN != null ? ` limit ${Number(this.limitN)}` : '');
      const result = await this.pg.query(sql, params);
      return { data: this.singleRow ? (result.rows[0] ?? null) : result.rows, error: null };
    } catch (error) {
      return { data: null, error: { code: error.code || null, message: error.message || String(error) } };
    }
  }
}

function makeSupabase(pg) {
  return {
    from(table) {
      if (!COLUMNS[table]) throw new Error(`Tabla no soportada: ${table}`);
      return new Query(pg, table);
    },
  };
}

function makeStorage() {
  const objects = new Map();
  const calls = [];
  let onUpload = null;
  let failNextUpload = false;
  return {
    objects,
    calls,
    onUpload(fn) { onUpload = fn; },
    failNextUpload() { failNextUpload = true; },
    from(bucket) {
      if (bucket !== CONTRACT_PRIVATE_BUCKET) throw new Error(`Bucket no autorizado: ${bucket}`);
      return {
        async upload(path, buffer, options = {}) {
          calls.push({ op: 'upload', bucket, path, contentType: options.contentType, size: buffer.length, upsert: options.upsert });
          if (onUpload) await onUpload({ path, buffer });
          if (failNextUpload) {
            failNextUpload = false;
            return { data: null, error: { statusCode: '500', message: 'Fixture storage no disponible' } };
          }
          if (objects.has(path)) {
            return { data: null, error: { statusCode: '409', message: 'The resource already exists' } };
          }
          objects.set(path, { buffer: Buffer.from(buffer), contentType: options.contentType });
          return { data: { path }, error: null };
        },
        async remove(paths) {
          calls.push({ op: 'remove', paths });
          for (const path of paths) objects.delete(path);
          return { data: [], error: null };
        },
        async createSignedUrl(path) {
          calls.push({ op: 'createSignedUrl', path });
          return { data: { signedUrl: `https://private.invalid/${path}` }, error: null };
        },
      };
    },
  };
}

async function createFixture({ withStorageColumn = false } = {}) {
  const pg = new PGlite();
  await pg.exec(`
    create table public.sedes(id bigint primary key, nombre text not null);
    create table public.user_roles(
      id serial primary key, user_id text unique not null, email text,
      role text not null, alcance text, sede_id bigint
    );
    create table public.contratos_sedes(
      id uuid primary key default gen_random_uuid(),
      sede_id integer,
      fecha_inicio date not null,
      fecha_vencimiento date,
      referencia text,
      archivo_url text,
      created_at timestamptz default now(),
      constraint contratos_sedes_sede_id_fkey foreign key (sede_id)
        references public.sedes(id) on delete cascade
    );
    insert into public.sedes(id, nombre) values
      (501, 'Sede Fixture 501'), (502, 'Sede Fixture 502');
    insert into public.user_roles(user_id, email, role, alcance, sede_id) values
      ('actor-a', 'super@fixture.invalid', 'super_admin', 'global', null),
      ('actor-b', 'club@fixture.invalid', 'admin_club', 'sede', 501),
      ('actor-c', 'other-super@fixture.invalid', 'super_admin', 'global', null);
  `);
  if (withStorageColumn) {
    await pg.exec('alter table public.contratos_sedes add column storage_path text;');
  }
  return { pg, sb: makeSupabase(pg) };
}

async function startHarness({ withStorageColumn = false, privateStorage = null, storage = makeStorage() } = {}) {
  const fixture = await createFixture({ withStorageColumn });
  fixture.sb.storage = storage;
  const app = express();
  const users = new Map([
    ['token-a', { id: 'actor-a', email: 'super@fixture.invalid' }],
    ['token-b', { id: 'actor-b', email: 'club@fixture.invalid' }],
    ['token-c', { id: 'actor-c', email: 'other-super@fixture.invalid' }],
  ]);
  const authUserFromBearer = async (req) => {
    const match = /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization || ''));
    return match ? (users.get(match[1].trim()) || null) : null;
  };
  mountSedeContractsRoutes(app, {
    supabaseAdmin: fixture.sb,
    authUserFromBearer,
    privateStorage,
  });
  const server = createServer(app);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    pg: fixture.pg,
    storage,
    close: async () => {
      await new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections?.();
      });
      await fixture.pg.close();
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
  if (file) {
    form.append('archivo', new Blob([file.buffer], { type: file.type }), file.name);
  }
  const response = await fetch(`${base}/api/sedes/${sedeId}/contrato`, {
    method: 'POST',
    headers: token ? { authorization: `Bearer ${token}` } : {},
    body: form,
  });
  return { status: response.status, body: await response.json() };
}

async function countContracts(pg) {
  const result = await pg.query('select count(*)::int as n from public.contratos_sedes');
  return result.rows[0].n;
}

async function setRole(pg, userId, role) {
  await pg.query('update public.user_roles set role = $1 where user_id = $2', [role, userId]);
}

test('metadata-only: 7 columnas reales, replay por UUID, 409 en payload distinto y sin dedupe por referencia', async () => {
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

    const columns = await harness.pg.query(`
      select column_name from information_schema.columns
      where table_schema = 'public' and table_name = 'contratos_sedes'
      order by ordinal_position
    `);
    assert.deepEqual(columns.rows.map((row) => row.column_name), [
      'id', 'sede_id', 'fecha_inicio', 'fecha_vencimiento', 'referencia', 'archivo_url', 'created_at',
    ]);
    const stored = (await harness.pg.query('select * from public.contratos_sedes')).rows[0];
    assert.equal(stored.id, UUID_A);
    assert.equal(stored.archivo_url, null);
    assert.equal(stored.storage_path, undefined);

    const replay = await postContract(harness.base);
    assert.equal(replay.status, 200);
    assert.equal(replay.body.replayed, true);
    assert.equal(replay.body.contrato.id, UUID_A);
    assert.equal(await countContracts(harness.pg), 1);

    const conflict = await postContract(harness.base, { referencia: 'REF-DISTINTA' });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.code, 'contrato_payload_conflict');
    assert.equal(await countContracts(harness.pg), 1);

    const changedDate = await postContract(harness.base, { inicio: '2026-11-25' });
    assert.equal(changedDate.status, 409);
    assert.equal(await countContracts(harness.pg), 1);

    const foreignSede = await postContract(harness.base, { sedeId: 502, uuid: UUID_A });
    assert.equal(foreignSede.status, 409);
    assert.equal(await countContracts(harness.pg), 1);

    const differentContract = await postContract(harness.base, { uuid: UUID_B, referencia: 'REF-053' });
    assert.equal(differentContract.status, 201, 'la misma fecha/referencia con otro UUID es otro contrato legítimo');
    assert.equal(await countContracts(harness.pg), 2);

    const generated = await postContract(harness.base, { uuid: null, omit: ['contrato_uuid'], referencia: 'SIN-UUID' });
    assert.equal(generated.status, 201);
    assert.match(generated.body.contrato.id, /^[0-9a-f-]{36}$/);
    assert.equal(await countContracts(harness.pg), 3);
  } finally {
    await harness.close();
  }
});

test('401/403/404 y rol revocado no escriben metadata', async () => {
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

    const invalidSede = await postContract(harness.base, { sedeId: '0' });
    assert.equal(invalidSede.status, 400);
    const hugeSede = await postContract(harness.base, { sedeId: '99999999999999999' });
    assert.equal(hugeSede.status, 400);

    const invalidDate = await postContract(harness.base, { inicio: '2026-02-31' });
    assert.equal(invalidDate.status, 400);
    assert.equal(invalidDate.body.code, 'fecha_inicio_invalida');
    const reversed = await postContract(harness.base, { vencimiento: '2026-01-01' });
    assert.equal(reversed.status, 400);
    assert.equal(reversed.body.code, 'fecha_vencimiento_invalida');
    const badReference = await postContract(harness.base, { referencia: 'x'.repeat(241) });
    assert.equal(badReference.status, 400);
    const duplicatedUuid = await postContract(harness.base, { extraUuid: UUID_B });
    assert.equal(duplicatedUuid.status, 400, 'un contrato_uuid duplicado no debe degradar a otro UUID');
    assert.equal(duplicatedUuid.body.code, 'contrato_uuid_invalido');
    assert.equal(await countContracts(harness.pg), 0);

    await setRole(harness.pg, 'actor-a', 'admin_club');
    const revoked = await postContract(harness.base);
    assert.equal(revoked.status, 403);
    assert.equal(await countContracts(harness.pg), 0);
  } finally {
    await harness.close();
  }
});

test('archivo inválido falla antes de escribir; sin capacidad privada el archivo falla cerrado', async () => {
  const harness = await startHarness();
  try {
    const wrongMime = await postContract(harness.base, {
      file: { buffer: PDF, name: 'contrato.pdf', type: 'image/jpeg' },
    });
    assert.equal(wrongMime.status, 400);
    assert.equal(wrongMime.body.code, 'archivo_mime_invalido');

    const wrongMagic = await postContract(harness.base, {
      file: { buffer: Buffer.from('esto no es un contrato'), name: 'contrato.pdf', type: 'application/pdf' },
    });
    assert.equal(wrongMagic.status, 400);
    assert.equal(wrongMagic.body.code, 'archivo_invalido');
    assert.equal(await countContracts(harness.pg), 0);
    assert.equal(harness.storage.calls.length, 0);

    const validButNoCapability = await postContract(harness.base, {
      uuid: UUID_C,
      file: { buffer: PDF, name: 'contrato.pdf', type: 'application/pdf' },
    });
    assert.equal(validButNoCapability.status, 503);
    assert.equal(validButNoCapability.body.code, 'contrato_storage_unavailable');
    assert.equal(await countContracts(harness.pg), 0);
    assert.equal(harness.storage.calls.length, 0, 'no se sube nada si la capacidad privada no está habilitada');
  } finally {
    await harness.close();
  }
});

test('archivo privado con columna candidata y SDK simulado: path determinista, replay y 409', async () => {
  const harness = await startHarness({ withStorageColumn: true, privateStorage: PRIVATE_STORAGE });
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

    const stored = (await harness.pg.query('select * from public.contratos_sedes')).rows[0];
    assert.equal(stored.storage_path, expectedPath);
    assert.equal(stored.archivo_url, null, 'nunca se publica una URL pública para el archivo privado');
    assert.equal(harness.storage.objects.size, 1);
    assert.equal(harness.storage.calls.filter((call) => call.op === 'upload').length, 1);
    assert.equal(harness.storage.calls.filter((call) => call.op === 'createSignedUrl').length, 0);

    const replay = await postContract(harness.base, {
      file: { buffer: PDF, name: 'otro-nombre.pdf', type: 'application/pdf' },
    });
    assert.equal(replay.status, 200);
    assert.equal(replay.body.replayed, true);
    assert.equal(replay.body.contrato.archivo.path, expectedPath);
    assert.equal(await countContracts(harness.pg), 1);
    assert.equal(harness.storage.calls.filter((call) => call.op === 'upload').length, 1, 'el replay no vuelve a subir');

    const differentFile = await postContract(harness.base, {
      file: { buffer: PDF_ALT, name: 'contrato.pdf', type: 'application/pdf' },
    });
    assert.equal(differentFile.status, 409);
    assert.equal(differentFile.body.code, 'contrato_payload_conflict');
    assert.equal(await countContracts(harness.pg), 1);
    assert.equal(harness.storage.objects.size, 1);

    const differentMetadata = await postContract(harness.base, {
      referencia: 'REF-CONFLICTO',
      file: { buffer: PDF, name: 'contrato.pdf', type: 'application/pdf' },
    });
    assert.equal(differentMetadata.status, 409);
    assert.equal(await countContracts(harness.pg), 1);

    const missingFileOnExisting = await postContract(harness.base);
    assert.equal(missingFileOnExisting.status, 409, 'no se puede descartar silenciosamente el archivo ya guardado');
  } finally {
    await harness.close();
  }
});

test('revocación durante la espera de storage no escribe metadata ni borra el objeto', async () => {
  const harness = await startHarness({ withStorageColumn: true, privateStorage: PRIVATE_STORAGE });
  try {
    let revokeOnce = true;
    harness.storage.onUpload(async () => {
      if (!revokeOnce) return;
      revokeOnce = false;
      await setRole(harness.pg, 'actor-a', 'admin_club');
    });
    const revoked = await postContract(harness.base, {
      file: { buffer: PDF, name: 'contrato.pdf', type: 'application/pdf' },
    });
    assert.equal(revoked.status, 403);
    assert.equal(revoked.body.code, 'forbidden');
    assert.equal(await countContracts(harness.pg), 0, 'rol revocado después del storage no escribe');
    assert.equal(harness.storage.objects.size, 1, 'no se borra automáticamente un objeto potencialmente comprometido');
    assert.equal(harness.storage.calls.filter((call) => call.op === 'remove').length, 0);

    await setRole(harness.pg, 'actor-a', 'super_admin');
    const retry = await postContract(harness.base, {
      file: { buffer: PDF, name: 'contrato.pdf', type: 'application/pdf' },
    });
    assert.equal(retry.status, 201, 'el reintento del mismo UUID reutiliza el objeto content-addressed');
    assert.equal(await countContracts(harness.pg), 1);
    assert.equal(harness.storage.calls.filter((call) => call.op === 'upload').length, 2);
  } finally {
    await harness.close();
  }
});

test('columna candidata ausente con capacidad configurada falla cerrado antes de subir', async () => {
  const harness = await startHarness({ withStorageColumn: false, privateStorage: PRIVATE_STORAGE });
  try {
    const result = await postContract(harness.base, {
      file: { buffer: PDF, name: 'contrato.pdf', type: 'application/pdf' },
    });
    assert.equal(result.status, 503);
    assert.equal(result.body.code, 'contrato_storage_metadata_unavailable');
    assert.equal(await countContracts(harness.pg), 0);
    assert.equal(harness.storage.calls.length, 0);
  } finally {
    await harness.close();
  }
});

test('fallo transitorio de storage no escribe metadata y el mismo UUID puede reintentar', async () => {
  const harness = await startHarness({ withStorageColumn: true, privateStorage: PRIVATE_STORAGE });
  try {
    harness.storage.failNextUpload();
    const failed = await postContract(harness.base, {
      file: { buffer: PDF, name: 'contrato.pdf', type: 'application/pdf' },
    });
    assert.equal(failed.status, 502);
    assert.equal(failed.body.code, 'contrato_archivo_no_guardado');
    assert.equal(await countContracts(harness.pg), 0);

    const retry = await postContract(harness.base, {
      file: { buffer: PDF, name: 'contrato.pdf', type: 'application/pdf' },
    });
    assert.equal(retry.status, 201);
    assert.equal(await countContracts(harness.pg), 1);
  } finally {
    await harness.close();
  }
});
