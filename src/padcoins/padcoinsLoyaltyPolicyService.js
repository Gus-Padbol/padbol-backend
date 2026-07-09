/**
 * Política de fidelización PadCoins — piso 5%, conversión global fija 100:1.
 * Uso interno admin/setup; no comunicar equivalencias monetarias al jugador.
 *
 * En esta fase la estimación de recupero/canje usa reservas como base de cálculo.
 * Otras fuentes de generación (torneos, partidos, reseñas, etc.) se agregarán después.
 */

export const PADCOINS_MIN_LOYALTY_PERCENT = 5;

export const PADCOINS_GLOBAL_CONVERSION_RATE = 100;

/** Clasificación orientativa según reservas estimadas (base: acreditación por reserva). */
export const BENEFIT_REACHABILITY = Object.freeze({
  MUY_FACIL: 'muy_facil',
  BUENA: 'buena',
  ASPIRACIONAL: 'aspiracional',
  DEMASIADO_LEJANO: 'demasiado_lejano',
});

/** Más de este umbral → demasiado lejano / alerta de bajo impacto. */
export const BENEFIT_MAX_ESTIMATED_RESERVATIONS = 20;

const CALCULATOR_EXAMPLE_TEMPLATES = [
  {
    benefit: 'Bebida post partido',
    reference_value: 2,
  },
  {
    benefit: 'Descuento próximo turno',
    reference_value: 5,
  },
  {
    benefit: 'Balón Padbol',
    reference_value: 25,
  },
];

function buildHttpError(message, status = 400) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function parsePositiveNumber(raw) {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function normalizeLoyaltyPercent(raw, fallback = PADCOINS_MIN_LOYALTY_PERCENT) {
  const parsed = Number.parseInt(String(raw ?? '').trim(), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(PADCOINS_MIN_LOYALTY_PERCENT, parsed);
}

/**
 * Clasificación orientativa de alcanzabilidad (estimación por reservas en esta fase).
 * 1 → muy fácil; 2–8 → buena; 9–20 → aspiracional; >20 → demasiado lejano.
 */
export function classifyBenefitReachability(reservasAproximadas) {
  const n = Number(reservasAproximadas);
  if (!Number.isFinite(n) || n < 1) return null;
  if (n === 1) return BENEFIT_REACHABILITY.MUY_FACIL;
  if (n <= 8) return BENEFIT_REACHABILITY.BUENA;
  if (n <= BENEFIT_MAX_ESTIMATED_RESERVATIONS) return BENEFIT_REACHABILITY.ASPIRACIONAL;
  return BENEFIT_REACHABILITY.DEMASIADO_LEJANO;
}

/**
 * Calculadora orientativa para valorizar beneficios (admin/setup).
 */
export function calculateBenefitLoyaltyMetrics({
  valor_referencia_beneficio,
  precio_turno,
  porcentaje_fidelizacion,
} = {}) {
  const referenceValue = parsePositiveNumber(valor_referencia_beneficio);
  const turnPrice = parsePositiveNumber(precio_turno);
  const loyaltyPercent = normalizeLoyaltyPercent(porcentaje_fidelizacion);

  if (referenceValue == null || turnPrice == null) {
    return {
      padcoins_necesarios: null,
      padcoins_por_reserva: null,
      reservas_aproximadas: null,
      reachability: null,
      loyalty_percentage: loyaltyPercent,
      conversion_rate: PADCOINS_GLOBAL_CONVERSION_RATE,
      valid: false,
    };
  }

  const padcoins_necesarios = Math.round(referenceValue * PADCOINS_GLOBAL_CONVERSION_RATE);
  const padcoins_por_reserva = Math.round(
    (turnPrice * loyaltyPercent / 100) * PADCOINS_GLOBAL_CONVERSION_RATE,
  );
  const reservas_aproximadas = padcoins_por_reserva > 0
    ? Math.ceil(padcoins_necesarios / padcoins_por_reserva)
    : null;
  const reachability = classifyBenefitReachability(reservas_aproximadas);

  return {
    padcoins_necesarios,
    padcoins_por_reserva,
    reservas_aproximadas,
    reachability,
    loyalty_percentage: loyaltyPercent,
    conversion_rate: PADCOINS_GLOBAL_CONVERSION_RATE,
    valid: true,
  };
}

export function buildCalculatorExamples({
  turn_price,
  loyalty_percentage,
} = {}) {
  const turnPrice = parsePositiveNumber(turn_price);
  const loyaltyPercent = normalizeLoyaltyPercent(loyalty_percentage);

  if (turnPrice == null) return [];

  return CALCULATOR_EXAMPLE_TEMPLATES.map((template) => {
    const metrics = calculateBenefitLoyaltyMetrics({
      valor_referencia_beneficio: template.reference_value,
      precio_turno: turnPrice,
      porcentaje_fidelizacion: loyaltyPercent,
    });

    return {
      benefit: template.benefit,
      reference_value: template.reference_value,
      required_padcoins: metrics.padcoins_necesarios,
      turn_price: turnPrice,
      loyalty_percentage: metrics.loyalty_percentage,
      padcoins_per_reservation: metrics.padcoins_por_reserva,
      estimated_reservations: metrics.reservas_aproximadas,
      reachability: metrics.reachability,
    };
  });
}

export function isValidLoyaltyPercentageForActivePadcoins(percent) {
  const parsed = Number.parseInt(String(percent ?? '').trim(), 10);
  if (!Number.isFinite(parsed)) return false;
  return parsed >= PADCOINS_MIN_LOYALTY_PERCENT;
}

/**
 * Validación post-normalize al escribir rule_overrides de sede.
 */
export function enforcePadcoinsSedeRuleOverridesPolicy(validated, {
  padcoinsActive = false,
} = {}) {
  if (!validated || typeof validated !== 'object') return validated;

  if (Object.prototype.hasOwnProperty.call(validated, 'padcoins_por_usd_equivalente')) {
    throw buildHttpError(
      'La conversión global de PadCoins (100 por unidad interna) no puede modificarse por sede',
    );
  }

  if (Object.prototype.hasOwnProperty.call(validated, 'porcentaje_devolucion_reserva')) {
    const pct = Number(validated.porcentaje_devolucion_reserva);
    if (!Number.isFinite(pct) || pct < PADCOINS_MIN_LOYALTY_PERCENT) {
      const suffix = padcoinsActive
        ? ' con PadCoins activo'
        : '';
      throw buildHttpError(
        `El porcentaje mínimo de fidelización${suffix} es ${PADCOINS_MIN_LOYALTY_PERCENT}%`,
      );
    }
  }

  return validated;
}

export function inferBenefitReferenceValue(premio) {
  if (premio?.valor_referencia_interno != null) {
    const explicit = parsePositiveNumber(premio.valor_referencia_interno);
    if (explicit != null) return { value: explicit, source: 'valor_referencia_interno' };
  }

  const costo = Number(premio?.costo_padcoins);
  if (Number.isFinite(costo) && costo > 0) {
    return {
      value: costo / PADCOINS_GLOBAL_CONVERSION_RATE,
      source: 'costo_padcoins',
    };
  }

  return { value: null, source: null };
}

export function evaluateBenefitReservationMetrics(premio, {
  turn_price,
  loyalty_percentage,
} = {}) {
  const reference = inferBenefitReferenceValue(premio);
  const warnings = [];

  if (reference.value == null) {
    warnings.push({
      code: 'sin_valor_referencia',
      message: 'Cargá un valor de referencia local/real del beneficio para orientar el costo en PadCoins.',
      premio_id: premio?.id ?? null,
    });
    return { reference, metrics: null, reachability: null, warnings };
  }

  const metrics = calculateBenefitLoyaltyMetrics({
    valor_referencia_beneficio: reference.value,
    precio_turno: turn_price,
    porcentaje_fidelizacion: loyalty_percentage,
  });

  if (!metrics.valid) {
    warnings.push({
      code: 'calculadora_incompleta',
      message: 'Falta precio de turno de referencia para estimar reservas del beneficio (base de cálculo de esta fase).',
      premio_id: premio?.id ?? null,
    });
    return { reference, metrics, reachability: null, warnings };
  }

  const reachability = metrics.reachability;

  const costo = Number(premio?.costo_padcoins);
  if (Number.isFinite(costo) && metrics.padcoins_necesarios != null) {
    const diff = Math.abs(costo - metrics.padcoins_necesarios);
    if (diff > metrics.padcoins_necesarios * 0.25) {
      warnings.push({
        code: 'costo_desalineado_referencia',
        message: 'El costo en PadCoins no está alineado con el valor de referencia sugerido (×100).',
        premio_id: premio?.id ?? null,
      });
    }
  }

  if (reachability === BENEFIT_REACHABILITY.DEMASIADO_LEJANO) {
    warnings.push({
      code: 'reservas_aproximadas_altas',
      message: 'El beneficio exige demasiadas reservas para canjear; puede perder efecto de fidelización.',
      premio_id: premio?.id ?? null,
      estimated_reservations: metrics.reservas_aproximadas,
      reachability,
    });
  }

  if (
    reachability === BENEFIT_REACHABILITY.MUY_FACIL
    && reference.value <= 3
  ) {
    warnings.push({
      code: 'beneficio_consumo_rapido',
      message: 'El beneficio es muy accesible y puede consumirse demasiado rápido. Revisá stock y costo.',
      premio_id: premio?.id ?? null,
      estimated_reservations: metrics.reservas_aproximadas,
      reachability,
    });
  }

  return { reference, metrics, reachability, warnings };
}

export function evaluateLoyaltyPolicyForSede({
  effective_loyalty_percentage,
  padcoins_active = false,
  sede_override_conversion = false,
  sede_overrides = {},
  turn_price = null,
} = {}) {
  const warnings = [];
  const next_actions = [];
  const current = Number(effective_loyalty_percentage);

  if (padcoins_active && !isValidLoyaltyPercentageForActivePadcoins(current)) {
    warnings.push({
      code: 'porcentaje_fidelizacion_bajo_minimo',
      message: `PadCoins activo requiere al menos ${PADCOINS_MIN_LOYALTY_PERCENT}% de fidelización. Si querés menos, desactivá PadCoins.`,
    });
    next_actions.push(
      `Ajustar porcentaje de fidelización a mínimo ${PADCOINS_MIN_LOYALTY_PERCENT}% o desactivar PadCoins.`,
    );
  }

  if (
    sede_override_conversion
    || Object.prototype.hasOwnProperty.call(sede_overrides ?? {}, 'padcoins_por_usd_equivalente')
  ) {
    warnings.push({
      code: 'override_conversion_sede',
      message: 'La sede tiene override de conversión global. Debe removerse para respetar 100 PadCoins = 1 unidad interna.',
    });
    next_actions.push('Eliminar override de padcoins_por_usd_equivalente en rule_overrides de la sede.');
  }

  const loyaltyPercent = Number.isFinite(current) && current >= PADCOINS_MIN_LOYALTY_PERCENT
    ? current
    : PADCOINS_MIN_LOYALTY_PERCENT;

  return {
    minimum_loyalty_percentage: PADCOINS_MIN_LOYALTY_PERCENT,
    current_loyalty_percentage: Number.isFinite(current) ? current : null,
    conversion_rate: PADCOINS_GLOBAL_CONVERSION_RATE,
    calculator_examples: buildCalculatorExamples({
      turn_price,
      loyalty_percentage: loyaltyPercent,
    }),
    warnings,
    next_actions,
    valid: warnings.length === 0,
  };
}

export function buildLoyaltyPolicySectionFields(flags) {
  const meta = flags?.meta ?? {};
  const policy = evaluateLoyaltyPolicyForSede({
    effective_loyalty_percentage: meta.effective_porcentaje_devolucion_reserva,
    padcoins_active: flags?.padcoins_activado === true,
    sede_override_conversion: meta.sede_override_conversion === true,
    sede_overrides: meta.sede_overrides ?? {},
    turn_price: meta.precio_turno_referencia,
  });

  return {
    minimum_loyalty_percentage: policy.minimum_loyalty_percentage,
    current_loyalty_percentage: policy.current_loyalty_percentage,
    conversion_rate: policy.conversion_rate,
    calculator_examples: policy.calculator_examples,
    loyalty_policy_warnings: policy.warnings,
    loyalty_policy_next_actions: policy.next_actions,
  };
}
