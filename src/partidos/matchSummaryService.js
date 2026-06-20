import { createHash } from 'node:crypto';
import { resolvePromptForSkill } from '../ai/prompts/registry.js';
import { getAiProvider } from '../ai/providers/index.js';
import { MATCH_SUMMARY_PROMPT_VERSION } from '../ai/prompts/matchSummaryV1.js';
import {
  MATCH_SUMMARY_PAYLOAD_VERSION,
  MatchSummaryPayloadError,
  buildMatchSummaryPayload,
} from './matchSummaryPayload.js';
import {
  MATCH_SUMMARY_SOURCE_TYPE_PARTIDOS_ABIERTOS,
  createPendingMatchSummary,
  getMatchSummaryByPayloadHash,
  markMatchSummaryFailed,
  markMatchSummaryGenerated,
} from './matchSummaryRepository.js';

export class MatchSummaryServiceError extends Error {
  constructor(message, { status = 500, code = 'MATCH_SUMMARY_SERVICE_ERROR' } = {}) {
    super(message);
    this.name = 'MatchSummaryServiceError';
    this.status = status;
    this.code = code;
  }
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }

  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

/**
 * Hash estable del MatchSummaryPayload (RFC: sha256 del JSON canónico).
 * @param {object} payload
 * @returns {string}
 */
export function computeMatchSummaryPayloadHash(payload) {
  const canonical = stableStringify(payload);
  const digest = createHash('sha256').update(canonical, 'utf8').digest('hex');
  return `sha256:${digest}`;
}

function extractJsonText(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return null;

  const fenced = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced ? fenced[1].trim() : text;
}

function validateAiSummaryResponse(parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { valid: false, error: 'La respuesta IA no es un objeto JSON' };
  }

  const requiredStrings = ['title', 'summary'];
  for (const key of requiredStrings) {
    if (typeof parsed[key] !== 'string' || !parsed[key].trim()) {
      return { valid: false, error: `Campo requerido inválido: ${key}` };
    }
  }

  const requiredArrays = ['highlights', 'disclaimers', 'source_fields_used'];
  for (const key of requiredArrays) {
    if (!Array.isArray(parsed[key])) {
      return { valid: false, error: `Campo requerido inválido: ${key}` };
    }
  }

  if (parsed.title.length > 120) {
    return { valid: false, error: 'title excede 120 caracteres' };
  }

  if (parsed.summary.length > 600) {
    return { valid: false, error: 'summary excede 600 caracteres' };
  }

  if (parsed.highlights.length > 3) {
    return { valid: false, error: 'highlights excede 3 elementos' };
  }

  for (const highlight of parsed.highlights) {
    if (!highlight || typeof highlight !== 'object' || Array.isArray(highlight)) {
      return { valid: false, error: 'highlight inválido' };
    }
    if (typeof highlight.type !== 'string' || typeof highlight.text !== 'string') {
      return { valid: false, error: 'highlight.type/text requeridos' };
    }
  }

  return { valid: true, response: parsed };
}

function parseAiSummaryResponse(rawReply) {
  const jsonText = extractJsonText(rawReply);
  if (!jsonText) {
    return { valid: false, error: 'Respuesta IA vacía' };
  }

  try {
    const parsed = JSON.parse(jsonText);
    return validateAiSummaryResponse(parsed);
  } catch {
    return { valid: false, error: 'Respuesta IA no es JSON válido' };
  }
}

function buildSummaryResult({ row, aiResponse, payload, cached }) {
  return {
    summary: {
      version: MATCH_SUMMARY_PAYLOAD_VERSION,
      partido_id: payload.partido_id,
      generated_at: row.generated_at ?? new Date().toISOString(),
      cached,
      prompt_version: row.prompt_version ?? MATCH_SUMMARY_PROMPT_VERSION,
      payload_hash: row.payload_hash,
      title: aiResponse.title,
      summary: aiResponse.summary,
      highlights: aiResponse.highlights,
      disclaimers: aiResponse.disclaimers,
      source_fields_used: aiResponse.source_fields_used,
      resultado_eco: payload.resultado?.marcador_texto
        ? {
          ganador: payload.resultado.ganador ?? null,
          marcador_texto: payload.resultado.marcador_texto,
        }
        : null,
    },
    cached,
  };
}

/**
 * @param {{
 *   partidoId: number|string,
 *   userId?: string|null,
 *   pgPool: import('pg').Pool,
 *   force?: boolean,
 *   provider?: { completeChat: Function },
 *   deps?: {
 *     buildPayload?: typeof buildMatchSummaryPayload,
 *     getCache?: typeof getMatchSummaryByPayloadHash,
 *     createPending?: typeof createPendingMatchSummary,
 *     markGenerated?: typeof markMatchSummaryGenerated,
 *     markFailed?: typeof markMatchSummaryFailed,
 *     resolvePrompt?: typeof resolvePromptForSkill,
 *     getProvider?: typeof getAiProvider,
 *   },
 * }} params
 */
export async function generateMatchSummaryForPartido({
  partidoId,
  userId = null,
  pgPool,
  force = false,
  provider,
  deps = {},
} = {}) {
  const buildPayloadFn = deps.buildPayload ?? buildMatchSummaryPayload;
  const getCacheFn = deps.getCache ?? getMatchSummaryByPayloadHash;
  const createPendingFn = deps.createPending ?? createPendingMatchSummary;
  const markGeneratedFn = deps.markGenerated ?? markMatchSummaryGenerated;
  const markFailedFn = deps.markFailed ?? markMatchSummaryFailed;
  const resolvePromptFn = deps.resolvePrompt ?? resolvePromptForSkill;
  const getProviderFn = deps.getProvider ?? getAiProvider;

  let payload;
  try {
    payload = await buildPayloadFn({ partidoId, userId, pgPool });
  } catch (err) {
    if (err instanceof MatchSummaryPayloadError) {
      throw err;
    }
    throw err;
  }

  const payloadHash = computeMatchSummaryPayloadHash(payload);
  const sourceType = MATCH_SUMMARY_SOURCE_TYPE_PARTIDOS_ABIERTOS;

  const cachedRow = await getCacheFn({
    partidoId: payload.partido_id,
    sourceType,
    payloadHash,
    pgPool,
  });

  if (!force && cachedRow?.status === 'generated' && cachedRow.response) {
    return buildSummaryResult({
      row: cachedRow,
      aiResponse: cachedRow.response,
      payload,
      cached: true,
    });
  }

  const pendingRow = await createPendingFn({
    partidoId: payload.partido_id,
    sourceType,
    version: MATCH_SUMMARY_PAYLOAD_VERSION,
    promptVersion: MATCH_SUMMARY_PROMPT_VERSION,
    payloadHash,
    payload,
    pgPool,
  });

  const aiProvider = provider ?? getProviderFn();
  const prompt = resolvePromptFn('match-summary');

  let aiReply;
  try {
    ({ reply: aiReply } = await aiProvider.completeChat({
      system: prompt.system,
      userMessage: JSON.stringify(payload),
      maxTokens: prompt.maxTokens,
    }));
  } catch (err) {
    await markFailedFn({
      id: pendingRow.id,
      errorCode: err?.code ?? 'AI_PROVIDER_ERROR',
      errorMessage: err?.message ?? 'Error al llamar al proveedor IA',
      pgPool,
    });

    throw new MatchSummaryServiceError('No se pudo generar el resumen con IA', {
      status: Number(err?.status) >= 400 && Number(err?.status) < 500 ? err.status : 503,
      code: err?.code ?? 'AI_PROVIDER_ERROR',
    });
  }

  const parsed = parseAiSummaryResponse(aiReply);
  if (!parsed.valid) {
    await markFailedFn({
      id: pendingRow.id,
      errorCode: 'MATCH_SUMMARY_AI_INVALID_JSON',
      errorMessage: parsed.error,
      pgPool,
    });

    throw new MatchSummaryServiceError(parsed.error, {
      status: 422,
      code: 'MATCH_SUMMARY_AI_INVALID_JSON',
    });
  }

  const generatedRow = await markGeneratedFn({
    id: pendingRow.id,
    response: parsed.response,
    pgPool,
  });

  if (!generatedRow) {
    throw new MatchSummaryServiceError('No se pudo persistir el resumen generado', {
      status: 500,
      code: 'MATCH_SUMMARY_PERSIST_FAILED',
    });
  }

  return buildSummaryResult({
    row: generatedRow,
    aiResponse: parsed.response,
    payload,
    cached: false,
  });
}
