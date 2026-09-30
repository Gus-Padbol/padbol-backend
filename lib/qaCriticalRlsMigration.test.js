import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationPath = path.resolve(
  here,
  '../sql/migrations/20260930124500_qa_critical_rls_public_tables.sql',
);
const sql = fs.readFileSync(migrationPath, 'utf8').toLowerCase();

const protectedTables = [
  'fipa_asociaciones_nacionales',
  'fipa_temporadas',
  'fipa_ranking_excepciones_auditoria',
  'jugador_claim_historico',
  'jugador_historico',
];

const revokeTableBlock = sql.match(
  /revoke\s+all\s+on\s+table([\s\S]*?)from\s+public,\s*anon,\s*authenticated/,
)?.[1] || '';
const revokeSequenceBlock = sql.match(
  /revoke\s+all\s+on\s+sequence([\s\S]*?)from\s+public,\s*anon,\s*authenticated/,
)?.[1] || '';

test('critical QA tables enable RLS and revoke broad public access', () => {
  for (const table of protectedTables) {
    assert.match(sql, new RegExp(`alter\\s+table\\s+public\\.${table}\\s+enable\\s+row\\s+level\\s+security`));
    assert.match(revokeTableBlock, new RegExp(`public\\.${table}(?:\\s|,|$)`));
    assert.match(revokeSequenceBlock, new RegExp(`public\\.${table}_id_seq(?:\\s|,|$)`));
  }
  assert.ok(revokeTableBlock);
  assert.ok(revokeSequenceBlock);
});
test('the migration does not introduce unrestricted RLS policies', () => {
  assert.doesNotMatch(sql, /using\s*\(\s*true\s*\)/);
  assert.doesNotMatch(sql, /with\s+check\s*\(\s*true\s*\)/);
  assert.doesNotMatch(sql, /grant\s+(?:all|insert|update|delete)[\s\S]{0,100}\s+to\s+(?:anon|authenticated)/);
});

test('only narrowed public catalogs receive direct SELECT policies', () => {
  assert.match(sql, /using\s*\(\s*activa\s+is\s+true\s*\)/);
  assert.match(sql, /using\s*\(\s*estado\s*=\s*'publicada'\s*\)/);

  for (const table of [
    'fipa_ranking_excepciones_auditoria',
    'jugador_claim_historico',
    'jugador_historico',
  ]) {
    const policyForTable = new RegExp(`create\\s+policy[\\s\\S]{0,180}on\\s+public\\.${table}`);
    assert.doesNotMatch(sql, policyForTable);
  }
});
