import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MatchSummaryPayloadError } from '../src/partidos/matchSummaryPayload.js';
import {
  PARTIDO_RESUMEN_ROUTE_PATH,
  createPartidosRouter,
  fetchPartidoResumenPayload,
  mapMatchSummaryHttpError,
} from '../routes/partidos.js';

const sampleSummary = {
  version: '1.0.0',
  partido_id: 42,
  generated_at: '2026-06-01T22:06:00.000Z',
  cached: false,
  title: 'Victoria en Club Test',
  summary: 'Partido confirmado por 6-4.',
  highlights: [],
  disclaimers: ['Resumen basado en datos cargados.'],
  source_fields_used: ['resultado.marcador_texto'],
};

describe('matchSummaryEndpoint', () => {
  it('registra GET /:id/resumen en createPartidosRouter', () => {
    const router = createPartidosRouter({
      supabase: {},
      supabaseAdmin: { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }) }) },
      getAuthenticatedUser: async () => ({ user: null, status: 401, error: 'auth' }),
      pgPool: {},
    });

    const layer = router.stack.find(
      (entry) => entry.route?.path === PARTIDO_RESUMEN_ROUTE_PATH && entry.route.methods.get,
    );

    assert.ok(layer, 'GET /:id/resumen route registered');
    assert.equal(PARTIDO_RESUMEN_ROUTE_PATH, '/:id/resumen');
  });

  it('fetchPartidoResumenPayload usa generateMatchSummaryForPartido', async () => {
    let called = false;
    const pgPool = { query: async () => ({ rows: [] }) };

    const result = await fetchPartidoResumenPayload({
      partidoId: 42,
      userId: 'user-1',
      pgPool,
      generateSummary: async (params) => {
        called = true;
        assert.equal(params.partidoId, 42);
        assert.equal(params.userId, 'user-1');
        assert.equal(params.pgPool, pgPool);
        return { summary: sampleSummary, cached: true };
      },
    });

    assert.equal(called, true);
    assert.equal(result.cached, true);
  });

  it('mapea error 403', () => {
    const mapped = mapMatchSummaryHttpError(
      new MatchSummaryPayloadError('No tenés acceso a este partido', {
        status: 403,
        code: 'PARTIDO_ACCESS_DENIED',
      }),
    );

    assert.equal(mapped.status, 403);
    assert.equal(mapped.body.ok, false);
    assert.equal(mapped.body.code, 'PARTIDO_ACCESS_DENIED');
  });

  it('mapea error 409', () => {
    const mapped = mapMatchSummaryHttpError(
      new MatchSummaryPayloadError('El partido está en disputa', {
        status: 409,
        code: 'PARTIDO_EN_DISPUTA',
      }),
    );

    assert.equal(mapped.status, 409);
    assert.equal(mapped.body.ok, false);
    assert.match(mapped.body.error, /disputa/i);
  });

  it('respuesta exitosa incluye ok true y resumen', async () => {
    const pgPool = { query: async () => ({ rows: [] }) };

    const result = await fetchPartidoResumenPayload({
      partidoId: 42,
      userId: 'user-1',
      pgPool,
      generateSummary: async () => ({
        summary: sampleSummary,
        cached: false,
      }),
    });

    const responseBody = {
      ok: true,
      resumen: result.summary,
      cached: result.cached,
      generated_at: result.summary.generated_at,
    };

    assert.equal(responseBody.ok, true);
    assert.equal(responseBody.resumen.title, sampleSummary.title);
    assert.equal(responseBody.cached, false);
    assert.equal(responseBody.generated_at, sampleSummary.generated_at);
  });
});
