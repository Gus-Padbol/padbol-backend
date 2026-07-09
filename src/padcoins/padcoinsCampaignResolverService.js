import { calculatePadcoinsForPaidAmount } from './padcoinsGlobalConfigService.js';
import { PADCOINS_CAMPAIGN_STATUSES, PADCOINS_CAMPAIGN_TYPES, PADCOINS_CAMPAIGN_AUDIT_ACTIONS } from './padcoinsCampaignsConfig.js';
import { appendCampaignAuditLog } from './padcoinsCampaignsService.js';
import { registerPadcoinsApplication } from './padcoinsIdempotencyService.js';
import { getReservaPaidAmountInfo } from './padcoinsReservasService.js';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isMissingTable(error) {
  const message = String(error?.message ?? '').toLowerCase();
  return (
    error?.code === '42P01'
    || error?.code === 'PGRST205'
    || message.includes('does not exist')
    || message.includes('could not find the table')
  );
}

function normalizeCampaignRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    sede_id: Number(row.sede_id),
    name: row.name,
    campaign_type: row.campaign_type,
    start_at: row.start_at,
    end_at: row.end_at,
    status: row.status,
    multiplier: row.multiplier != null ? Number(row.multiplier) : null,
    loyalty_percentage_override: row.loyalty_percentage_override != null
      ? Number(row.loyalty_percentage_override)
      : null,
    fixed_padcoins: row.fixed_padcoins != null ? Number(row.fixed_padcoins) : null,
    benefit_id: row.benefit_id ?? null,
    max_total_uses: row.max_total_uses != null ? Number(row.max_total_uses) : null,
    max_uses_per_player: row.max_uses_per_player != null ? Number(row.max_uses_per_player) : null,
    high_impact: row.high_impact === true,
    segment_config: row.segment_config ?? {},
  };
}

function isCampaignInDateWindow(campaign, now = new Date()) {
  const start = new Date(campaign.start_at);
  const end = new Date(campaign.end_at);
  return start <= now && now <= end;
}

function matchesSegmentConfig(campaign, _context = {}) {
  const segment = campaign.segment_config;
  if (!segment || typeof segment !== 'object' || Object.keys(segment).length === 0) {
    return true;
  }
  // Futuro: evaluar segmentación por jugador/reserva.
  return true;
}

async function countCampaignApplications(supabaseAdmin, campaignId) {
  const { count, error } = await supabaseAdmin
    .from('padcoins_campaign_applications')
    .select('id', { count: 'exact', head: true })
    .eq('campaign_id', campaignId);

  if (error) {
    if (isMissingTable(error)) return 0;
    throw error;
  }

  return count ?? 0;
}

async function countPlayerCampaignApplications(supabaseAdmin, campaignId, userId) {
  const { count, error } = await supabaseAdmin
    .from('padcoins_campaign_applications')
    .select('id', { count: 'exact', head: true })
    .eq('campaign_id', campaignId)
    .eq('user_id', userId);

  if (error) {
    if (isMissingTable(error)) return 0;
    throw error;
  }

  return count ?? 0;
}

async function hasApplicationForReserva(supabaseAdmin, campaignId, reservaId) {
  const { data, error } = await supabaseAdmin
    .from('padcoins_campaign_applications')
    .select('id')
    .eq('campaign_id', campaignId)
    .eq('reserva_id', String(reservaId))
    .limit(1)
    .maybeSingle();

  if (error) {
    if (isMissingTable(error)) return false;
    throw error;
  }

  return Boolean(data?.id);
}

export async function isCampaignEligibleForContext(supabaseAdmin, campaign, {
  userId,
  reservaId = null,
  now = new Date(),
} = {}) {
  if (!campaign || campaign.status !== PADCOINS_CAMPAIGN_STATUSES.ACTIVE) {
    return { eligible: false, reason: 'not_active' };
  }

  if (!isCampaignInDateWindow(campaign, now)) {
    return { eligible: false, reason: 'out_of_date_window' };
  }

  if (!matchesSegmentConfig(campaign, { userId, reservaId })) {
    return { eligible: false, reason: 'segment_mismatch' };
  }

  if (campaign.max_total_uses != null) {
    const total = await countCampaignApplications(supabaseAdmin, campaign.id);
    if (total >= campaign.max_total_uses) {
      return { eligible: false, reason: 'max_total_uses_reached' };
    }
  }

  if (userId && campaign.max_uses_per_player != null) {
    const perPlayer = await countPlayerCampaignApplications(supabaseAdmin, campaign.id, userId);
    if (perPlayer >= campaign.max_uses_per_player) {
      return { eligible: false, reason: 'max_uses_per_player_reached' };
    }
  }

  if (reservaId && await hasApplicationForReserva(supabaseAdmin, campaign.id, reservaId)) {
    return { eligible: false, reason: 'already_applied_reserva' };
  }

  return { eligible: true, reason: null };
}

/**
 * Resuelve campaña activa aplicable a una reserva (una por sede, la más reciente activa).
 */
export async function resolveActiveCampaignForReserva(supabaseAdmin, {
  sedeId,
  userId,
  reservaId = null,
  now = new Date(),
} = {}) {
  const sid = Number.parseInt(String(sedeId ?? '').trim(), 10);
  if (!Number.isFinite(sid) || sid <= 0) {
    return null;
  }

  try {
    const { data, error } = await supabaseAdmin
      .from('padcoins_campaigns')
      .select('*')
      .eq('sede_id', sid)
      .eq('status', PADCOINS_CAMPAIGN_STATUSES.ACTIVE)
      .lte('start_at', now.toISOString())
      .gte('end_at', now.toISOString())
      .order('updated_at', { ascending: false })
      .limit(5);

    if (error) {
      if (isMissingTable(error)) return null;
      throw error;
    }

    for (const row of data ?? []) {
      const campaign = normalizeCampaignRow(row);
      const eligibility = await isCampaignEligibleForContext(supabaseAdmin, campaign, {
        userId,
        reservaId,
        now,
      });
      if (eligibility.eligible) {
        return campaign;
      }
    }

    return null;
  } catch {
    return null;
  }
}

async function fetchBenefitCost(supabaseAdmin, benefitId, sedeId) {
  const { data, error } = await supabaseAdmin
    .from('premios_canjeables')
    .select('id, sede_id, costo_padcoins, activo')
    .eq('id', benefitId)
    .maybeSingle();

  if (error) throw error;
  if (!data || Number(data.sede_id) !== Number(sedeId)) return null;
  if (data.activo === false) return null;
  return Number(data.costo_padcoins);
}

/**
 * Aplica campaña sobre PadCoins base (post config efectiva).
 */
export async function applyCampaignToPadcoinsEarn(supabaseAdmin, {
  basePadcoins,
  baseAmountResult,
  campaign,
  reserva,
  reservationConfig,
} = {}) {
  const base = Number(basePadcoins);
  if (!campaign || !Number.isInteger(base) || base <= 0) {
    return {
      applied: false,
      final_padcoins: base,
      base_padcoins: base,
      campaign: null,
      calculation_detail: { reason: 'sin_campana_o_base_cero' },
    };
  }

  let finalPadcoins = base;
  const detail = {
    campaign_id: campaign.id,
    campaign_type: campaign.campaign_type,
    campaign_name: campaign.name,
    base_padcoins: base,
    high_impact: campaign.high_impact === true,
  };

  if (campaign.campaign_type === PADCOINS_CAMPAIGN_TYPES.MULTIPLIER) {
    const mult = Number(campaign.multiplier);
    finalPadcoins = Math.round(base * mult);
    detail.multiplier = mult;
  } else if (campaign.campaign_type === PADCOINS_CAMPAIGN_TYPES.PERCENTAGE_OVERRIDE) {
    const paidInfo = getReservaPaidAmountInfo(reserva);
    const pct = Number(campaign.loyalty_percentage_override);
    const calc = calculatePadcoinsForPaidAmount({
      paidAmount: paidInfo.paidAmount,
      currency: paidInfo.currency,
      configMap: {
        porcentaje_devolucion_reserva: pct,
        padcoins_por_usd_equivalente: reservationConfig?.padcoins_por_usd_equivalente,
      },
      configTextMap: {
        modo_calculo_reserva: reservationConfig?.modo_calculo_reserva,
      },
    });

    if (calc.applied && Number.isInteger(calc.padcoins) && calc.padcoins > 0) {
      finalPadcoins = calc.padcoins;
      detail.loyalty_percentage_override = pct;
      detail.proportional_calc = calc;
    } else {
      finalPadcoins = base;
      detail.fallback_to_base = true;
      detail.override_reason = calc.reason ?? 'override_no_aplicado';
    }
  } else if (campaign.campaign_type === PADCOINS_CAMPAIGN_TYPES.FIXED_PADCOINS) {
    finalPadcoins = Number(campaign.fixed_padcoins);
    detail.fixed_padcoins = finalPadcoins;
  } else if (campaign.campaign_type === PADCOINS_CAMPAIGN_TYPES.BENEFIT_EQUIVALENT) {
    const cost = await fetchBenefitCost(supabaseAdmin, campaign.benefit_id, campaign.sede_id);
    if (Number.isInteger(cost) && cost > 0) {
      finalPadcoins = cost;
      detail.benefit_id = campaign.benefit_id;
      detail.benefit_cost_padcoins = cost;
    } else {
      finalPadcoins = base;
      detail.fallback_to_base = true;
      detail.override_reason = 'benefit_no_disponible';
    }
  }

  if (!Number.isInteger(finalPadcoins) || finalPadcoins <= 0) {
    return {
      applied: false,
      final_padcoins: base,
      base_padcoins: base,
      campaign,
      calculation_detail: { ...detail, reason: 'final_invalido' },
    };
  }

  detail.final_padcoins = finalPadcoins;
  detail.bonus_padcoins = Math.max(0, finalPadcoins - base);
  detail.base_method = baseAmountResult?.method ?? null;

  return {
    applied: finalPadcoins !== base || campaign.campaign_type === PADCOINS_CAMPAIGN_TYPES.FIXED_PADCOINS,
    final_padcoins: finalPadcoins,
    base_padcoins: base,
    campaign,
    calculation_detail: detail,
  };
}

export async function recordCampaignApplication(supabaseAdmin, {
  campaign,
  sedeId,
  userId,
  reservaId,
  movimientoId,
  basePadcoins,
  finalPadcoins,
  calculationDetail,
} = {}) {
  if (!campaign?.id || !UUID_REGEX.test(String(userId))) return null;

  const payload = {
    campaign_id: campaign.id,
    sede_id: sedeId,
    user_id: userId,
    reserva_id: reservaId != null ? String(reservaId) : null,
    movimiento_id: movimientoId ?? null,
    base_padcoins: basePadcoins,
    final_padcoins: finalPadcoins,
    calculation_detail: calculationDetail ?? {},
  };

  const registered = await registerPadcoinsApplication(supabaseAdmin, async () => {
    const { data, error } = await supabaseAdmin
      .from('padcoins_campaign_applications')
      .insert(payload)
      .select('id, campaign_id, reserva_id, final_padcoins, created_at')
      .single();

    if (error) {
      if (isMissingTable(error)) return null;
      throw error;
    }

    return data;
  });

  if (registered.duplicate) {
    return { id: null, duplicate: true, campaign_id: campaign.id, reserva_id: reservaId };
  }

  if (!registered.data) return null;

  await appendCampaignAuditLog(supabaseAdmin, {
    campaign_id: campaign.id,
    sede_id: sedeId,
    action: PADCOINS_CAMPAIGN_AUDIT_ACTIONS.APPLIED,
    details: {
      reserva_id: reservaId,
      user_id: userId,
      base_padcoins: basePadcoins,
      final_padcoins: finalPadcoins,
      calculation_detail: calculationDetail,
    },
    high_impact: campaign.high_impact === true,
  }).catch(() => null);

  return registered.data;
}
