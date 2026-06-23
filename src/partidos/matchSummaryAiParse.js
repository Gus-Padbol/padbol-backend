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

const EMAIL_RE = /\b[\w.+-]+@[\w.-]+\.[a-z]{2,}\b/i;

const FRASES_RESPALDADAS = [
  { pattern: /partido cambiante/i, flag: 'partido_cambiante' },
  { pattern: /partido ajustado|muy disputado|muy parejo|duelo fue cambiante/i, flag: 'partido_ajustado' },
  { pattern: /reaccionó en el segundo/i, flag: 'reaccion_segundo_parcial' },
  { pattern: /(dominó|de principio a fin|sin ceder sets|actuación sólida)/i, flag: 'dominio_claro', requires2_0: true },
  { pattern: /(cerró mejor|cerró con autoridad|mostró mayor firmeza)/i, flag: 'cierre_con_autoridad' },
  { pattern: /(compitió a buen nivel|compitió a gran nivel|sostuvo un nivel)/i, flag: 'buen_nivel_perdedor' },
  { pattern: /tercer set/i, flag: 'definido_en_tercer_set' },
];

function stablePickVariant(seed, count) {
  let hash = 0;
  const str = String(seed ?? '0');
  for (let i = 0; i < str.length; i += 1) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash) % Math.max(1, count);
}

function buildFechaSuffix(analisis) {
  if (!analisis?.fecha_espanol) return '';
  if (analisis?.sede) return ` Partido jugado el ${analisis.fecha_espanol}.`;
  return ` Partido disputado el ${analisis.fecha_espanol}.`;
}

function buildParejoSuffix(analisis) {
  if (!analisis?.partido_parejo && !analisis?.frases_sugeridas?.buen_nivel_perdedor) {
    return '';
  }

  return ` ${analisis.perdedor.nombre} compitió a buen nivel y exigió hasta el cierre, pero ${analisis.ganador.nombre} fue más efectivo en los momentos decisivos.`;
}

function buildDuracionSuffix(analisis) {
  if (!(analisis?.duracion_minutos > 0)) return '';
  return ` Duración aproximada: ${analisis.duracion_minutos} minutos.`;
}

function formatTeamReference(name, preposition = 'a') {
  const value = String(name ?? '').trim();
  if (!value) return preposition === 'a' ? 'a su rival' : value;
  if (preposition === 'a' && value.startsWith('el ')) {
    return `al ${value.slice(4)}`;
  }
  return `${preposition} ${value}`;
}

function buildTemplateContext(analisis) {
  const setsDetalle = analisis.sets_detalle ?? [];
  const ganadorKey = analisis.ganador.key;
  const perdedorKey = analisis.perdedor.key;

  return {
    ganador: analisis.ganador.nombre,
    perdedor: analisis.perdedor.nombre,
    perdedorRef: formatTeamReference(analisis.perdedor.nombre, 'a'),
    sede: analisis.sede,
    location: analisis.sede ? ` en ${analisis.sede}` : '',
    textoSets: analisis.resultado_final_sets.texto_sets,
    parciales: analisis.parciales_texto,
    set1: setsDetalle[0] ? formatSetScoreForTeam(ganadorKey, setsDetalle[0]) : null,
    set2: setsDetalle[1] ? formatSetScoreForTeam(perdedorKey, setsDetalle[1]) : null,
    set3: setsDetalle[2] ? formatSetScoreForTeam(ganadorKey, setsDetalle[2]) : null,
  };
}

function buildSetsSummaryFromTemplates(payload, analisis) {
  const ctx = buildTemplateContext(analisis);
  const seed = payload?.partido_id ?? payload?.contexto?.fecha ?? '0';
  let summary = '';

  if (analisis.plantilla_fallback === '2_1_ajustado') {
    const variants = [
      `${ctx.ganador} se impuso ${ctx.perdedorRef} por ${ctx.textoSets}${ctx.location}, en un partido cambiante y muy disputado. ${ctx.ganador} arrancó mejor y se llevó el primer set ${ctx.set1}, ${ctx.perdedor} reaccionó en el segundo parcial ${ctx.set2}, pero ${ctx.ganador} recuperó el control en el tercero y lo cerró ${ctx.set3}.`,
      `En un partido ajustado${ctx.location}, ${ctx.ganador} terminó imponiéndose ${ctx.perdedorRef} por ${ctx.textoSets}. El duelo fue cambiante: ${ctx.ganador} ganó el primer set ${ctx.set1}, ${ctx.perdedor} respondió en el segundo ${ctx.set2} y la definición quedó para el tercero, donde ${ctx.ganador} cerró ${ctx.set3}.`,
    ];
    summary = variants[stablePickVariant(seed, variants.length)];
  } else if (analisis.plantilla_fallback === '2_1_cierre_fuerte') {
    const variants = [
      `${ctx.ganador} tuvo que trabajar hasta el final para vencer ${ctx.perdedorRef} por ${ctx.textoSets}. Tras repartirse los dos primeros parciales (${ctx.set1} y ${ctx.set2}), el partido se definió en el tercer set, donde ${ctx.ganador} mostró mayor firmeza y cerró la victoria ${ctx.set3}.`,
      `${ctx.ganador} se impuso ${ctx.perdedorRef} por ${ctx.textoSets}${ctx.location}. ${ctx.perdedor} empujó en el segundo set (${ctx.set2}), pero ${ctx.ganador} cerró mejor en el tercero y se llevó el partido ${ctx.set3}.`,
    ];
    summary = variants[stablePickVariant(`${seed}-cierre`, variants.length)];
  } else if (analisis.plantilla_fallback === '2_0_claro') {
    const variants = [
      `${ctx.ganador} venció ${ctx.perdedorRef} por ${ctx.textoSets}${ctx.location}, con una actuación sólida de principio a fin. Los parciales ${ctx.set1} y ${ctx.set2} reflejaron su superioridad y le permitieron cerrar el partido sin ceder sets.`,
      `${ctx.ganador} dominó de principio a fin ${ctx.perdedorRef} por ${ctx.textoSets}${ctx.location}. Con parciales ${ctx.set1} y ${ctx.set2}, controló el ritmo del encuentro y no cedió sets.`,
    ];
    summary = variants[stablePickVariant(`${seed}-20`, variants.length)];
  } else if (analisis.plantilla_fallback === '2_0_solido') {
    summary = `${ctx.ganador} venció ${ctx.perdedorRef} por ${ctx.textoSets}${ctx.location}. Se impuso en los dos sets (${ctx.set1} y ${ctx.set2}) y cerró el partido sin ceder parciales.`;
  } else if (analisis.sets_detalle?.length === 1) {
    summary = `${ctx.ganador} venció ${ctx.perdedorRef} por ${ctx.textoSets}${ctx.location}. El partido se definió en un solo set (${ctx.set1}).`;
  } else {
    summary = `${ctx.ganador} venció ${ctx.perdedorRef} por ${ctx.textoSets}${ctx.location}. Parciales: ${ctx.parciales}.`;
  }

  if (analisis.fue_2_1 && analisis.partido_parejo) {
    summary += buildParejoSuffix(analisis);
  }

  summary += buildDuracionSuffix(analisis);
  summary += buildFechaSuffix(analisis);
  return summary.trim();
}

function buildPuntosSummaryText(payload, analisis) {
  const ganadorLabel = analisis?.ganador?.nombre ?? 'El ganador';
  const perdedorLabel = analisis?.perdedor?.nombre ?? 'su rival';
  const marcador = analisis?.marcador_texto
    ?? payload?.resultado?.marcador_texto
    ?? `${payload?.resultado?.puntos_agregados?.equipo1}-${payload?.resultado?.puntos_agregados?.equipo2}`;

  const perdedorRef = formatTeamReference(perdedorLabel, 'a');
  const seed = payload?.partido_id ?? '0';
  const variants = [
    `${ganadorLabel} se impuso ${perdedorRef} por ${String(marcador).replace('-', ' a ')}${analisis?.sede ? ` en ${analisis.sede}` : ''}.`,
    `En ${analisis?.sede ?? 'el partido'}, ${ganadorLabel} venció ${perdedorRef} por ${String(marcador).replace('-', ' a ')}.`,
  ];

  let summary = variants[stablePickVariant(seed, variants.length)];
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
  const perdedorKey = analisis?.perdedor?.key;
  const resultadoSets = analisis?.resultado_final_sets;
  const setsDetalle = analisis?.sets_detalle ?? [];

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
    } else if (analisis?.perdedor_reacciono_segundo_set && setsDetalle[1]) {
      highlights.push({
        type: 'momento',
        text: `${perdedorLabel} reaccionó en el segundo set (${formatSetScoreForTeam(perdedorKey, setsDetalle[1])}).`,
      });
    } else if (analisis?.ganador_cerro_fuerte_ultimo_set && setsDetalle.length) {
      const last = setsDetalle[setsDetalle.length - 1];
      highlights.push({
        type: 'momento',
        text: `${ganadorLabel} cerró mejor el último set (${formatSetScoreForTeam(ganadorKey, last)}).`,
      });
    } else if (analisis?.fue_2_0) {
      highlights.push({
        type: 'momento',
        text: `${ganadorLabel} no cedió sets en el partido.`,
      });
    }
  } else if (payload?.resultado?.marcador_texto) {
    highlights.push({
      type: 'resultado',
      text: `Resultado final: ${payload.resultado.marcador_texto}.`,
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
    summary = buildSetsSummaryFromTemplates(payload, analisis);
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

  const candidates = [text];

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

export function countSummarySentences(text) {
  return String(text ?? '')
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 3)
    .length;
}

function resolveAnalisisForValidation(payload) {
  return payload?.analisis_previo ?? buildMatchSummaryDeterministicAnalysis(payload);
}

function summaryMentionsParciales(summary, analisis) {
  const parciales = analisis?.parciales ?? [];
  if (!parciales.length) return true;

  const hits = parciales.filter((parcial) => String(summary ?? '').includes(parcial)).length;
  return hits >= Math.min(2, parciales.length);
}

function highlightsIncludeParciales(highlights, analisis) {
  if (!analisis?.parciales_texto) return true;

  return (highlights ?? []).some((highlight) => (
    highlight?.type === 'sets'
    || /Parciales:/i.test(String(highlight?.text ?? ''))
  ));
}

function combinedSummaryHighlightsText(summary, highlights) {
  const highlightText = (highlights ?? []).map((item) => item?.text ?? '').join(' ');
  return `${summary ?? ''} ${highlightText}`.trim();
}

function summaryContainsEmail(text) {
  return EMAIL_RE.test(String(text ?? ''));
}

function summaryUsesUnsupportedPhrases(summary, analisis) {
  const frases = analisis?.frases_sugeridas ?? {};
  const text = String(summary ?? '');

  for (const rule of FRASES_RESPALDADAS) {
    if (!rule.pattern.test(text)) continue;
    if (rule.requires2_0 && !analisis?.fue_2_0) {
      return true;
    }
    if (rule.flag && frases[rule.flag] === false) {
      return true;
    }
  }

  return false;
}

function summaryIsTooGeneric(summary, analisis) {
  const text = String(summary ?? '').trim();
  if (!text) return true;

  const genericPatterns = [
    /^Equipo \d ganó\b/i,
    /^Equipo \d venció a Equipo \d por 2 a 1\.?$/i,
    /^Equipo \d venció a Equipo \d por 2 sets a 1\.?$/i,
  ];

  if (genericPatterns.some((pattern) => pattern.test(text))) {
    return true;
  }

  if (analisis?.parciales?.length && !summaryMentionsParciales(text, analisis)) {
    return true;
  }

  return false;
}

/**
 * Rechaza respuestas IA demasiado pobres cuando hay parciales de sets.
 * @param {object|null} payload
 * @param {object} response
 */
export function validateAiSummaryQuality(payload, response) {
  const analisis = resolveAnalisisForValidation(payload);
  const summary = response?.summary ?? '';
  const highlights = response?.highlights ?? [];

  if (summaryContainsEmail(summary) || summaryContainsEmail(JSON.stringify(highlights))) {
    return { valid: false, error: 'summary contiene emails visibles' };
  }

  if (summaryUsesUnsupportedPhrases(summary, analisis)) {
    return { valid: false, error: 'summary usa frases no respaldadas por analisis_previo' };
  }

  if (payload?.resultado?.formato !== 'sets') {
    if (summaryIsTooGeneric(summary, analisis)) {
      return { valid: false, error: 'summary demasiado genérico' };
    }
    return { valid: true };
  }

  const parciales = analisis?.parciales ?? [];
  if (!parciales.length) {
    return { valid: true };
  }

  const sentenceCount = countSummarySentences(summary);
  if (sentenceCount < 2) {
    return {
      valid: false,
      error: 'summary demasiado breve para partido con parciales (mínimo 2 frases)',
    };
  }

  if (sentenceCount > 4) {
    return {
      valid: false,
      error: 'summary excede 4 frases para partido con parciales',
    };
  }

  if (summaryIsTooGeneric(summary, analisis)) {
    return { valid: false, error: 'summary demasiado genérico para partido con parciales' };
  }

  if (!summaryMentionsParciales(summary, analisis)) {
    return {
      valid: false,
      error: 'summary no menciona parciales cuando existen',
    };
  }

  if (!highlightsIncludeParciales(highlights, analisis)) {
    return {
      valid: false,
      error: 'highlights no incluyen parciales cuando existen',
    };
  }

  if (analisis?.tercer_set_decisivo) {
    const combined = combinedSummaryHighlightsText(summary, highlights);
    if (!/tercer/i.test(combined)) {
      return {
        valid: false,
        error: 'summary/highlights no mencionan el tercer set decisivo',
      };
    }
  }

  return { valid: true };
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
 * @param {object|null} [payload]
 * @returns {{ valid: true, response: object, fallback?: boolean } | { valid: false, error: string }}
 */
export function parseAiSummaryResponse(rawReply, payload = null) {
  const candidates = extractJsonFromAiResponse(rawReply);
  let lastValidationError = 'Respuesta IA no es JSON válido';

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      const validated = validateAiSummaryResponse(parsed);
      if (!validated.valid) {
        lastValidationError = validated.error;
        continue;
      }

      const quality = payload
        ? validateAiSummaryQuality(payload, validated.response)
        : { valid: true };

      if (quality.valid) {
        return validated;
      }

      lastValidationError = quality.error;
    } catch {
      // try next candidate
    }
  }

  return { valid: false, error: lastValidationError };
}

export { formatFechaEspanol, formatParcialesList, normalizeSetDetail, resolveEquipoLabels };
