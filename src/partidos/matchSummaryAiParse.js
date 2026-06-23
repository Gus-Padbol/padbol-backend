const EQUIPO_LABELS = {
  equipo1: 'Equipo 1',
  equipo2: 'Equipo 2',
};

const ORDINAL_SET_LABELS = ['primer', 'segundo', 'tercer', 'cuarto', 'quinto'];

function normalizeSetDetail(row) {
  if (!row || typeof row !== 'object') return null;

  const eq1 = Number(row.equipo1 ?? row.eq1);
  const eq2 = Number(row.equipo2 ?? row.eq2);

  if (!Number.isFinite(eq1) || !Number.isFinite(eq2)) return null;

  return { eq1, eq2 };
}

function formatSetScore(set) {
  return `${set.eq1}-${set.eq2}`;
}

function formatParcialesList(sets) {
  if (!sets.length) return '';

  if (sets.length === 1) {
    return formatSetScore(sets[0]);
  }

  const allButLast = sets.slice(0, -1).map(formatSetScore).join(', ');
  const last = formatSetScore(sets[sets.length - 1]);
  return `${allButLast} y ${last}`;
}

function getPerdedorKey(ganadorKey) {
  return ganadorKey === 'equipo1' ? 'equipo2' : 'equipo1';
}

function ganadorGanoSet(ganadorKey, set) {
  if (ganadorKey === 'equipo1') return set.eq1 > set.eq2;
  if (ganadorKey === 'equipo2') return set.eq2 > set.eq1;
  return false;
}

function buildSetsNarrative(ganadorKey, sets) {
  if (!sets.length) return null;

  if (sets.length === 1) {
    return `El set se definió ${formatSetScore(sets[0])}.`;
  }

  if (sets.length === 2) {
    const s1 = sets[0];
    const s2 = sets[1];
    const ganadorGanoS1 = ganadorGanoSet(ganadorKey, s1);

    if (ganadorGanoS1) {
      return `Se impuso en el primer set ${formatSetScore(s1)} y cerró ${formatSetScore(s2)} en el segundo.`;
    }

    return `Perdió el primer set ${formatSetScore(s1)} y reaccionó en el segundo ${formatSetScore(s2)}.`;
  }

  const s1 = sets[0];
  const s2 = sets[1];
  const s3 = sets[2];
  const ganadorGanoS1 = ganadorGanoSet(ganadorKey, s1);
  const ganadorGanoS2 = ganadorGanoSet(ganadorKey, s2);
  const ganadorGanoS3 = ganadorGanoSet(ganadorKey, s3);

  const firstPart = ganadorGanoS1
    ? `Después de llevarse el primer set ${formatSetScore(s1)}`
    : `Tras perder el primer set ${formatSetScore(s1)}`;

  const secondPart = ganadorGanoS2
    ? `ganó el segundo ${formatSetScore(s2)}`
    : `perdió el segundo ${formatSetScore(s2)}`;

  const thirdPart = ganadorGanoS3
    ? `y reaccionó en el tercero para cerrarlo ${formatSetScore(s3)}`
    : `pero no pudo en el tercero (${formatSetScore(s3)})`;

  return `${firstPart}, ${secondPart} ${thirdPart}.`;
}

function formatFechaContext(fecha) {
  if (!fecha) return null;
  const value = String(fecha).slice(0, 10);
  const [year, month, day] = value.split('-');
  if (!year || !month || !day) return value;
  return `${day}/${month}/${year}`;
}

function buildContextSuffix(payload) {
  const sede = payload?.contexto?.sede_nombre ?? null;
  const fecha = formatFechaContext(payload?.contexto?.fecha);

  if (sede && fecha) return ` Partido en ${sede} el ${fecha}.`;
  if (sede) return ` Partido en ${sede}.`;
  if (fecha) return ` Partido disputado el ${fecha}.`;
  return '';
}

function buildSetsSummaryText(payload) {
  const { resultado } = payload;
  const ganadorKey = resultado?.ganador ?? null;
  const ganadorLabel = EQUIPO_LABELS[ganadorKey] ?? 'El ganador';
  const perdedorLabel = EQUIPO_LABELS[getPerdedorKey(ganadorKey)] ?? 'su rival';

  const e1Sets = Number(resultado?.sets?.equipo1_sets) || 0;
  const e2Sets = Number(resultado?.sets?.equipo2_sets) || 0;
  const ganadorSets = ganadorKey === 'equipo1' ? e1Sets : e2Sets;
  const perdedorSets = ganadorKey === 'equipo1' ? e2Sets : e1Sets;

  const setsDetalle = (resultado?.sets?.sets_detalle ?? [])
    .map(normalizeSetDetail)
    .filter(Boolean);

  const closeness = ganadorSets - perdedorSets === 1 ? ' muy parejo' : '';
  let summary = `${ganadorLabel} ganó un partido${closeness} frente a ${perdedorLabel} por ${ganadorSets} sets a ${perdedorSets}.`;

  const narrative = buildSetsNarrative(ganadorKey, setsDetalle);
  if (narrative) {
    summary += ` ${narrative}`;
  }

  summary += buildContextSuffix(payload);
  return summary.trim();
}

function buildPuntosSummaryText(payload) {
  const { resultado } = payload;
  const ganadorKey = resultado?.ganador ?? null;
  const ganadorLabel = EQUIPO_LABELS[ganadorKey] ?? 'El ganador';
  const perdedorLabel = EQUIPO_LABELS[getPerdedorKey(ganadorKey)] ?? 'su rival';
  const marcador = resultado?.marcador_texto
    ?? `${resultado?.puntos_agregados?.equipo1}-${resultado?.puntos_agregados?.equipo2}`;

  let summary = `${ganadorLabel} venció a ${perdedorLabel} por ${String(marcador).replace('-', ' a ')}.`;
  summary += buildContextSuffix(payload);
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

function buildDeterministicHighlights(payload) {
  const { resultado } = payload;
  const highlights = [];
  const ganadorKey = resultado?.ganador ?? null;

  if (!ganadorKey) return highlights;

  const ganadorLabel = EQUIPO_LABELS[ganadorKey];
  const perdedorLabel = EQUIPO_LABELS[getPerdedorKey(ganadorKey)];

  if (resultado.formato === 'sets' && resultado.sets) {
    const e1Sets = Number(resultado.sets.equipo1_sets) || 0;
    const e2Sets = Number(resultado.sets.equipo2_sets) || 0;
    const ganadorSets = ganadorKey === 'equipo1' ? e1Sets : e2Sets;
    const perdedorSets = ganadorKey === 'equipo1' ? e2Sets : e1Sets;

    highlights.push({
      type: 'resultado',
      text: `Resultado final: ${ganadorLabel} ${ganadorSets} - ${perdedorSets} ${perdedorLabel}.`,
    });

    const setsDetalle = (resultado.sets.sets_detalle ?? [])
      .map(normalizeSetDetail)
      .filter(Boolean);

    if (setsDetalle.length > 0) {
      highlights.push({
        type: 'sets',
        text: `Parciales: ${formatParcialesList(setsDetalle)}.`,
      });
    }

    if (setsDetalle.length >= 2) {
      const decidingSet = setsDetalle[setsDetalle.length - 1];
      const ordinal = ORDINAL_SET_LABELS[setsDetalle.length - 1] ?? `${setsDetalle.length}º`;

      if (ganadorGanoSet(ganadorKey, decidingSet)) {
        highlights.push({
          type: 'momento',
          text: `El ${ordinal} set definió el partido a favor de ${ganadorLabel}.`,
        });
      }
    }
  } else if (resultado.marcador_texto) {
    highlights.push({
      type: 'resultado',
      text: `Resultado final: ${resultado.marcador_texto}.`,
    });
  }

  const scoreboard = payload?.scoreboard_opcional;
  if (scoreboard?.duracion_aproximada_minutos != null && highlights.length < 3) {
    highlights.push({
      type: 'contexto',
      text: `Duración aproximada del tanteador: ${scoreboard.duracion_aproximada_minutos} minutos.`,
    });
  }

  return highlights.slice(0, 3);
}

function buildSourceFieldsUsed(payload) {
  const fields = ['contexto', 'equipos', 'resultado'];

  if (payload?.contexto?.sede_nombre) fields.push('contexto.sede_nombre');
  if (payload?.contexto?.fecha) fields.push('contexto.fecha');
  if (payload?.scoreboard_opcional) fields.push('scoreboard_opcional');

  return fields;
}

/**
 * Construye un resumen útil y determinístico a partir del payload del partido.
 * @param {object} payload
 */
export function buildDeterministicMatchSummary(payload) {
  const resultado = payload?.resultado ?? {};
  let summary = 'Partido finalizado con resultado confirmado.';

  if (resultado.formato === 'sets') {
    summary = buildSetsSummaryText(payload);
  } else if (resultado.formato === 'puntos_agregados') {
    summary = buildPuntosSummaryText(payload);
  } else if (resultado.marcador_texto) {
    summary = `El partido terminó ${resultado.marcador_texto}.${buildContextSuffix(payload)}`.trim();
  }

  return {
    title: 'Resumen del partido',
    summary,
    highlights: buildDeterministicHighlights(payload),
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
