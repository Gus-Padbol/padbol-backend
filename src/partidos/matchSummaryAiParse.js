const FALLBACK_SUMMARY_TEXT =
  'No pudimos generar un análisis completo, pero el partido fue procesado correctamente.';

export function extractJsonFromAiResponse(rawText) {
  const text = String(rawText ?? '').trim();
  if (!text) return [];

  const candidates = [];

  candidates.push(text);

  const fencedFull = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fencedFull?.[1]) {
    candidates.push(fencedFull[1].trim());
  }

  for (const match of text.matchAll(/```(?:json)?\s*([\s\S]*?)\s*```/gi)) {
    if (match[1]?.trim()) {
      candidates.push(match[1].trim());
    }
  }

  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    candidates.push(text.slice(firstBrace, lastBrace + 1));
  }

  return [...new Set(candidates.filter(Boolean))];
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

export function buildFallbackMatchSummaryResponse(parseError = null) {
  return {
    title: 'Resumen del partido',
    summary: FALLBACK_SUMMARY_TEXT,
    highlights: [],
    disclaimers: ['Resumen generado con fallback por respuesta IA no parseable.'],
    source_fields_used: [],
    analisis: '',
    metadata: {
      fallback: true,
      parse_error: parseError ?? null,
    },
  };
}

/**
 * @param {string} rawReply
 * @returns {{ valid: true, response: object, fallback?: boolean } | { valid: false, error: string }}
 */
export function parseAiSummaryResponse(rawReply) {
  const candidates = extractJsonFromAiResponse(rawReply);

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      const validated = validateAiSummaryResponse(parsed);
      if (validated.valid) {
        return validated;
      }
    } catch {
      // try next candidate
    }
  }

  let lastValidationError = 'Respuesta IA no es JSON válido';
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      const validated = validateAiSummaryResponse(parsed);
      if (!validated.valid) {
        lastValidationError = validated.error;
      }
    } catch {
      // ignore
    }
  }

  return { valid: false, error: lastValidationError };
}
