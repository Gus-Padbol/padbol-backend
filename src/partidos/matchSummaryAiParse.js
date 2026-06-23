import {
  buildMatchSummaryDeterministicAnalysis,
  formatFechaEspanol,
  formatParcialesList,
  formatSetScoreForTeam,
  ganadorGanoSet,
  getPerdedorKey,
  normalizeSetDetail,
  resolveEquipoLabels,
} from './matchSummaryDeterministicAnalysis.js';

const ORDINAL_SET_LABELS = ['primer', 'segundo', 'tercer', 'cuarto', 'quinto'];

function buildLocationSuffix(analisis) {
  return analisis?.sede ? ` en ${analisis.sede}` : '';
}

function buildFechaSuffix(analisis) {
  if (!analisis?.fecha_espanol) return '';
  if (analisis?.sede) return ` Partido jugado el ${analisis.fecha_espanol}.`;
  return ` Partido disputado el ${analisis.fecha_espanol}.`;
}

function buildSetsSummaryText(payload, analisis) {
  const ganadorKey = analisis?.ganador?.key ?? payload?.resultado?.ganador ?? null;
  const ganadorLabel = analisis?.ganador?.nombre ?? 'El ganador';
  const perdedorLabel = analisis?.perdedor?.nombre ?? 'su rival';
  const setsDetalle = analisis?.sets_detalle ?? [];
  const resultadoSets = analisis?.resultado_final_sets;

  if (!ganadorKey || !resultadoSets) {
    return 'Partido finalizado con resultado confirmado.';
  }

  let summary = `${ganadorLabel} venció a ${perdedorLabel} por ${resultadoSets.texto_sets}${buildLocationSuffix(analisis)}.`;

  if (analisis.fue_2_1 && setsDetalle.length >= 3 && analisis.perdedor_reacciono_segundo_set) {
    const s1 = setsDetalle[0];
    const s2 = setsDetalle[1];
    const s3 = setsDetalle[2];

    summary += ` Fue un partido cambiante: ${ganadorLabel} se llevó el primer set ${formatSetScoreForTeam(ganadorKey, s1)}, ${perdedorLabel} reaccionó en el segundo ${formatSetScoreForTeam(analisis.perdedor.key, s2)} y forzó la definición, pero ${ganadorLabel} recuperó el control en el tercero para cerrarlo ${formatSetScoreForTeam(ganadorKey, s3)}.`;
  } else if (analisis.fue_2_0 && setsDetalle.length >= 2) {
    const s1 = setsDetalle[0];
    const s2 = setsDetalle[1];
    summary += ` ${ganadorLabel} dominó el encuentro con parciales ${formatSetScoreForTeam(ganadorKey, s1)} y ${formatSetScoreForTeam(ganadorKey, s2)}.`;
  } else if (setsDetalle.length === 1) {
    summary += ` El partido se definió en un solo set (${formatSetScoreForTeam(ganadorKey, setsDetalle[0])}).`;
  } else if (analisis.parciales_texto) {
    summary += ` Parciales: ${analisis.parciales_texto}.`;
  }

  if (analisis?.duracion_minutos > 0) {
    summary += ` Duración aproximada: ${analisis.duracion_minutos} minutos.`;
  }

  summary += buildFechaSuffix(analisis);
  return summary.trim();
}

function buildPuntosSummaryText(payload, analisis) {
  const ganadorLabel = analisis?.ganador?.nombre ?? 'El ganador';
  const perdedorLabel = analisis?.perdedor?.nombre ?? 'su rival';
  const marcador = analisis?.marcador_texto
    ?? payload?.resultado?.marcador_texto
    ?? `${payload?.resultado?.puntos_agregados?.equipo1}-${payload?.resultado?.puntos_agregados?.equipo2}`;

  let summary = `${ganadorLabel} venció a ${perdedorLabel} por ${String(marcador).replace('-', ' a ')}${buildLocationSuffix(analisis)}.`;
  summary += buildFechaSuffix(analisis);
  return summary.trim();
}

function buildFallbackDisclaimers(payload) {
  const disclaimers = payload?.disclaimers ?? {};
  const visible = [];

  if (payload?.confirmacion?.estado === 'confirmado' && disclaimers.resultado_cargado_por_capitanes) {
    visible.push(disclaimers.resultado_cargado_por_capitanes);
  }

  return visible.slice(0, 2);
}

function buildDeterministicHighlights(payload, analisis) {
  const highlights = [];
  const ganadorKey = analisis?.ganador?.key ?? payload?.resultado?.ganador ?? null;

  if (!ganadorKey) return highlights;

  const ganadorLabel = analisis?.ganador?.nombre;
  const perdedorLabel = analisis?.perdedor?.nombre;
  const resultadoSets = analisis?.resultado_final_sets;

  if (payload?.resultado?.formato === 'sets' && resultadoSets) {
    highlights.push({
      type: 'resultado',
      text: `Resultado final: ${ganadorLabel} ${resultadoSets.texto} ${perdedorLabel}.`,
    });

    if (analisis?.parciales_texto) {
      highlights.push({
        type: 'sets',
        text: `Parciales: ${analisis.parciales_texto}.`,
      });
    }

    if (analisis?.tercer_set_decisivo) {
      highlights.push({
        type: 'momento',
        text: 'El tercer set definió el partido.',
      });
    } else if (analisis?.fue_2_0 && analisis?.set_mas_dominante?.parcial) {
      highlights.push({
        type: 'momento',
        text: `El set más dominante fue el ${ORDINAL_SET_LABELS[analisis.set_mas_dominante.indice - 1] ?? analisis.set_mas_dominante.indice} (${analisis.set_mas_dominante.parcial}).`,
      });
    }
  } else if (payload?.resultado?.marcador_texto) {
    highlights.push({
      type: 'resultado',
      text: `Resultado final: ${payload.resultado.marcador_texto}.`,
    });
  }

  if (analisis?.duracion_minutos > 0 && highlights.length < 3) {
    highlights.push({
      type: 'contexto',
      text: `Duración aproximada del tanteador: ${analisis.duracion_minutos} minutos.`,
    });
  }

  return highlights.slice(0, 3);
}

function buildSourceFieldsUsed(payload) {
  const fields = ['contexto', 'equipos', 'resultado', 'analisis_previo'];

  if (payload?.contexto?.sede_nombre) fields.push('contexto.sede_nombre');
  if (payload?.contexto?.fecha) fields.push('contexto.fecha');
  if (payload?.scoreboard_opcional) fields.push('scoreboard_opcional');
  if (payload?.analisis_previo?.duracion_minutos > 0) {
    fields.push('analisis_previo.duracion_minutos');
  }

  return fields;
}

/**
 * Construye un resumen deportivo determinístico a partir del payload del partido.
 * @param {object} payload
 */
export function buildDeterministicMatchSummary(payload) {
  const analisis = payload?.analisis_previo ?? buildMatchSummaryDeterministicAnalysis(payload);
  const resultado = payload?.resultado ?? {};
  let summary = 'Partido finalizado con resultado confirmado.';

  if (resultado.formato === 'sets') {
    summary = buildSetsSummaryText(payload, analisis);
  } else if (resultado.formato === 'puntos_agregados') {
    summary = buildPuntosSummaryText(payload, analisis);
  } else if (resultado.marcador_texto) {
    summary = `El partido terminó ${resultado.marcador_texto}.${buildFechaSuffix(analisis)}`.trim();
  }

  return {
    title: 'Resumen del partido',
    summary,
    highlights: buildDeterministicHighlights(payload, analisis),
    disclaimers: buildFallbackDisclaimers(payload),
    source_fields_used: buildSourceFieldsUsed(payload),
    analisis: '',
  };
}

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

/**
 * @param {{ payload?: object|null, parseError?: string|null }|string|null} input
 */
export function buildFallbackMatchSummaryResponse(input = null) {
  const payload = typeof input === 'object' && input !== null && !Array.isArray(input)
    ? (input.payload ?? null)
    : null;
  const parseError = typeof input === 'object' && input !== null && !Array.isArray(input)
    ? (input.parseError ?? null)
    : (typeof input === 'string' ? input : null);

  const base = payload?.resultado && payload.resultado.formato !== 'desconocido'
    ? buildDeterministicMatchSummary(payload)
    : {
      title: 'Resumen del partido',
      summary: payload?.contexto?.sede_nombre
        ? `Partido disputado en ${payload.contexto.sede_nombre}.`
        : 'Partido finalizado.',
      highlights: [],
      disclaimers: [],
      source_fields_used: payload ? buildSourceFieldsUsed(payload) : [],
      analisis: '',
    };

  return {
    ...base,
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

export { formatFechaEspanol, formatParcialesList, normalizeSetDetail, resolveEquipoLabels };
