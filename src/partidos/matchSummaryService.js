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
  buildFallbackMatchSummaryResponse,
  parseAiSummaryResponse,
} from './matchSummaryAiParse.js';
import {
  MATCH_SUMMARY_SOURCE_TYPE_PARTIDOS_ABIERTOS,
  createPendingMatchSummary,
  getMatchSummaryByPayloadHash,
  claimCasualSummaryGeneration,
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

function buildSummaryResult({ row, aiResponse, payload, cached }) {
  return {
    summary: {
      version: MATCH_SUMMARY_PAYLOAD_VERSION,
      partido_id: payload.partido_id,
      generated_at: row.generated_at ?? new Date().toISOString(),
      cached,
      title: aiResponse.title,
      summary: aiResponse.summary,
      highlights: aiResponse.highlights,
      disclaimers: aiResponse.disclaimers,
      resultado_eco: payload.resultado?.marcador_texto
        ? {
          ganador: payload.resultado.ganador ?? null,
          marcador_texto: payload.resultado.marcador_texto,
        }
        : null,
    },
    cached,
    storedResponse: aiResponse,
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
async function generateMatchSummaryForPartidoUnlocked({
  partidoId,
  userId = null,
  pgPool,
  force = false,
  provider,
  deps = {},
} = {}) {
  const buildPayloadFn = deps.buildPayload ?? buildMatchSummaryPayload;
  const getCacheFn = deps.getCache ?? getMatchSummaryByPayloadHash;
  const claimFn = deps.claimGeneration ?? claimCasualSummaryGeneration;
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

  const claim = await claimFn({ id: pendingRow.id, pgPool });
  if (!claim.claimed) {
    const current = await getCacheFn({ partidoId: payload.partido_id, sourceType, payloadHash, pgPool });
    if (current?.status === 'generated' && current.response) {
      return buildSummaryResult({ row: current, aiResponse: current.response, payload, cached: true });
    }
    throw new MatchSummaryServiceError('Ya hay una generación de resumen en curso', {
      status: 409,
      code: 'MATCH_SUMMARY_IN_PROGRESS',
    });
  }

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

  const parsed = parseAiSummaryResponse(aiReply, payload);
  let aiResponse = parsed.valid ? parsed.response : null;

  if (!aiResponse) {
    console.warn('[MatchSummary] Respuesta IA no parseable; usando fallback', {
      partido_id: payload.partido_id,
      payload_hash: payloadHash,
      error: parsed.error,
    });
    aiResponse = buildFallbackMatchSummaryResponse({
      payload,
      parseError: parsed.error,
    });
  }

  const generatedRow = await markGeneratedFn({
    id: pendingRow.id,
    response: aiResponse,
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
    aiResponse,
    payload,
    cached: false,
  });
}


// Casual single-flight: two simultaneous requests for the same partido share
// one provider call in this process. A durable queue owns cross-instance
// exactly-once for Nations; this guard prevents the reproduced double spend in
// the existing casual endpoint without changing its stored row contract.
const casualInFlight = new Map();

export async function generateMatchSummaryForPartido(args = {}) {
  const key = `${args.partidoId ?? ''}|${args.userId ?? ''}|${args.force ? 'force' : 'cached'}`;
  const current = casualInFlight.get(key);
  if (current) return current;
  const pending = generateMatchSummaryForPartidoUnlocked(args);
  casualInFlight.set(key, pending);
  try { return await pending; } finally { casualInFlight.delete(key); }
}
