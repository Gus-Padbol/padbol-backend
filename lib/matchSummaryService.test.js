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

const badAiResponseWithTechnicalNames = {
  title: 'Resumen del partido',
  summary: 'El equipo formado por padbolmatchsaas y Nico se impuso al equipo formado por prueba y Gus con un marcador de 2-1, en un partido disputado en La Meca Padbol Club, cancha 1. El resultado fue confirmado por ambos capitanes en Padbol Match.',
  highlights: [
    { type: 'resultado', text: 'Resultado final: 2-1.' },
    { type: 'momento', text: 'Partido disputado en La Meca Padbol Club.' },
  ],
  disclaimers: ['Marcador confirmado por ambos capitanes en Padbol Match.'],
  source_fields_used: ['resultado.marcador_texto', 'contexto.sede_nombre'],
};

const realCasePayload = {
  ...setsSamplePayload,
  partido_id: 12,
  contexto: {
    ...setsSamplePayload.contexto,
    sede_nombre: 'La Meca Padbol Club',
    cancha: '1',
  },
  equipos: {
    derivacion: 'joined_at_split',
    equipo1: {
      nombre: 'Equipo 1',
      jugadores: [
        { user_id: 'u1', nombre_display: 'padbolmatchsaas', es_capitan: true },
        { user_id: 'u2', nombre_display: 'Nico', es_capitan: false },
      ],
    },
    equipo2: {
      nombre: 'Equipo 2',
      jugadores: [
        { user_id: 'u3', nombre_display: 'prueba', es_capitan: true },
        { user_id: 'u4', nombre_display: 'Gus', es_capitan: false },
      ],
    },
  },
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
    assert.match(fallback.summary, /(se llevó el primer|primer parcial|Ganó el primer parcial).*6-4/i);
    assert.match(fallback.summary, /reaccionó en el segundo/i);
    assert.match(fallback.summary, /(cerró|cierre|cerraron).*6-3/i);
    assert.ok(countSummarySentences(fallback.summary) >= 2);
    assert.match(fallback.summary, /(cerrarlo 6-3|cerró 6-3|cerraron mejor para ganar 6-3)/i);
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

  it('usa nombres custom Los Gauchos y Los Cedros en summary y highlights', () => {
    const payload = {
      ...setsSamplePayload,
      equipos: {
        ...setsSamplePayload.equipos,
        equipo1: { nombre: 'Los Gauchos', jugadores: setsSamplePayload.equipos.equipo1.jugadores },
        equipo2: { nombre: 'Los Cedros', jugadores: setsSamplePayload.equipos.equipo2.jugadores },
      },
    };

    const summary = buildDeterministicMatchSummary(payload);

    assert.match(summary.summary, /Los Gauchos/i);
    assert.match(summary.summary, /Los Cedros|dupla rival|pareja/i);
    assert.match(summary.highlights[0].text, /Resultado final: Los Gauchos 2-1 Los Cedros/i);
    assert.doesNotMatch(summary.summary, /Equipo 1/);
    assert.doesNotMatch(summary.summary, /Equipo 2/);
  });

  it('usa dupla de jugadores confiables cuando no hay nombres custom', () => {
    const payload = {
      ...setsSamplePayload,
      equipos: {
        equipo1: {
          nombre: 'Equipo 1',
          jugadores: [
            { nombre_display: 'Nico Renedo' },
            { nombre_display: 'Gustavo Miguens' },
          ],
        },
        equipo2: {
          nombre: 'Equipo 2',
          jugadores: [
            { nombre_display: 'Ana López' },
            { nombre_display: 'Bruno' },
          ],
        },
      },
    };

    const summary = buildDeterministicMatchSummary(payload);

    assert.match(summary.summary, /La dupla de Nico Renedo y Gustavo Miguens/i);
    assert.doesNotMatch(summary.summary, /Equipo 1.*Equipo 1/s);
    assert.doesNotMatch(summary.summary, /equipo formado por/i);
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

  it('usa Equipo 1 solo una vez cuando no hay alternativa confiable', () => {
    const payload = {
      ...setsSamplePayload,
      equipos: {
        equipo1: {
          nombre: 'Equipo 1',
          jugadores: [
            { nombre_display: 'Fulano' },
          ],
        },
        equipo2: {
          nombre: 'Equipo 2',
          jugadores: [
            { nombre_display: 'Sultana' },
          ],
        },
      },
    };

    const summary = buildDeterministicMatchSummary(payload);

    assert.match(summary.summary, /Equipo 1 (se impuso|tuvo que trabajar|dominó)/i);
    assert.doesNotMatch(summary.summary, /Equipo 1.*Equipo 1/s);
    assert.doesNotMatch(summary.summary, /Equipo 2.*Equipo 2/s);
    assert.match(summary.summary, /(dupla rival|pareja vencedora|los ganadores|los vencidos)/i);
    assert.doesNotMatch(summary.summary, /equipo formado por/i);
    assert.doesNotMatch(summary.summary, /@/);
  });

  it('caso real partido 12: fallback sin usernames técnicos ni repetición excesiva', () => {
    const summary = buildDeterministicMatchSummary(realCasePayload);

    assert.doesNotMatch(summary.summary, /padbolmatchsaas/i);
    assert.doesNotMatch(summary.summary, /prueba/i);
    assert.doesNotMatch(summary.summary, /padbolinternacional/i);
    assert.doesNotMatch(summary.summary, /confirmado/i);
    assert.match(summary.summary, /6-4/);
    assert.match(summary.summary, /4-6/);
    assert.match(summary.summary, /6-3/);
    assert.match(summary.summary, /(reaccionó|respondió|empujó)/i);
    assert.match(summary.summary, /(dupla rival|pareja perdedora|los vencidos)/i);
    assert.doesNotMatch(summary.summary, /Equipo 1.*Equipo 1/s);
    assert.match(summary.highlights[1].text, /Parciales: 6-4, 4-6 y 6-3/i);
    assert.match(summary.highlights[2].text, /tercer set definió el partido/i);
  });

  it('validateAiSummaryQuality rechaza repetición excesiva de Equipo 1/2', () => {
    const quality = validateAiSummaryQuality(setsSamplePayload, {
      title: 'Resumen',
      summary: 'Equipo 1 se impuso a Equipo 2 por 2 sets a 1. Equipo 1 ganó el primer set 6-4, Equipo 2 reaccionó 4-6 y Equipo 1 cerró 6-3 en el tercer set.',
      highlights: [
        { type: 'resultado', text: 'Resultado final: Equipo 1 2-1 Equipo 2.' },
        { type: 'sets', text: 'Parciales: 6-4, 4-6 y 6-3.' },
        { type: 'momento', text: 'El tercer set definió el partido.' },
      ],
      disclaimers: ['ok'],
      source_fields_used: ['resultado'],
    });

    assert.equal(quality.valid, false);
    assert.match(quality.error, /repite Equipo/i);
  });

  it('validateAiSummaryQuality rechaza último punto sin historial_puntos', () => {
    const quality = validateAiSummaryQuality(setsSamplePayload, {
      title: 'Resumen',
      summary: 'Equipo 1 se impuso por 2 sets a 1 en La Meca Padbol Club. Ganó 6-4, perdió 4-6 y definió 6-3 en el último punto del tercer set.',
      highlights: [
        { type: 'resultado', text: 'Resultado final: 2-1.' },
        { type: 'sets', text: 'Parciales: 6-4, 4-6 y 6-3.' },
        { type: 'momento', text: 'El tercer set definió el partido.' },
      ],
      disclaimers: ['ok'],
      source_fields_used: ['resultado'],
    });

    assert.equal(quality.valid, false);
    assert.match(quality.error, /último punto/i);
  });

  it('validateAiSummaryQuality rechaza usernames técnicos y lenguaje administrativo', () => {
    const quality = validateAiSummaryQuality(realCasePayload, badAiResponseWithTechnicalNames);

    assert.equal(quality.valid, false);
    assert.match(quality.error, /administrativo|técnicos|no deportivos/i);
  });

  it('parseAiSummaryResponse rechaza IA con padbolmatchsaas y usa fallback en servicio', async () => {
    const parsed = parseAiSummaryResponse(
      JSON.stringify(badAiResponseWithTechnicalNames),
      realCasePayload,
    );
    assert.equal(parsed.valid, false);

    const pgPool = createPgPoolStub();
    let generatedResponse = null;

    const result = await generateMatchSummaryForPartido({
      partidoId: 12,
      userId: 'user-1',
      pgPool,
      provider: {
        async completeChat() {
          return { reply: JSON.stringify(badAiResponseWithTechnicalNames) };
        },
      },
      deps: {
        buildPayload: async () => ({ ...realCasePayload }),
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
            payload_hash: computeMatchSummaryPayloadHash(realCasePayload),
            prompt_version: 'match-summary@1.6.0',
            generated_at: '2026-06-15T22:06:00.000Z',
            response,
          };
        },
      },
    });

    assert.equal(result.storedResponse.metadata.fallback, true);
    assert.doesNotMatch(result.summary.summary, /padbolmatchsaas/i);
    assert.doesNotMatch(result.summary.summary, /prueba/i);
    assert.doesNotMatch(result.summary.summary, /confirmado/i);
    assert.match(result.summary.summary, /6-4/);
    assert.match(result.summary.summary, /4-6/);
    assert.match(result.summary.summary, /6-3/);
    assert.match(result.summary.highlights[1].text, /Parciales:/i);
    assert.equal(generatedResponse.metadata.fallback, true);
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
        { type: 'resultado', text: 'Resultado final: 2-1.' },
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
      summary: 'Equipo 1 se impuso por 2 sets a 1 en La Meca Padbol Club. Fue un partido cambiante: se llevó el primer set 6-4, la dupla rival reaccionó en el segundo parcial 4-6 y forzó la definición, pero la pareja vencedora recuperó el control en el tercer set para cerrarlo 6-3.',
      highlights: [
        { type: 'resultado', text: 'Resultado final: 2-1.' },
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
