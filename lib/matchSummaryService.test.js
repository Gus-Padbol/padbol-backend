import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  MatchSummaryServiceError,
  computeMatchSummaryPayloadHash,
  generateMatchSummaryForPartido,
} from '../src/partidos/matchSummaryService.js';
import {
  buildDeterministicMatchSummary,
  buildFallbackMatchSummaryResponse,
  countSummarySentences,
  extractJsonFromAiResponse,
  parseAiSummaryResponse,
  validateAiSummaryQuality,
} from '../src/partidos/matchSummaryAiParse.js';

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
    equipo1: { nombre: 'Equipo 1', jugadores: [{ user_id: 'u1', nombre_display: 'Ana', es_capitan: true }] },
    equipo2: { nombre: 'Equipo 2', jugadores: [{ user_id: 'u2', nombre_display: 'Bruno', es_capitan: false }] },
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

const setsSamplePayload = {
  ...samplePayload,
  contexto: {
    ...samplePayload.contexto,
    sede_nombre: 'La Meca Padbol Club',
    fecha: '2026-06-15',
  },
  resultado: {
    formato: 'sets',
    ganador: 'equipo1',
    marcador_texto: '2-1 (6-4, 4-6, 6-3)',
    puntos_agregados: null,
    sets: {
      equipo1_sets: 2,
      equipo2_sets: 1,
      sets_detalle: [
        { eq1: 6, eq2: 4 },
        { eq1: 4, eq2: 6 },
        { eq1: 6, eq2: 3 },
      ],
    },
    fuente: 'sets_legacy_endpoint',
  },
  confirmacion: { estado: 'confirmado', confirmado_at: '2026-06-15T22:00:00.000Z' },
  disclaimers: {
    resultado_cargado_por_capitanes: 'Marcador confirmado por ambos capitanes en Padbol Match.',
  },
};

const shortSetsAiResponse = {
  title: 'Resumen del partido',
  summary: 'Equipo 1 venció a Equipo 2 por 2 a 1 en La Meca Padbol Club.',
  highlights: [{ type: 'resultado', text: 'Resultado final: 2-1.' }],
  disclaimers: ['Marcador confirmado por capitanes.'],
  source_fields_used: ['resultado.marcador_texto', 'contexto.sede_nombre'],
};

function createPgPoolStub() {
  return { query: async () => ({ rows: [] }) };
}

describe('matchSummaryAiParse', () => {
  it('extractJsonFromAiResponse soporta JSON puro', () => {
    const raw = JSON.stringify(validAiResponse);
    const candidates = extractJsonFromAiResponse(raw);
    assert.ok(candidates.includes(raw));
    assert.equal(parseAiSummaryResponse(raw).valid, true);
  });

  it('extractJsonFromAiResponse soporta bloque ```json', () => {
    const raw = '```json\n' + JSON.stringify(validAiResponse) + '\n```';
    const parsed = parseAiSummaryResponse(raw);
    assert.equal(parsed.valid, true);
    assert.equal(parsed.response.title, validAiResponse.title);
  });

  it('extractJsonFromAiResponse soporta texto antes y después del JSON', () => {
    const raw = `Aquí va el resumen:\n${JSON.stringify(validAiResponse)}\nFin.`;
    const parsed = parseAiSummaryResponse(raw);
    assert.equal(parsed.valid, true);
  });

  it('buildFallbackMatchSummaryResponse expone metadata interna sin textos técnicos visibles', () => {
    const fallback = buildFallbackMatchSummaryResponse({
      payload: {
        ...setsSamplePayload,
        analisis_previo: undefined,
      },
      parseError: 'Respuesta IA no es JSON válido',
    });

    assert.equal(fallback.metadata.fallback, true);
    assert.equal(fallback.metadata.parse_error, 'Respuesta IA no es JSON válido');
    assert.equal(fallback.title, 'Resumen del partido');
    assert.match(fallback.summary, /(se impuso|venció|imponiéndose).*(2 sets a 1)/i);
    assert.match(fallback.summary, /La Meca Padbol Club/i);
    assert.match(fallback.summary, /(partido cambiante|partido ajustado|duelo fue cambiante)/i);
    assert.match(fallback.summary, /(se llevó el primer set|ganó el primer set).*6-4/i);
    assert.match(fallback.summary, /reaccionó en el segundo/i);
    assert.match(fallback.summary, /(cerró|cierre).*6-3/i);
    assert.ok(countSummarySentences(fallback.summary) >= 2);
    assert.match(fallback.summary, /cerrarlo 6-3|cerró 6-3/i);
    assert.match(fallback.summary, /15 de junio de 2026/i);
    assert.ok(fallback.highlights.length >= 2);
    assert.match(fallback.highlights[0].text, /Resultado final:.*2-1/i);
    assert.match(fallback.highlights[1].text, /Parciales: 6-4, 4-6 y 6-3/i);
    assert.match(fallback.highlights[2].text, /tercer set definió el partido/i);
    assert.doesNotMatch(fallback.summary, /fallback/i);
    assert.doesNotMatch(JSON.stringify(fallback.disclaimers), /fallback|parseable|parse_error/i);
  });

  it('buildDeterministicMatchSummary genera crónica deportiva para 2-1', () => {
    const summary = buildDeterministicMatchSummary({
      ...setsSamplePayload,
      contexto: {
        ...setsSamplePayload.contexto,
        sede_nombre: 'La Meca Padbol Club',
      },
    });

    assert.equal(summary.title, 'Resumen del partido');
    assert.match(summary.summary, /(se impuso|venció|imponiéndose).*(2 sets a 1)/i);
    assert.match(summary.summary, /(partido cambiante|partido ajustado|duelo fue cambiante)/i);
    assert.match(summary.summary, /reaccionó en el segundo/i);
    assert.match(summary.summary, /6-4/);
    assert.match(summary.summary, /6-3/);
    assert.ok(countSummarySentences(summary.summary) >= 2);
    assert.match(summary.summary, /(cerró|cierre).*6-3|tercer/i);
    assert.match(summary.highlights[2].text, /tercer set definió el partido/i);
  });

  it('buildDeterministicMatchSummary genera crónica para 2-0', () => {
    const summary = buildDeterministicMatchSummary({
      ...setsSamplePayload,
      resultado: {
        formato: 'sets',
        ganador: 'equipo1',
        marcador_texto: '2-0 (6-3, 6-4)',
        sets: {
          equipo1_sets: 2,
          equipo2_sets: 0,
          sets_detalle: [{ eq1: 6, eq2: 3 }, { eq1: 6, eq2: 4 }],
        },
      },
    });

    assert.match(summary.summary, /(dominó|actuación sólida|Se impuso)/i);
    assert.doesNotMatch(summary.summary, /partido cambiante/i);
    assert.doesNotMatch(summary.summary, /reaccionó/i);
  });

  it('buildDeterministicMatchSummary oculta duración 0 en highlights', () => {
    const summary = buildDeterministicMatchSummary({
      ...setsSamplePayload,
      scoreboard_opcional: {
        cronometro_segundos: 0,
        duracion_aproximada_minutos: 0,
      },
    });

    assert.doesNotMatch(JSON.stringify(summary.highlights), /Duración aproximada/i);
  });

  it('buildDeterministicMatchSummary muestra duración real en summary', () => {
    const summary = buildDeterministicMatchSummary({
      ...setsSamplePayload,
      scoreboard_opcional: {
        cronometro_segundos: 3720,
        duracion_aproximada_minutos: 62,
      },
    });

    assert.match(summary.summary, /Duración aproximada: 62 minutos/i);
  });

  it('buildDeterministicMatchSummary usa nombres personalizados del payload', () => {
    const payload = {
      ...setsSamplePayload,
      equipos: {
        ...setsSamplePayload.equipos,
        equipo1: { nombre: 'Los Pibes', jugadores: setsSamplePayload.equipos.equipo1.jugadores },
        equipo2: { nombre: 'La Meca Team', jugadores: setsSamplePayload.equipos.equipo2.jugadores },
      },
    };

    const summary = buildDeterministicMatchSummary(payload);

    assert.match(summary.summary, /Los Pibes (se impuso|venció)/i);
    assert.match(summary.highlights[0].text, /Resultado final: Los Pibes 2-1 La Meca Team/i);
  });

  it('usa nombres de jugadores cuando no hay nombre custom de equipo', () => {
    const payload = {
      ...setsSamplePayload,
      equipos: {
        equipo1: {
          nombre: 'Equipo 1',
          jugadores: [
            { nombre_display: 'Fulano' },
            { nombre_display: 'Mengano' },
          ],
        },
        equipo2: {
          nombre: 'Equipo 2',
          jugadores: [
            { nombre_display: 'Sultana' },
            { nombre_display: 'Bruno' },
          ],
        },
      },
    };

    const summary = buildDeterministicMatchSummary(payload);

    assert.match(summary.summary, /equipo formado por Fulano y Mengano/i);
    assert.match(summary.summary, /equipo formado por Sultana y Bruno/i);
    assert.doesNotMatch(summary.summary, /@/);
  });

  it('partido 2-1 ajustado puede decir disputado o ajustado', () => {
    const summary = buildDeterministicMatchSummary(setsSamplePayload);
    assert.match(summary.summary, /(ajustado|disputado|cambiante)/i);
  });

  it('validateAiSummaryQuality rechaza emails visibles', () => {
    const quality = validateAiSummaryQuality(setsSamplePayload, {
      title: 'Resumen',
      summary: 'cap@test.com ganó 2-1 con parciales 6-4, 4-6 y 6-3. Fue un partido parejo en el tercer set.',
      highlights: [
        { type: 'resultado', text: 'Resultado final: 2-1.' },
        { type: 'sets', text: 'Parciales: 6-4, 4-6 y 6-3.' },
        { type: 'momento', text: 'El tercer set definió el partido.' },
      ],
      disclaimers: ['ok'],
      source_fields_used: ['resultado'],
    });

    assert.equal(quality.valid, false);
    assert.match(quality.error, /email/i);
  });

  it('validateAiSummaryQuality rechaza frases no respaldadas', () => {
    const quality = validateAiSummaryQuality(setsSamplePayload, {
      title: 'Resumen',
      summary: 'Equipo 1 dominó de principio a fin por 2 sets a 1 con parciales 6-4, 4-6 y 6-3. Fue un partido sólido en La Meca Padbol Club.',
      highlights: [
        { type: 'resultado', text: 'Resultado final: Equipo 1 2-1 Equipo 2.' },
        { type: 'sets', text: 'Parciales: 6-4, 4-6 y 6-3.' },
        { type: 'momento', text: 'El tercer set definió el partido.' },
      ],
      disclaimers: ['ok'],
      source_fields_used: ['resultado'],
    });

    assert.equal(quality.valid, false);
    assert.match(quality.error, /no respaldadas/i);
  });

  it('validateAiSummaryQuality rechaza summary de una sola frase con parciales 2-1', () => {
    const quality = validateAiSummaryQuality(setsSamplePayload, shortSetsAiResponse);
    assert.equal(quality.valid, false);
    assert.match(quality.error, /demasiado breve|parciales/i);
  });

  it('parseAiSummaryResponse rechaza IA válida pero pobre para 2-1 con 6-4, 4-6, 6-3', () => {
    const parsed = parseAiSummaryResponse(JSON.stringify(shortSetsAiResponse), setsSamplePayload);
    assert.equal(parsed.valid, false);
  });

  it('parseAiSummaryResponse acepta IA narrativa completa con parciales y tercer set', () => {
    const richAiResponse = {
      title: 'Equipo 1 se impuso en La Meca',
      summary: 'Equipo 1 venció a Equipo 2 por 2 sets a 1 en La Meca Padbol Club. Fue un partido cambiante: Equipo 1 se llevó el primer set 6-4, Equipo 2 reaccionó en el segundo parcial 4-6 y forzó la definición, pero Equipo 1 recuperó el control en el tercer set para cerrarlo 6-3.',
      highlights: [
        { type: 'resultado', text: 'Resultado final: Equipo 1 2-1 Equipo 2.' },
        { type: 'sets', text: 'Parciales: 6-4, 4-6 y 6-3.' },
        { type: 'momento', text: 'El tercer set definió el partido.' },
      ],
      disclaimers: ['Marcador confirmado por capitanes.'],
      source_fields_used: ['analisis_previo.parciales', 'resultado.sets'],
    };

    const parsed = parseAiSummaryResponse(JSON.stringify(richAiResponse), setsSamplePayload);
    assert.equal(parsed.valid, true);
    assert.ok(countSummarySentences(parsed.response.summary) >= 2);
    assert.match(parsed.response.summary, /6-4/);
    assert.match(parsed.response.summary, /4-6/);
    assert.match(parsed.response.summary, /6-3/);
  });
});

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

  it('si IA devuelve JSON inválido, usa fallback y persiste generated', async () => {
    const pgPool = createPgPoolStub();
    let generatedResponse = null;

    const result = await generateMatchSummaryForPartido({
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
        markFailed: async () => {
          throw new Error('markFailed no debería llamarse con fallback');
        },
        markGenerated: async ({ response }) => {
          generatedResponse = response;
          return {
            id: 9,
            partido_id: 42,
            status: 'generated',
            payload_hash: computeMatchSummaryPayloadHash(samplePayload),
            prompt_version: 'match-summary@1.0.0',
            generated_at: '2026-06-01T22:06:00.000Z',
            response,
          };
        },
      },
    });

    assert.equal(result.cached, false);
    assert.equal(result.storedResponse.metadata.fallback, true);
    assert.equal(result.summary.metadata, undefined);
    assert.match(result.summary.summary, /(se impuso|venció).*(6 a 4|6-4)/i);
    assert.equal(generatedResponse.metadata.fallback, true);
    assert.doesNotMatch(result.summary.summary, /No pudimos generar/i);
    assert.doesNotMatch(result.summary.summary, /fallback|parse_error|parseable/i);
  });

  it('si IA devuelve summary demasiado breve con sets, usa fallback determinístico enriquecido', async () => {
    const pgPool = createPgPoolStub();
    let generatedResponse = null;

    const result = await generateMatchSummaryForPartido({
      partidoId: 12,
      userId: 'user-1',
      pgPool,
      provider: {
        async completeChat() {
          return { reply: JSON.stringify(shortSetsAiResponse) };
        },
      },
      deps: {
        buildPayload: async () => ({ ...setsSamplePayload, partido_id: 12 }),
        getCache: async () => null,
        createPending: async () => ({ id: 12, partido_id: 12, payload_hash: 'sha256:abc' }),
        markFailed: async () => {
          throw new Error('markFailed no debería llamarse con fallback');
        },
        markGenerated: async ({ response }) => {
          generatedResponse = response;
          return {
            id: 12,
            partido_id: 12,
            status: 'generated',
            payload_hash: computeMatchSummaryPayloadHash({ ...setsSamplePayload, partido_id: 12 }),
            prompt_version: 'match-summary@1.3.0',
            generated_at: '2026-06-15T22:06:00.000Z',
            response,
          };
        },
      },
    });

    assert.equal(result.cached, false);
    assert.equal(result.storedResponse.metadata.fallback, true);
    assert.match(result.summary.summary, /(se impuso|venció|imponiéndose).*(2 sets a 1)/i);
    assert.match(result.summary.summary, /6-4/);
    assert.match(result.summary.summary, /6-3/);
    assert.match(result.summary.summary, /(partido cambiante|partido ajustado|duelo fue cambiante)/i);
    assert.ok(countSummarySentences(result.summary.summary) >= 2);
    assert.match(result.summary.highlights[1].text, /Parciales: 6-4, 4-6 y 6-3/i);
    assert.match(result.summary.highlights[2].text, /tercer set definió el partido/i);
    assert.equal(generatedResponse.metadata.fallback, true);
  });

  it('si IA devuelve JSON inválido con sets, usa resumen determinístico útil', async () => {
    const pgPool = createPgPoolStub();
    let generatedResponse = null;

    const result = await generateMatchSummaryForPartido({
      partidoId: 12,
      userId: 'user-1',
      pgPool,
      provider: {
        async completeChat() {
          return { reply: 'esto no es json' };
        },
      },
      deps: {
        buildPayload: async () => ({ ...setsSamplePayload, partido_id: 12 }),
        getCache: async () => null,
        createPending: async () => ({ id: 12, partido_id: 12, payload_hash: 'sha256:abc' }),
        markFailed: async () => {
          throw new Error('markFailed no debería llamarse con fallback');
        },
        markGenerated: async ({ response }) => {
          generatedResponse = response;
          return {
            id: 12,
            partido_id: 12,
            status: 'generated',
            payload_hash: computeMatchSummaryPayloadHash({ ...setsSamplePayload, partido_id: 12 }),
            prompt_version: 'match-summary@1.0.0',
            generated_at: '2026-06-15T22:06:00.000Z',
            response,
          };
        },
      },
    });

    assert.equal(result.cached, false);
    assert.equal(result.storedResponse.metadata.fallback, true);
    assert.equal(result.summary.metadata, undefined);
    assert.match(result.summary.summary, /(se impuso|venció|imponiéndose).*(2 sets a 1)/i);
    assert.match(result.summary.highlights[1].text, /Parciales: 6-4, 4-6 y 6-3/i);
    assert.equal(generatedResponse.metadata.fallback, true);
    assert.doesNotMatch(JSON.stringify(result.summary.disclaimers), /fallback|parseable/i);
  });

  it('parsea respuesta IA envuelta en markdown', async () => {
    const pgPool = createPgPoolStub();

    const result = await generateMatchSummaryForPartido({
      partidoId: 42,
      userId: 'user-1',
      pgPool,
      provider: {
        async completeChat() {
          return { reply: '```json\n' + JSON.stringify(validAiResponse) + '\n```' };
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

    assert.equal(result.summary.title, validAiResponse.title);
    assert.equal(result.summary.metadata, undefined);
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
