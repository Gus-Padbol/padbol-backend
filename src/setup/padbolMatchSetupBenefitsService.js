import { listPremiosCanjeables } from '../padcoins/premiosCanjeablesService.js';
import { evaluateBenefitReservationMetrics, BENEFIT_REACHABILITY } from '../padcoins/padcoinsLoyaltyPolicyService.js';

/** Umbral orientativo interno — no exponer equivalencia al jugador. */
const HIGH_PADCOINS_THRESHOLD = 1200;
const MIN_CLEAR_NAME_LENGTH = 3;

export const BENEFIT_LOYALTY_CATEGORIES = Object.freeze({
  TURNO: 'turno_fidelizacion',
  BEBIDA: 'consumo_post_partido',
  CLASE: 'clase_academia',
  TORNEO: 'torneo_evento',
  MERCH: 'merchandising_marca',
  PRIORIDAD: 'prioridad_reserva',
  GENERIC: 'generico',
  PRODUCTO_DEBIL: 'producto_sin_vinculo',
});

const CATEGORY_DETECTORS = [
  {
    category: BENEFIT_LOYALTY_CATEGORIES.TURNO,
    keywords: ['turno', 'reserva', 'descuento', 'proximo', 'próximo', 'volver', 'siguiente'],
    score: 5,
  },
  {
    category: BENEFIT_LOYALTY_CATEGORIES.BEBIDA,
    keywords: ['bebida', 'agua', 'gatorade', 'post partido', 'hidrat'],
    score: 4,
  },
  {
    category: BENEFIT_LOYALTY_CATEGORIES.CLASE,
    keywords: ['clase', 'academia', 'clinica', 'clínica', 'entrenamiento', 'grupal'],
    score: 5,
  },
  {
    category: BENEFIT_LOYALTY_CATEGORIES.TORNEO,
    keywords: ['torneo', 'inscripcion', 'inscripción', 'evento', 'copa'],
    score: 5,
  },
  {
    category: BENEFIT_LOYALTY_CATEGORIES.PRIORIDAD,
    keywords: ['prioridad', 'horario especial', 'slot', 'anticipada'],
    score: 5,
  },
  {
    category: BENEFIT_LOYALTY_CATEGORIES.MERCH,
    keywords: ['remera', 'merchandising', 'indumentaria', 'camiseta', 'padbol'],
    score: 3,
  },
];

const RETURN_LOYALTY_CATEGORIES = new Set([
  BENEFIT_LOYALTY_CATEGORIES.TURNO,
  BENEFIT_LOYALTY_CATEGORIES.CLASE,
  BENEFIT_LOYALTY_CATEGORIES.TORNEO,
  BENEFIT_LOYALTY_CATEGORIES.PRIORIDAD,
  BENEFIT_LOYALTY_CATEGORIES.BEBIDA,
]);

const REACHABLE_LEVELS = new Set([
  BENEFIT_REACHABILITY.MUY_FACIL,
  BENEFIT_REACHABILITY.BUENA,
]);

const ASPIRATIONAL_LEVELS = new Set([
  BENEFIT_REACHABILITY.ASPIRACIONAL,
  BENEFIT_REACHABILITY.DEMASIADO_LEJANO,
]);

const WEAK_PRODUCT_KEYWORDS = [
  'producto',
  'articulo',
  'artículo',
  'tienda',
  'venta',
  'compra',
  'retail',
];

const SUGGESTED_INITIAL_BENEFITS = Object.freeze([
  {
    name: 'Bebida post partido',
    category: BENEFIT_LOYALTY_CATEGORIES.BEBIDA,
    why: 'Refuerza el hábito de volver tras jugar, con un consumo pequeño bien ubicado.',
    suggested_padcoins_range: { min: 100, max: 250 },
    loyalty_goal: 'retorno_post_partido',
  },
  {
    name: 'Descuento en próximo turno',
    category: BENEFIT_LOYALTY_CATEGORIES.TURNO,
    why: 'Incentiva reservar de nuevo en la misma sede.',
    suggested_padcoins_range: { min: 300, max: 600 },
    loyalty_goal: 'repeticion_reserva',
  },
  {
    name: 'Clase grupal o clínica',
    category: BENEFIT_LOYALTY_CATEGORIES.CLASE,
    why: 'Vincula al jugador con la academia y la comunidad de la sede.',
    suggested_padcoins_range: { min: 400, max: 900 },
    loyalty_goal: 'participacion_academia',
  },
  {
    name: 'Inscripción parcial a torneo',
    category: BENEFIT_LOYALTY_CATEGORIES.TORNEO,
    why: 'Promueve competir y volver por nuevas ediciones.',
    suggested_padcoins_range: { min: 500, max: 1200 },
    loyalty_goal: 'competencia_recurrente',
  },
  {
    name: 'Remera o merchandising Padbol',
    category: BENEFIT_LOYALTY_CATEGORIES.MERCH,
    why: 'Refuerza identidad y pertenencia sin convertir el catálogo en tienda.',
    suggested_padcoins_range: { min: 600, max: 1000 },
    loyalty_goal: 'pertenencia_marca',
  },
  {
    name: 'Prioridad en reserva de horarios especiales',
    category: BENEFIT_LOYALTY_CATEGORIES.PRIORIDAD,
    why: 'Premia la fidelización con acceso preferencial a turnos demandados.',
    suggested_padcoins_range: { min: 350, max: 800 },
    loyalty_goal: 'retencion_horarios_pico',
  },
]);

function normalizeText(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '');
}

function benefitTextBlob(premio) {
  return normalizeText(`${premio?.nombre ?? ''} ${premio?.descripcion ?? ''} ${premio?.condiciones ?? ''}`);
}

export function detectBenefitLoyaltyProfile(premio) {
  const text = benefitTextBlob(premio);

  for (const detector of CATEGORY_DETECTORS) {
    if (detector.keywords.some((kw) => text.includes(normalizeText(kw)))) {
      return {
        category: detector.category,
        loyalty_score: detector.score,
      };
    }
  }

  if (WEAK_PRODUCT_KEYWORDS.some((kw) => text.includes(normalizeText(kw)))) {
    return {
      category: BENEFIT_LOYALTY_CATEGORIES.PRODUCTO_DEBIL,
      loyalty_score: 1,
    };
  }

  return {
    category: BENEFIT_LOYALTY_CATEGORIES.GENERIC,
    loyalty_score: 2,
  };
}

function evaluateSingleBenefit(premio, context = {}) {
  const warnings = [];
  const nombre = String(premio?.nombre ?? '').trim();
  const costo = Number(premio?.costo_padcoins);
  const profile = detectBenefitLoyaltyProfile(premio);

  if (nombre.length < MIN_CLEAR_NAME_LENGTH) {
    warnings.push({
      code: 'nombre_poco_claro',
      message: 'El beneficio necesita un nombre claro para el jugador.',
      premio_id: premio?.id ?? null,
    });
  }

  if (!Number.isFinite(costo) || costo <= 0) {
    warnings.push({
      code: 'costo_padcoins_invalido',
      message: 'El beneficio debe tener un costo en PadCoins mayor a cero.',
      premio_id: premio?.id ?? null,
    });
  }

  if (premio?.stock_disponible != null && Number(premio.stock_disponible) <= 0) {
    warnings.push({
      code: 'sin_stock_disponible',
      message: 'El beneficio no tiene stock disponible.',
      premio_id: premio?.id ?? null,
    });
  }

  if (premio?.stock_total != null && Number(premio.stock_total) <= 0) {
    warnings.push({
      code: 'sin_stock_total',
      message: 'El beneficio no tiene stock configurado.',
      premio_id: premio?.id ?? null,
    });
  }

  if (Number.isFinite(costo) && costo > HIGH_PADCOINS_THRESHOLD) {
    warnings.push({
      code: 'costo_padcoins_alto',
      message: 'El costo en PadCoins parece alto para el valor de fidelización percibido.',
      premio_id: premio?.id ?? null,
    });
  }

  if (profile.loyalty_score < 3) {
    warnings.push({
      code: 'bajo_impacto_fidelizacion',
      message: 'El beneficio no incentiva claramente volver a jugar o participar en la sede.',
      premio_id: premio?.id ?? null,
    });
  }

  if (profile.category === BENEFIT_LOYALTY_CATEGORIES.PRODUCTO_DEBIL) {
    warnings.push({
      code: 'orientado_producto',
      message: 'Parece orientado a producto sin vínculo con juego o comunidad.',
      premio_id: premio?.id ?? null,
    });
  }

  if (!premio?.condiciones && !premio?.descripcion) {
    warnings.push({
      code: 'sin_condiciones',
      message: 'Conviene aclarar condiciones o descripción para el jugador.',
      premio_id: premio?.id ?? null,
    });
  }

  const reservationEval = evaluateBenefitReservationMetrics(premio, {
    turn_price: context.turn_price,
    loyalty_percentage: context.loyalty_percentage,
  });
  if (reservationEval.warnings.length > 0) {
    warnings.push(...reservationEval.warnings);
  }

  return {
    id: premio?.id ?? null,
    nombre: nombre || null,
    costo_padcoins: Number.isFinite(costo) ? costo : null,
    category: profile.category,
    loyalty_score: profile.loyalty_score,
    warnings,
    reference_value: reservationEval.reference?.value ?? null,
    reference_source: reservationEval.reference?.source ?? null,
    reservation_metrics: reservationEval.metrics,
    reachability: reservationEval.reachability ?? null,
  };
}

function suggestionMatchesExisting(suggestion, premios) {
  const suggestionText = normalizeText(suggestion.name);

  return premios.some((premio) => {
    const text = benefitTextBlob(premio);
    const suggestionWords = suggestionText.split(/\s+/).filter((w) => w.length > 3);
    const matches = suggestionWords.filter((word) => text.includes(word));
    return matches.length >= 2 || text.includes(suggestionText);
  });
}

export function getSuggestedInitialBenefits() {
  return SUGGESTED_INITIAL_BENEFITS.map((item) => ({ ...item }));
}

export function evaluateBenefitsList(premios = [], context = {}) {
  const items = premios.map((premio) => evaluateSingleBenefit(premio, context));
  const warnings = items.flatMap((item) => item.warnings);

  const weakCount = items.filter((item) => item.loyalty_score < 3).length;
  if (premios.length >= 3 && weakCount >= 3) {
    warnings.push({
      code: 'exceso_productos_debiles',
      message: 'Hay varios beneficios con poco vínculo con juego o comunidad. Priorizá turnos, clases o eventos.',
      premio_id: null,
    });
  }

  const itemsWithReachability = items.filter((item) => item.reachability != null);
  if (itemsWithReachability.length >= 2) {
    const hasReachable = itemsWithReachability.some((item) => REACHABLE_LEVELS.has(item.reachability));
    const allAspirational = itemsWithReachability.every((item) => ASPIRATIONAL_LEVELS.has(item.reachability));
    if (!hasReachable && allAspirational) {
      warnings.push({
        code: 'faltan_beneficios_alcanzables',
        message: 'Todos los beneficios son aspiracionales o lejanos. Sumá al menos uno alcanzable (2 a 8 reservas estimadas).',
        premio_id: null,
      });
    }
  }

  const hasReturnBenefit = items.some(
    (item) => RETURN_LOYALTY_CATEGORIES.has(item.category) && item.loyalty_score >= 3,
  );
  const allWeakProducts = premios.length >= 2
    && items.every((item) => (
      item.category === BENEFIT_LOYALTY_CATEGORIES.PRODUCTO_DEBIL
      || item.loyalty_score < 3
    ));
  if (allWeakProducts && !hasReturnBenefit) {
    warnings.push({
      code: 'faltan_beneficios_retorno',
      message: 'Faltan beneficios de retorno: próximo turno, clase, torneo, evento o prioridad de reserva.',
      premio_id: null,
    });
  }

  const strongCount = items.filter((item) => item.loyalty_score >= 4).length;
  let loyalty_quality = 'none';

  if (premios.length === 0) {
    loyalty_quality = 'none';
  } else if (strongCount > 0 && warnings.length === 0) {
    loyalty_quality = 'good';
  } else if (strongCount > 0 || items.some((item) => item.loyalty_score >= 3)) {
    loyalty_quality = 'partial';
  } else {
    loyalty_quality = 'poor';
  }

  return {
    count: premios.length,
    has_benefits: premios.length > 0,
    items,
    warnings,
    loyalty_quality,
    strong_count: strongCount,
    weak_count: weakCount,
  };
}

export async function evaluateBenefitsForSede(supabaseAdmin, sedeId) {
  const premios = await listPremiosCanjeables(supabaseAdmin, { sede_id: sedeId });
  return buildBenefitsSetupRecommendations(premios);
}

export function buildBenefitsSetupRecommendations(premios = [], context = {}) {
  const evaluation = evaluateBenefitsList(premios, context);
  const recommendations = getSuggestedInitialBenefits()
    .filter((suggestion) => !suggestionMatchesExisting(suggestion, premios));

  return {
    ...evaluation,
    recommendations,
  };
}

export async function buildBenefitsSetupRecommendationsForSede(supabaseAdmin, sedeId, context = {}) {
  const premios = await listPremiosCanjeables(supabaseAdmin, { sede_id: sedeId });
  return buildBenefitsSetupRecommendations(premios, context);
}

export function buildBeneficiosSectionPayload(flags) {
  const benefits = flags?.meta?.benefits_evaluation
    ?? flags?.benefits_evaluation
    ?? evaluateBenefitsList([]);

  const hasBenefits = benefits.has_benefits === true;
  const hasWarnings = (benefits.warnings?.length ?? 0) > 0;

  let status = 'missing';
  if (hasBenefits && !hasWarnings && benefits.loyalty_quality === 'good') {
    status = 'ok';
  } else if (hasBenefits) {
    status = 'partial';
  }

  let detail = 'Sin beneficios canjeables en la sede';
  if (hasBenefits && benefits.loyalty_quality === 'good' && !hasWarnings) {
    detail = `${benefits.count} beneficio(s) alineados con fidelización`;
  } else if (hasBenefits && hasWarnings) {
    detail = `${benefits.count} beneficio(s) cargados con alertas de mejora`;
  } else if (hasBenefits) {
    detail = `${benefits.count} beneficio(s) — conviene reforzar propuesta de fidelización`;
  }

  return {
    status,
    detail,
    recommendations: benefits.recommendations ?? [],
    warnings: benefits.warnings ?? [],
    loyalty_quality: benefits.loyalty_quality ?? 'none',
    evaluation_summary: {
      count: benefits.count ?? 0,
      strong_count: benefits.strong_count ?? 0,
      weak_count: benefits.weak_count ?? 0,
    },
  };
}

export {
  HIGH_PADCOINS_THRESHOLD,
  SUGGESTED_INITIAL_BENEFITS,
};
