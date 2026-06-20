import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  MatchSummaryServiceError,
  computeMatchSummaryPayloadHash,
  generateMatchSummaryForPartido,
} from '../src/partidos/matchSummaryService.js';

const samplePayload = {
  schema_version: '1.0.0',
  partido_id: 42,
  contexto: {
    deporte: 'padbol',
    sede_nombre: 'Club Test',
    fecha: '2026-06-01',
    hora: '20:00',
  },
  equipos: {
    derivacion: 'joined_at_split',
    equipo1: { jugadores: [{ user_id: 'u1', nombre_display: 'Ana', es_capitan: true }] },
    equipo2: { jugadores: [{ user_id: 'u2', nombre_display: 'Bruno', es_capitan: false }] },
  },
  resultado: {
    formato: 'puntos_agregados',
    ganador: 'equipo1',
    marcador_texto: '6-4',
    puntos_agregados: { equipo1: 6, equipo2: 4 },
    sets: null,
    fuente: 'dual_captain',
  },
  confirmacion: { estado: 'confirmado', confirmado_at: '2026-06-01T22:00:00.000Z' },
  xp_opcional: null,
  scoreboard_opcional: null,
  disclaimers: {},
};

const validAiResponse = {
  title: 'Victoria de Ana en Club Test',
  summary: 'Partido de padbol en Club Test. Ana venció por 6-4.',
  highlights: [{ type: 'resultado', text: 'Marcador final: 6-4.' }],
  disclaimers: ['Resumen basado en datos cargados.'],
  source_fields_used: ['contexto.sede_nombre', 'resultado.marcador_texto'],
};

function createPgPoolStub() {
  return { query: async () => ({ rows: [] }) };
}

describe('matchSummaryService', () => {
  it('exporta generateMatchSummaryForPartido', () => {
    assert.equal(typeof generateMatchSummaryForPartido, 'function');
  });

  it('payload_hash es estable para mismo payload', () => {
    const hashA = computeMatchSummaryPayloadHash(samplePayload);
    const hashB = computeMatchSummaryPayloadHash({
      ...samplePayload,
      contexto: {
        hora: '20:00',
        fecha: '2026-06-01',
        sede_nombre: 'Club Test',
        deporte: 'padbol',
      },
    });

    assert.equal(hashA, hashB);
    assert.match(hashA, /^sha256:[a-f0-9]{64}$/);
  });

  it('si cache generated existe, no llama IA', async () => {
    let aiCalled = false;
    const pgPool = createPgPoolStub();

    const result = await generateMatchSummaryForPartido({
      partidoId: 42,
      userId: 'user-1',
      pgPool,
      provider: {
        async completeChat() {
          aiCalled = true;
          return { reply: JSON.stringify(validAiResponse) };
        },
      },
      deps: {
        buildPayload: async () => ({ ...samplePayload }),
        getCache: async () => ({
          id: 1,
          partido_id: 42,
          status: 'generated',
          payload_hash: computeMatchSummaryPayloadHash(samplePayload),
          prompt_version: 'match-summary@1.0.0',
          generated_at: '2026-06-01T22:05:00.000Z',
          response: validAiResponse,
        }),
        createPending: async () => {
          throw new Error('createPending no debería llamarse con cache generated');
        },
      },
    });

    assert.equal(aiCalled, false);
    assert.equal(result.cached, true);
    assert.equal(result.summary.title, validAiResponse.title);
  });

  it('si IA devuelve JSON inválido, marca failed', async () => {
    const pgPool = createPgPoolStub();
    const failedCalls = [];

    await assert.rejects(
      () => generateMatchSummaryForPartido({
        partidoId: 42,
        userId: 'user-1',
        pgPool,
        provider: {
          async completeChat() {
            return { reply: 'esto no es json' };
          },
        },
        deps: {
          buildPayload: async () => ({ ...samplePayload }),
          getCache: async () => null,
          createPending: async () => ({ id: 9, partido_id: 42, payload_hash: 'sha256:abc' }),
          markFailed: async (params) => {
            failedCalls.push(params);
            return { id: 9, status: 'failed' };
          },
          markGenerated: async () => {
            throw new Error('markGenerated no debería llamarse');
          },
        },
      }),
      (err) => {
        assert.ok(err instanceof MatchSummaryServiceError);
        assert.equal(err.code, 'MATCH_SUMMARY_AI_INVALID_JSON');
        return true;
      },
    );

    assert.equal(failedCalls.length, 1);
    assert.equal(failedCalls[0].errorCode, 'MATCH_SUMMARY_AI_INVALID_JSON');
  });

  it('respuesta generada incluye cached false', async () => {
    const pgPool = createPgPoolStub();

    const result = await generateMatchSummaryForPartido({
      partidoId: 42,
      userId: 'user-1',
      pgPool,
      provider: {
        async completeChat() {
          return { reply: JSON.stringify(validAiResponse) };
        },
      },
      deps: {
        buildPayload: async () => ({ ...samplePayload }),
        getCache: async () => null,
        createPending: async () => ({
          id: 10,
          partido_id: 42,
          payload_hash: computeMatchSummaryPayloadHash(samplePayload),
          prompt_version: 'match-summary@1.0.0',
        }),
        markGenerated: async ({ response }) => ({
          id: 10,
          partido_id: 42,
          status: 'generated',
          payload_hash: computeMatchSummaryPayloadHash(samplePayload),
          prompt_version: 'match-summary@1.0.0',
          generated_at: '2026-06-01T22:06:00.000Z',
          response,
        }),
      },
    });

    assert.equal(result.cached, false);
    assert.equal(result.summary.partido_id, 42);
    assert.equal(result.summary.summary, validAiResponse.summary);
    assert.deepEqual(result.summary.resultado_eco, {
      ganador: 'equipo1',
      marcador_texto: '6-4',
    });
  });
});
