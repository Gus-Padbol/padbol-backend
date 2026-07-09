import {
  PADCOINS_EARNING_ADMIN_SCOPES,
  PADCOINS_EARNING_CALCULATION_TYPES,
  PADCOINS_EARNING_CATEGORY_LABELS,
  PADCOINS_EARNING_SOURCE_CATEGORIES,
  PADCOINS_EARNING_SOURCE_STATUSES,
  PADCOINS_EARNING_SOURCES_CATALOG,
  PADCOINS_EARNING_SOURCES_SETUP_MESSAGE,
} from './padcoinsEarningSourcesConfig.js';
import {
  PADCOINS_GLOBAL_CONVERSION_RATE,
  PADCOINS_MIN_LOYALTY_PERCENT,
} from './padcoinsLoyaltyPolicyService.js';
import {
  buildPadcoinsSourceKey,
  buildMovimientoMetadata,
  PADCOINS_SOURCE_ACTIONS,
} from './padcoinsIdempotencyService.js';
import { computePadcoinsAmountForReserva } from './padcoinsReservasService.js';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function buildHttpError(message, status = 400) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function normalizeSourceKey(raw) {
  return String(raw ?? '').trim();
}

function mapSourceForResponse(source) {
  return {
    key: source.key,
    category: source.category,
    category_label: PADCOINS_EARNING_CATEGORY_LABELS[source.category] ?? source.category,
    label: source.label,
    description: source.description,
    default_enabled: source.default_enabled === true,
    calculation_type: source.calculation_type,
    default_value: source.default_value,
    editable_by_sede: source.editable_by_sede === true,
    limits: source.limits ?? null,
    requires_source_id: source.requires_source_id === true,
    status: source.status,
    admin_scope: source.admin_scope ?? PADCOINS_EARNING_ADMIN_SCOPES.SEDE,
    legacy_referencia_tipo: source.legacy_referencia_tipo ?? null,
    awardable: source.status === PADCOINS_EARNING_SOURCE_STATUSES.ACTIVE,
  };
}

export function canReadPadcoinsEarningSources(role) {
  if (!role) return false;
  if (role.rol === 'super_admin') return true;
  if (role.rol === 'admin_club') return role.sede_id != null;
  return false;
}

export function filterSourcesForAdminRole(sources, role) {
  if (!role) return [];
  if (role.rol === 'super_admin') return sources;

  if (role.rol === 'admin_club') {
    return sources.filter(
      (source) => source.admin_scope === PADCOINS_EARNING_ADMIN_SCOPES.SEDE,
    );
  }

  return [];
}

export function getPadcoinsEarningSources() {
  return PADCOINS_EARNING_SOURCES_CATALOG.map((source) => ({ ...source }));
}

export function getPadcoinsEarningSourceByKey(key) {
  const normalized = normalizeSourceKey(key);
  const source = PADCOINS_EARNING_SOURCES_CATALOG.find((item) => item.key === normalized);
  return source ? { ...source } : null;
}

export function validateEarningSourcePayload({
  sourceKey,
  userId,
  sedeId = null,
  sourceId = null,
  action = PADCOINS_SOURCE_ACTIONS.EARN,
} = {}) {
  const errors = [];
  const source = getPadcoinsEarningSourceByKey(sourceKey);

  if (!source) {
    errors.push({ field: 'sourceKey', message: 'Fuente de generación desconocida' });
    return { valid: false, errors, source: null };
  }

  if (!userId || !UUID_REGEX.test(String(userId))) {
    errors.push({ field: 'userId', message: 'user_id inválido' });
  }

  if (source.requires_source_id && (sourceId == null || String(sourceId).trim() === '')) {
    errors.push({ field: 'sourceId', message: 'source_id requerido para esta fuente' });
  }

  if (
    source.admin_scope === PADCOINS_EARNING_ADMIN_SCOPES.SEDE
    && (sedeId == null || !Number.isFinite(Number(sedeId)) || Number(sedeId) <= 0)
  ) {
    errors.push({ field: 'sedeId', message: 'sede_id requerido para esta fuente' });
  }

  if (!action || !String(action).trim()) {
    errors.push({ field: 'action', message: 'action requerida' });
  }

  return {
    valid: errors.length === 0,
    errors,
    source,
  };
}

export function canSourceBeAwarded(sourceKey, { allowPlanned = false } = {}) {
  const source = getPadcoinsEarningSourceByKey(sourceKey);
  if (!source) {
    return { awardable: false, reason: 'source_unknown', source: null };
  }

  if (source.status === PADCOINS_EARNING_SOURCE_STATUSES.ACTIVE) {
    return { awardable: true, reason: null, source };
  }

  if (allowPlanned && source.status === PADCOINS_EARNING_SOURCE_STATUSES.PLANNED) {
    return { awardable: false, reason: 'source_planned_not_implemented', source };
  }

  if (source.status === PADCOINS_EARNING_SOURCE_STATUSES.PLANNED) {
    return { awardable: false, reason: 'source_planned', source };
  }

  return { awardable: false, reason: 'source_future', source };
}

export function buildSourceMetadata({
  sourceKey,
  userId,
  sedeId = null,
  sourceId = null,
  action = PADCOINS_SOURCE_ACTIONS.EARN,
  calculationDetail = null,
  campaignId = null,
  legacyReferenciaTipo = null,
} = {}) {
  const source = getPadcoinsEarningSourceByKey(sourceKey);
  const sourceType = legacyReferenciaTipo ?? source?.legacy_referencia_tipo ?? sourceKey;

  const source_key = buildPadcoinsSourceKey({
    userId,
    sourceType: sourceKey,
    sourceId: sourceId ?? userId,
    action,
  });

  const metadata = buildMovimientoMetadata({
    sourceType,
    sourceId,
    action,
    campaignId,
    calculationDetail,
    sourceKey: source_key,
  }) ?? {};

  metadata.earning_source_key = sourceKey;
  if (sedeId != null) metadata.sede_id = Number(sedeId);
  metadata.conversion_rate = PADCOINS_GLOBAL_CONVERSION_RATE;

  return metadata;
}

/**
 * Calcula PadCoins orientativos para una fuente. No acredita en ledger.
 */
export function calculatePadcoinsForSource({
  sourceKey,
  userId,
  sedeId = null,
  sourceId = null,
  context = {},
} = {}) {
  const validation = validateEarningSourcePayload({
    sourceKey,
    userId,
    sedeId,
    sourceId,
  });

  if (!validation.valid) {
    return {
      ok: false,
      padcoins: null,
      errors: validation.errors,
      metadata: null,
    };
  }

  const awardCheck = canSourceBeAwarded(sourceKey);
  const source = validation.source;

  if (!awardCheck.awardable && sourceKey !== 'reserva_jugada') {
    return {
      ok: false,
      padcoins: null,
      awardable: false,
      reason: awardCheck.reason,
      status: source.status,
      metadata: buildSourceMetadata({
        sourceKey,
        userId,
        sedeId,
        sourceId,
        calculationDetail: { reason: awardCheck.reason },
        legacyReferenciaTipo: source.legacy_referencia_tipo,
      }),
    };
  }

  let padcoins = null;
  const calculationDetail = {
    source_key: sourceKey,
    calculation_type: source.calculation_type,
    conversion_rate: PADCOINS_GLOBAL_CONVERSION_RATE,
  };

  if (sourceKey === 'reserva_jugada') {
    const reservationConfig = context.reservationConfig ?? {};
    const loyaltyPct = Math.max(
      PADCOINS_MIN_LOYALTY_PERCENT,
      Number(reservationConfig.porcentaje_devolucion_reserva ?? PADCOINS_MIN_LOYALTY_PERCENT),
    );

    const amountResult = context.amountResult
      ?? computePadcoinsAmountForReserva(context.reserva ?? {}, {
        configMap: {
          reserva_confirmada: reservationConfig.reserva_confirmada_fallback,
          porcentaje_devolucion_reserva: loyaltyPct,
          padcoins_por_usd_equivalente: reservationConfig.padcoins_por_usd_equivalente
            ?? PADCOINS_GLOBAL_CONVERSION_RATE,
        },
        configTextMap: {
          modo_calculo_reserva: reservationConfig.modo_calculo_reserva,
        },
        fallbackFixed: reservationConfig.reserva_confirmada_fallback,
      });

    padcoins = Number(amountResult.padcoins);
    calculationDetail.method = amountResult.method;
    calculationDetail.loyalty_percentage = loyaltyPct;
    calculationDetail.minimum_loyalty_percentage = PADCOINS_MIN_LOYALTY_PERCENT;
    calculationDetail.amount_result = amountResult;
  } else if (source.calculation_type === PADCOINS_EARNING_CALCULATION_TYPES.FIXED_PADCOINS) {
    padcoins = Number(source.default_value);
    calculationDetail.default_value = source.default_value;
  } else if (source.calculation_type === PADCOINS_EARNING_CALCULATION_TYPES.PERCENTAGE_OF_TURN) {
    const turnPrice = Number(context.turn_price ?? context.precio_turno);
    const pct = Math.max(PADCOINS_MIN_LOYALTY_PERCENT, Number(context.loyalty_percentage ?? PADCOINS_MIN_LOYALTY_PERCENT));
    if (Number.isFinite(turnPrice) && turnPrice > 0) {
      padcoins = Math.round((turnPrice * pct / 100) * PADCOINS_GLOBAL_CONVERSION_RATE);
      calculationDetail.turn_price = turnPrice;
      calculationDetail.loyalty_percentage = pct;
    }
  } else if (source.calculation_type === PADCOINS_EARNING_CALCULATION_TYPES.PERCENTAGE_OF_ORDER) {
    const orderTotal = Number(context.order_total);
    const pct = Number(source.default_value ?? 5);
    if (Number.isFinite(orderTotal) && orderTotal > 0) {
      padcoins = Math.round(orderTotal * pct / 100 * PADCOINS_GLOBAL_CONVERSION_RATE);
      calculationDetail.order_total = orderTotal;
      calculationDetail.percentage = pct;
    }
  } else if (source.calculation_type === PADCOINS_EARNING_CALCULATION_TYPES.TOURNAMENT_REWARD) {
    padcoins = Number(source.default_value);
    calculationDetail.tournament_reward = source.default_value;
  } else if (source.calculation_type === PADCOINS_EARNING_CALCULATION_TYPES.CAMPAIGN_RULE) {
    padcoins = context.final_padcoins != null ? Number(context.final_padcoins) : null;
    calculationDetail.campaign_rule = true;
  } else if (source.calculation_type === PADCOINS_EARNING_CALCULATION_TYPES.MANUAL_ADMIN_REWARD) {
    padcoins = context.amount != null ? Number(context.amount) : null;
    calculationDetail.manual = true;
  }

  const metadata = buildSourceMetadata({
    sourceKey,
    userId,
    sedeId,
    sourceId,
    calculationDetail,
    campaignId: context.campaign_id,
    legacyReferenciaTipo: source.legacy_referencia_tipo,
  });

  return {
    ok: Number.isInteger(padcoins) && padcoins > 0,
    padcoins: Number.isInteger(padcoins) && padcoins > 0 ? padcoins : null,
    awardable: awardCheck.awardable,
    reason: awardCheck.reason,
    status: source.status,
    calculation_type: source.calculation_type,
    metadata,
    calculation_detail: calculationDetail,
  };
}

/**
 * Opciones de movimiento para addPadcoins con metadata de fuente (sin acreditar).
 */
export function buildEarningMovementOptions({
  sourceKey,
  userId,
  sedeId = null,
  sourceId = null,
  action = PADCOINS_SOURCE_ACTIONS.EARN,
  calculationDetail = null,
  campaignId = null,
} = {}) {
  const source = getPadcoinsEarningSourceByKey(sourceKey);
  const legacyTipo = source?.legacy_referencia_tipo ?? sourceKey;
  const referenciaId = sourceId != null ? String(sourceId) : null;

  const metadata = buildSourceMetadata({
    sourceKey,
    userId,
    sedeId,
    sourceId: referenciaId ?? userId,
    action,
    calculationDetail,
    campaignId,
    legacyReferenciaTipo: legacyTipo,
  });

  return {
    referencia_tipo: legacyTipo,
    referencia_id: referenciaId,
    sede_id: sedeId,
    action,
    metadata,
    earning_source_key: sourceKey,
    userId,
    source_id: referenciaId,
    source_type: legacyTipo,
  };
}

export function buildPadcoinsEarningSourcesAdminResponse(role, { sedeId = null } = {}) {
  const allSources = getPadcoinsEarningSources();
  const visible = filterSourcesForAdminRole(allSources, role).map(mapSourceForResponse);

  const categories = Object.values(PADCOINS_EARNING_SOURCE_CATEGORIES).map((key) => ({
    key,
    label: PADCOINS_EARNING_CATEGORY_LABELS[key] ?? key,
    sources_count: visible.filter((s) => s.category === key).length,
  })).filter((cat) => cat.sources_count > 0);

  return {
    ok: true,
    message: PADCOINS_EARNING_SOURCES_SETUP_MESSAGE,
    sede_id: sedeId,
    role: role?.rol ?? null,
    categories,
    sources: visible,
    summary: {
      active_count: visible.filter((s) => s.status === PADCOINS_EARNING_SOURCE_STATUSES.ACTIVE).length,
      planned_count: visible.filter((s) => s.status === PADCOINS_EARNING_SOURCE_STATUSES.PLANNED).length,
      future_count: visible.filter((s) => s.status === PADCOINS_EARNING_SOURCE_STATUSES.FUTURE).length,
      total_count: visible.length,
    },
  };
}

export function buildSetupEarningSourcesFields() {
  const sources = getPadcoinsEarningSources().map(mapSourceForResponse);

  return {
    earning_sources_message: PADCOINS_EARNING_SOURCES_SETUP_MESSAGE,
    earning_sources_active: sources.filter((s) => s.status === PADCOINS_EARNING_SOURCE_STATUSES.ACTIVE),
    earning_sources_planned: sources.filter((s) => s.status === PADCOINS_EARNING_SOURCE_STATUSES.PLANNED),
    earning_sources_future: sources.filter((s) => s.status === PADCOINS_EARNING_SOURCE_STATUSES.FUTURE),
    earning_sources_summary: {
      active_count: sources.filter((s) => s.status === PADCOINS_EARNING_SOURCE_STATUSES.ACTIVE).length,
      planned_count: sources.filter((s) => s.status === PADCOINS_EARNING_SOURCE_STATUSES.PLANNED).length,
      future_count: sources.filter((s) => s.status === PADCOINS_EARNING_SOURCE_STATUSES.FUTURE).length,
    },
  };
}
