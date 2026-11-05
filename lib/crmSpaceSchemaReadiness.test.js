import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { ensureSpaceTable } from './crmInboundRoutes.js';
import { SPACE_RETENTION_SCHEMA_SQL } from './crmSpacePrivacy.js';

const baseSchema = await readFile(new URL('../sql/20261104180000_crm_space_requests.sql', import.meta.url), 'utf8');
const unavailable = error => error.status === 503 && error.code === 'SPACE_SCHEMA_NOT_READY';

test('readiness is SELECT only and succeeds only after required migrations exist', async () => {
  const db = new PGlite();
  const queries = [];
  const pool = { async query(sql) { queries.push(sql); assert.match(sql, /^select\b/i); return db.query(sql); } };
  try {
    await assert.rejects(ensureSpaceTable(pool), unavailable);
    // Readiness never creates the missing table.
    assert.equal((await db.query("select to_regclass('public.crm_space_requests') as relation")).rows[0].relation, null);
    await db.exec('create role anon; create role authenticated; create role service_role;');
    await db.exec(baseSchema);
    await assert.rejects(ensureSpaceTable(pool), unavailable);
    await db.exec(SPACE_RETENTION_SCHEMA_SQL);
    assert.equal(await ensureSpaceTable(pool), true);
    assert.equal(queries.length, 3);
    assert.equal(await ensureSpaceTable(pool), true);
    assert.equal(queries.length, 3, 'successful readiness is cached per pool');
  } finally { await db.close(); }
});
test('missing metadata migration fails closed without silently adding its column', async () => {
  const db = new PGlite();
  try {
    await db.exec('create role anon; create role authenticated; create role service_role;');
    await db.exec(baseSchema);
    await db.exec(SPACE_RETENTION_SCHEMA_SQL);
    await db.exec('alter table crm_space_requests drop column metadata_policy;');
    await assert.rejects(ensureSpaceTable({ query: sql => db.query(sql) }), unavailable);
    const { rows } = await db.query("select column_name from information_schema.columns where table_schema='public' and table_name='crm_space_requests' and column_name='metadata_policy'");
    assert.equal(rows.length, 0);
  } finally { await db.close(); }
});
test('failed readiness can recover and one pool never authorizes a different pool', async () => {
  let available = false;
  let checks = 0;
  const pool = { async query() { checks++; if (!available) throw new Error('connection unavailable'); return { rows: [] }; } };
  await assert.rejects(ensureSpaceTable(pool), unavailable);
  available = true;
  assert.equal(await ensureSpaceTable(pool), true);
  assert.equal(await ensureSpaceTable(pool), true);
  assert.equal(checks, 2);
  await assert.rejects(ensureSpaceTable({ query: async () => { throw new Error('missing table'); } }), unavailable);
  await assert.rejects(ensureSpaceTable(null), unavailable);
});
