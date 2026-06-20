import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import {
  MATCH_SUMMARY_SOURCE_TYPE_PARTIDOS_ABIERTOS,
  MATCH_SUMMARY_STATUSES,
  createPendingMatchSummary,
  getMatchSummaryByPayloadHash,
  markMatchSummaryFailed,
  markMatchSummaryGenerated,
} from '../src/partidos/matchSummaryRepository.js';

describe('matchSummaryRepository', () => {
  it('exporta funciones del repositorio', () => {
    assert.equal(typeof getMatchSummaryByPayloadHash, 'function');
    assert.equal(typeof createPendingMatchSummary, 'function');
    assert.equal(typeof markMatchSummaryGenerated, 'function');
    assert.equal(typeof markMatchSummaryFailed, 'function');
    assert.equal(MATCH_SUMMARY_SOURCE_TYPE_PARTIDOS_ABIERTOS, 'partidos_abiertos');
    assert.deepEqual(MATCH_SUMMARY_STATUSES, [
      'pending',
      'generated',
      'failed',
      'skipped',
    ]);
  });

  it('createPendingMatchSummary inserta fila pending con pgPool mock', async () => {
    const queries = [];
    const pgPool = {
      query: async (sql, params) => {
        queries.push({ sql, params });
        if (/INSERT INTO partido_resumenes/i.test(sql)) {
          return {
            rows: [{
              id: 1,
              partido_id: 42,
              source_type: 'partidos_abiertos',
              version: '1.0.0',
              prompt_version: null,
              payload_hash: 'sha256:abc',
              payload: { partido_id: 42 },
              response: null,
              status: 'pending',
              error_code: null,
              error_message: null,
              generated_at: null,
              created_at: '2026-06-02T00:00:00.000Z',
              updated_at: '2026-06-02T00:00:00.000Z',
            }],
          };
        }
        return { rows: [] };
      },
    };

    const row = await createPendingMatchSummary({
      partidoId: 42,
      version: '1.0.0',
      payloadHash: 'sha256:abc',
      payload: { partido_id: 42 },
      pgPool,
    });

    assert.equal(row.status, 'pending');
    assert.equal(row.partido_id, 42);
    assert.match(queries[0].sql, /INSERT INTO partido_resumenes/i);
    assert.match(queries[0].sql, /'pending'/);
  });

  it('markMatchSummaryGenerated actualiza status generated', async () => {
    const pgPool = {
      query: async (sql) => {
        assert.match(sql, /status = 'generated'/i);
        return {
          rows: [{
            id: 7,
            partido_id: 42,
            source_type: 'partidos_abiertos',
            version: '1.0.0',
            prompt_version: 'match-summary@1.0.0',
            payload_hash: 'sha256:abc',
            payload: {},
            response: { title: 'Test' },
            status: 'generated',
            error_code: null,
            error_message: null,
            generated_at: '2026-06-02T01:00:00.000Z',
            created_at: '2026-06-02T00:00:00.000Z',
            updated_at: '2026-06-02T01:00:00.000Z',
          }],
        };
      },
    };

    const row = await markMatchSummaryGenerated({
      id: 7,
      response: { title: 'Test' },
      pgPool,
    });

    assert.equal(row.status, 'generated');
    assert.deepEqual(row.response, { title: 'Test' });
  });

  it('markMatchSummaryFailed actualiza status failed', async () => {
    const pgPool = {
      query: async (sql) => {
        assert.match(sql, /status = 'failed'/i);
        return {
          rows: [{
            id: 8,
            partido_id: 42,
            source_type: 'partidos_abiertos',
            version: '1.0.0',
            prompt_version: null,
            payload_hash: 'sha256:abc',
            payload: {},
            response: null,
            status: 'failed',
            error_code: 'AI_PROVIDER_ERROR',
            error_message: 'timeout',
            generated_at: null,
            created_at: '2026-06-02T00:00:00.000Z',
            updated_at: '2026-06-02T01:00:00.000Z',
          }],
        };
      },
    };

    const row = await markMatchSummaryFailed({
      id: 8,
      errorCode: 'AI_PROVIDER_ERROR',
      errorMessage: 'timeout',
      pgPool,
    });

    assert.equal(row.status, 'failed');
    assert.equal(row.error_code, 'AI_PROVIDER_ERROR');
  });
});

describe('partido_resumenes migration SQL', () => {
  const sql = readFileSync('docs/sql/partido_resumenes_migration.sql', 'utf8');

  it('contiene tabla partido_resumenes', () => {
    assert.match(sql, /CREATE TABLE IF NOT EXISTS partido_resumenes/i);
  });

  it('contiene unique partido_id/source_type/payload_hash', () => {
    assert.match(sql, /UNIQUE \(partido_id, source_type, payload_hash\)/i);
  });

  it('contiene status pending, generated, failed y skipped', () => {
    assert.match(sql, /'pending'/);
    assert.match(sql, /'generated'/);
    assert.match(sql, /'failed'/);
    assert.match(sql, /'skipped'/);
  });

  it('contiene índices por partido/source y status', () => {
    assert.match(sql, /idx_partido_resumenes_partido_source/i);
    assert.match(sql, /idx_partido_resumenes_status/i);
  });
});
